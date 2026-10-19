/**
 * wloc.js 改写逻辑的测试。
 *
 * 脚本本身面向代理客户端的脚本引擎，没有模块导出。测试的做法是：
 *   1. 提供一个最小的全局环境桩（$done / $response / console）；
 *   2. 用 Node 直接执行脚本源码；
 *   3. 断言 $done 收到的响应体确实是改写后的结果。
 *
 * 运行：node --test ThirdParty/ProxyScripts/
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const WLOC_SOURCE = readFileSync(join(HERE, 'wloc.js'), 'utf8');
const SETTINGS_SOURCE = readFileSync(join(HERE, 'wloc-settings.js'), 'utf8');

// ---------------------------------------------------------------------------
// protobuf 测试数据构造（与 Core 侧测试保持一致的结构）
// ---------------------------------------------------------------------------

function writeVarint(value) {
  const out = [];
  let current = BigInt.asUintN(64, BigInt(value));
  while (current >= 0x80n) {
    out.push(Number(current & 0x7fn) | 0x80);
    current >>= 7n;
  }
  out.push(Number(current));
  return out;
}

function tag(number, wireType) {
  return writeVarint(BigInt(number * 8 + wireType));
}

function varintField(number, value) {
  return [...tag(number, 0), ...writeVarint(value)];
}

function lengthDelimited(number, payload) {
  return [...tag(number, 2), ...writeVarint(payload.length), ...payload];
}

function asciiBytes(text) {
  return Array.from(text, (ch) => ch.charCodeAt(0));
}

/** 构造一份 marker 信封包裹的 wloc 响应。 */
function buildSampleResponse() {
  const location = [
    ...varintField(1, 100),
    ...varintField(2, 200),
    ...varintField(3, 25),
  ];
  const device = [
    ...lengthDelimited(1, asciiBytes('aa:bb:cc:dd:ee:ff')),
    ...lengthDelimited(2, location),
  ];
  const payload = lengthDelimited(2, device);

  const magic = [0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00];
  return [
    ...magic,
    (payload.length >> 8) & 0xff,
    payload.length & 0xff,
    ...payload,
  ];
}

// ---------------------------------------------------------------------------
// 运行脚本
// ---------------------------------------------------------------------------

/**
 * 在沙箱里执行脚本，返回 $done 收到的参数。
 *
 * @param {string} source 脚本源码
 * @param {object} globals 注入的全局变量（$request、$response、$prefs 等）
 */
function runScript(source, globals) {
  let doneArg = undefined;

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    $done: (arg) => { doneArg = arg; },
    JSON,
    Math,
    Number,
    String,
    Array,
    Object,
    BigInt,
    Date,
    decodeURIComponent,
    encodeURIComponent,
    ...globals,
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { timeout: 5000 });

  return doneArg;
}

/** 二进制字符串 → 字节数组 */
function toBytes(binaryString) {
  return Array.from(binaryString, (ch) => ch.charCodeAt(0) & 0xff);
}

/** 在最外层探测给定字段号是否存在，并返回其 varint 值。 */
function findVarint(bytes, fieldNumber) {
  let cursor = 0;
  while (cursor < bytes.length) {
    // 读 tag
    let value = 0n;
    let shift = 0n;
    const tagStart = cursor;
    while (cursor < bytes.length) {
      const byte = bytes[cursor];
      value |= BigInt(byte & 0x7f) << shift;
      cursor += 1;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }
    if (cursor === tagStart) return null;

    const number = Number(value >> 3n);
    const wireType = Number(value & 7n);

    if (wireType === 0) {
      let itemValue = 0n;
      let itemShift = 0n;
      while (cursor < bytes.length) {
        const byte = bytes[cursor];
        itemValue |= BigInt(byte & 0x7f) << itemShift;
        cursor += 1;
        if ((byte & 0x80) === 0) break;
        itemShift += 7n;
      }
      if (number === fieldNumber) return itemValue;
    } else if (wireType === 2) {
      let length = 0n;
      let lengthShift = 0n;
      while (cursor < bytes.length) {
        const byte = bytes[cursor];
        length |= BigInt(byte & 0x7f) << lengthShift;
        cursor += 1;
        if ((byte & 0x80) === 0) break;
        lengthShift += 7n;
      }
      const size = Number(length);
      if (number === fieldNumber) return bytes.slice(cursor, cursor + size);
      cursor += size;
    } else if (wireType === 1) {
      cursor += 8;
    } else if (wireType === 5) {
      cursor += 4;
    } else {
      return null;
    }
  }
  return null;
}

/** 在整棵嵌套结构里递归查找字段。 */
function findVarintDeep(bytes, fieldNumber) {
  const direct = findVarint(bytes, fieldNumber);
  if (direct !== null && typeof direct === 'bigint') return direct;

  let cursor = 0;
  while (cursor < bytes.length) {
    let value = 0n;
    let shift = 0n;
    while (cursor < bytes.length) {
      const byte = bytes[cursor];
      value |= BigInt(byte & 0x7f) << shift;
      cursor += 1;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }
    const number = Number(value >> 3n);
    const wireType = Number(value & 7n);

    if (wireType === 2) {
      let length = 0n;
      let lengthShift = 0n;
      while (cursor < bytes.length) {
        const byte = bytes[cursor];
        length |= BigInt(byte & 0x7f) << lengthShift;
        cursor += 1;
        if ((byte & 0x80) === 0) break;
        lengthShift += 7n;
      }
      const size = Number(length);
      const inner = bytes.slice(cursor, cursor + size);
      cursor += size;
      const found = findVarintDeep(inner, fieldNumber);
      if (found !== null) return found;
    } else if (wireType === 0) {
      while (cursor < bytes.length) {
        const byte = bytes[cursor];
        cursor += 1;
        if ((byte & 0x80) === 0) break;
      }
    } else if (wireType === 1) {
      cursor += 8;
    } else if (wireType === 5) {
      cursor += 4;
    } else {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

/**
 * 构造一份 ARPC 信封包裹的 wloc 响应。
 *
 * ARPC 是 Apple 定位服务最外层的封装：
 *   2 字节协议头 + 3 × (uint16 前缀字符串) + functionId(4) + uint32 载荷长度 + 载荷
 *
 * 注意长度前缀是 **uint32 大端**，与 marker 信封的 uint16 不同。
 */
function buildARPCResponse({ accuracy = 65, tail = [] } = {}) {
  const location = [
    ...varintField(1, Math.round(22.54321 * 1e8)),
    ...varintField(2, Math.round(114.1747 * 1e8)),
    ...varintField(3, accuracy),
  ];
  const device = [
    ...lengthDelimited(1, asciiBytes('aa:bb:cc:dd:ee:ff')),
    ...lengthDelimited(2, location),
  ];
  const payload = lengthDelimited(2, device);

  const header = [0x01, 0x00];
  const pushString = (text) => {
    const bytes = asciiBytes(text);
    header.push((bytes.length >> 8) & 0xff, bytes.length & 0xff, ...bytes);
  };
  pushString('gsp-ssl.ls.apple.com');
  pushString('/clls/wloc');
  pushString('com.apple.gs.wloc');
  header.push(0x00, 0x00, 0x00, 0x01); // functionId
  header.push(
    (payload.length >>> 24) & 0xff,
    (payload.length >>> 16) & 0xff,
    (payload.length >>> 8) & 0xff,
    payload.length & 0xff
  );

  return { bytes: [...header, ...payload, ...tail], lengthOffset: header.length - 4 };
}

/**
 * 断言 ARPC 信封的长度前缀与实际载荷长度一致，并返回载荷。
 *
 * 这是本轮修复的核心回归点：漏掉 ARPC 分支时，载荷被逐偏移量兜底改写了，
 * 但 uint32 长度前缀还是旧值——改写后长度一变，系统按旧长度截取到的就是
 * 被截断的 protobuf，整个响应被丢弃，定位纹丝不动。
 */
function assertARPCLengthConsistent(bytes, lengthOffset, originalTailLength) {
  const declared = (bytes[lengthOffset] * 0x1000000)
    + (bytes[lengthOffset + 1] << 16)
    + (bytes[lengthOffset + 2] << 8)
    + bytes[lengthOffset + 3];
  const actual = bytes.length - (lengthOffset + 4) - originalTailLength;

  assert.strictEqual(declared, actual, 'ARPC 的 uint32 长度前缀必须等于实际载荷长度');
  return bytes.slice(lengthOffset + 4, bytes.length - originalTailLength);
}

/** 断言 $done 收到的是「不做修改」的空对象。
 *
 * 不能用 assert.deepStrictEqual(result, {})：结果对象产生在 vm 沙箱里，
 * 它的原型是沙箱自己的 Object.prototype，与宿主侧的 {} 原型不同，
 * deepStrictEqual 会因原型不等而失败。这里只比较可观察的结构。
 */
function assertPassthrough(result) {
  assert.ok(result !== undefined, '$done 必须被调用');
  assert.ok(result !== null && typeof result === 'object', '$done 参数必须是对象');
  assert.strictEqual(
    Object.keys(result).length,
    0,
    `放行时不应修改响应，实际带了字段：${Object.keys(result).join(',')}`
  );
}

test('未启用时原样放行', () => {
  const response = buildSampleResponse();
  const result = runScript(WLOC_SOURCE, {
    $response: { body: String.fromCharCode(...response) },
    $persistentStore: { read: () => null },
  });

  assertPassthrough(result);
});

test('启用后改写坐标', () => {
  const response = buildSampleResponse();
  const settings = JSON.stringify({
    enabled: true,
    latitude: 22.281508,
    longitude: 114.1747,
    accuracy: 30,
  });

  const result = runScript(WLOC_SOURCE, {
    $response: { body: String.fromCharCode(...response) },
    $persistentStore: {
      read: (key) => (key === 'wloc_settings' ? settings : null),
    },
  });

  assert.ok(result && typeof result.body === 'string', '应当返回改写后的响应体');

  const bytes = toBytes(result.body);
  const latitude = findVarintDeep(bytes, 1);
  const longitude = findVarintDeep(bytes, 2);

  assert.strictEqual(Number(latitude), Math.round(22.281508 * 1e8));
  assert.strictEqual(Number(longitude), Math.round(114.1747 * 1e8));
});

test('改写后长度前缀与实际载荷一致', () => {
  const response = buildSampleResponse();
  const settings = JSON.stringify({
    enabled: true,
    latitude: -33.86882,
    longitude: 151.20929,
    accuracy: 50,
  });

  const result = runScript(WLOC_SOURCE, {
    $response: { body: String.fromCharCode(...response) },
    $persistentStore: {
      read: (key) => (key === 'wloc_settings' ? settings : null),
    },
  });

  const bytes = toBytes(result.body);
  const declared = (bytes[8] << 8) | bytes[9];

  assert.strictEqual(
    declared,
    bytes.length - 10,
    'marker 帧的长度前缀必须等于实际载荷长度'
  );
});

test('ARPC 信封：坐标被改写且长度前缀同步回填', () => {
  const { bytes: response, lengthOffset } = buildARPCResponse({ accuracy: 65 });
  const settings = JSON.stringify({
    enabled: true,
    latitude: 22.281508,
    longitude: 114.1747,
    accuracy: 25,
  });

  const result = runScript(WLOC_SOURCE, {
    $response: { body: String.fromCharCode(...response) },
    $persistentStore: {
      read: (key) => (key === 'wloc_settings' ? settings : null),
    },
  });

  assert.ok(result && typeof result.body === 'string', '应当返回改写后的响应体');

  const patched = toBytes(result.body);
  const payload = assertARPCLengthConsistent(patched, lengthOffset, 0);

  // 载荷本身要解析得出目标坐标。
  const latitude = findVarintDeep(payload, 1);
  const longitude = findVarintDeep(payload, 2);
  assert.strictEqual(Number(latitude), Math.round(22.281508 * 1e8));
  assert.strictEqual(Number(longitude), Math.round(114.1747 * 1e8));

  // 信封头必须原样保留。
  assert.deepStrictEqual(patched.slice(0, lengthOffset), response.slice(0, lengthOffset));
});

test('ARPC 信封：载荷变短时长度前缀跟着变短', () => {
  // 原始精度 65536 占 3 字节 varint，目标 25 只占 1 字节 → 载荷缩短 2 字节。
  // 这正是「兜底路径改得到载荷、改不了长度前缀」会暴露的场景。
  const tail = [0xde, 0xad, 0xbe, 0xef];
  const { bytes: response, lengthOffset } = buildARPCResponse({ accuracy: 65536, tail });
  const settings = JSON.stringify({
    enabled: true,
    latitude: 22.281508,
    longitude: 114.1747,
    accuracy: 25,
  });

  const result = runScript(WLOC_SOURCE, {
    $response: { body: String.fromCharCode(...response) },
    $persistentStore: {
      read: (key) => (key === 'wloc_settings' ? settings : null),
    },
  });

  const patched = toBytes(result.body);
  assert.strictEqual(
    patched.length,
    response.length - 2,
    '载荷缩短 2 字节，整包也必须同步缩短 2 字节'
  );

  const payload = assertARPCLengthConsistent(patched, lengthOffset, tail.length);
  assert.deepStrictEqual(
    patched.slice(patched.length - tail.length),
    tail,
    '信封之后的尾部字节必须原样保留'
  );
  assert.strictEqual(Number(findVarintDeep(payload, 3)), 25, '精度应被改写为目标值');
});

test('ARPC 信封：未启用时原样放行', () => {
  const { bytes: response } = buildARPCResponse();
  const result = runScript(WLOC_SOURCE, {
    $response: { body: String.fromCharCode(...response) },
    $persistentStore: { read: () => null },
  });

  assertPassthrough(result);
});

test('坐标无效时放行', () => {
  const response = buildSampleResponse();
  // 注意 JSON 无法表达 NaN，序列化后会变成 null——
  // 这正是线上最容易踩的坑：Number(null) === 0，会把定位静默改到 (0, 0)。
  const settings = JSON.stringify({
    enabled: true,
    latitude: NaN,
    longitude: NaN,
    accuracy: 25,
  });

  const result = runScript(WLOC_SOURCE, {
    $response: { body: String.fromCharCode(...response) },
    $persistentStore: {
      read: (key) => (key === 'wloc_settings' ? settings : null),
    },
  });

  assertPassthrough(result);
});

test('配置里坐标缺失时不得改写成 (0,0)', () => {
  const response = buildSampleResponse();
  // 模拟「启用了但坐标字段丢失」——JSON 里是 null。
  const settings = JSON.stringify({ enabled: true, accuracy: 25 });

  const result = runScript(WLOC_SOURCE, {
    $response: { body: String.fromCharCode(...response) },
    $persistentStore: {
      read: (key) => (key === 'wloc_settings' ? settings : null),
    },
  });

  assertPassthrough(result);
});

test('经纬度为零属于合法坐标，应当改写', () => {
  const response = buildSampleResponse();
  const settings = JSON.stringify({
    enabled: true,
    latitude: 0,
    longitude: 0,
    accuracy: 25,
  });

  const result = runScript(WLOC_SOURCE, {
    $response: { body: String.fromCharCode(...response) },
    $persistentStore: {
      read: (key) => (key === 'wloc_settings' ? settings : null),
    },
  });

  assert.ok(result && typeof result.body === 'string', '0,0 是合法坐标，必须改写');
  const bytes = toBytes(result.body);
  assert.strictEqual(Number(findVarintDeep(bytes, 1)), 0);
  assert.strictEqual(Number(findVarintDeep(bytes, 2)), 0);
});

test('配置接口在启用时返回坐标', () => {
  const settings = JSON.stringify({
    enabled: true,
    latitude: 31.230416,
    longitude: 121.473701,
    accuracy: 25,
  });

  const result = runScript(SETTINGS_SOURCE, {
    $request: { url: 'https://gs-loc.apple.com/wloc-settings/save?action=query' },
    $persistentStore: {
      read: (key) => (key === 'wloc_settings' ? settings : null),
    },
  });

  assert.ok(result && result.response, '应当返回响应对象');
  const payload = JSON.parse(result.response.body);

  assert.strictEqual(payload.success, true);
  assert.strictEqual(payload.latitude, 31.230416);
  assert.strictEqual(payload.longitude, 121.473701);
});

test('配置接口在未启用时返回 success=false', () => {
  const result = runScript(SETTINGS_SOURCE, {
    $request: { url: 'https://gs-loc.apple.com/wloc-settings/save?action=query' },
    $persistentStore: { read: () => null },
  });

  const payload = JSON.parse(result.response.body);
  assert.strictEqual(payload.success, false);
  assert.ok(payload.error, '应当给出错误说明');
});

test('配置接口可以保存坐标并回读', () => {
  let stored = null;

  const result = runScript(SETTINGS_SOURCE, {
    $request: {
      url: 'https://gs-loc.apple.com/wloc-settings/save?lon=113.264435&lat=23.129163&acc=25',
    },
    $persistentStore: {
      read: () => stored,
      write: (value) => { stored = value; return true; },
    },
  });

  const payload = JSON.parse(result.response.body);
  assert.strictEqual(payload.success, true);
  assert.strictEqual(payload.latitude, 23.129163);
  assert.strictEqual(payload.longitude, 113.264435);

  // 写入的内容必须能被再次读出，否则查询与改写脚本就读不到同一份配置。
  const saved = JSON.parse(stored);
  assert.strictEqual(saved.enabled, true);
  assert.strictEqual(saved.latitude, 23.129163);
});

test('配置接口拒绝越界坐标', () => {
  const result = runScript(SETTINGS_SOURCE, {
    $request: {
      url: 'https://gs-loc.apple.com/wloc-settings/save?lon=999&lat=23.1&acc=25',
    },
    $persistentStore: { read: () => null, write: () => true },
  });

  const payload = JSON.parse(result.response.body);
  assert.strictEqual(payload.success, false);
});

test('配置接口可以清除坐标', () => {
  let stored = JSON.stringify({
    enabled: true,
    latitude: 23.129163,
    longitude: 113.264435,
    accuracy: 25,
  });

  const result = runScript(SETTINGS_SOURCE, {
    $request: { url: 'https://gs-loc.apple.com/wloc-settings/save?action=clear' },
    $persistentStore: {
      read: () => stored,
      write: (value) => { stored = value; return true; },
    },
  });

  const payload = JSON.parse(result.response.body);
  assert.strictEqual(payload.success, true);
  assert.strictEqual(JSON.parse(stored).enabled, false);
});

// ---------------------------------------------------------------------------
// 运动状态模拟（原地抖动）
// ---------------------------------------------------------------------------

test('配置接口保存并回读抖动半径', () => {
  let stored = null;

  const result = runScript(SETTINGS_SOURCE, {
    $request: {
      url: 'https://gs-loc.apple.com/wloc-settings/save'
        + '?lon=113.264435&lat=23.129163&acc=25&drift=10',
    },
    $persistentStore: {
      read: () => stored,
      write: (value) => { stored = value; return true; },
    },
  });

  const payload = JSON.parse(result.response.body);
  assert.strictEqual(payload.success, true);
  assert.strictEqual(payload.driftRadius, 10);
  assert.strictEqual(JSON.parse(stored).driftRadius, 10);
});

test('不支持的抖动半径一律归零', () => {
  let stored = null;

  runScript(SETTINGS_SOURCE, {
    $request: {
      url: 'https://gs-loc.apple.com/wloc-settings/save'
        + '?lon=113.264435&lat=23.129163&acc=25&drift=7',
    },
    $persistentStore: {
      read: () => stored,
      write: (value) => { stored = value; return true; },
    },
  });

  // 7 米不在 0/5/10/20 三档里，不能原样落盘——否则 Core 侧会拒绝这个值，
  // 界面显示的档位和实际生效的就对不上了。
  assert.strictEqual(JSON.parse(stored).driftRadius, 0);
});

test('旧配置没有抖动字段时按关闭处理', () => {
  const settings = JSON.stringify({
    enabled: true,
    latitude: 31.230416,
    longitude: 121.473701,
    accuracy: 25,
  });

  const result = runScript(SETTINGS_SOURCE, {
    $request: { url: 'https://gs-loc.apple.com/wloc-settings/save?action=query' },
    $persistentStore: {
      read: (key) => (key === 'wloc_settings' ? settings : null),
    },
  });

  assert.strictEqual(JSON.parse(result.response.body).driftRadius, 0);
});

test('开启抖动后改写结果仍在目标点附近', () => {
  const response = buildSampleResponse();
  const settings = JSON.stringify({
    enabled: true,
    latitude: 23.129163,
    longitude: 113.264435,
    accuracy: 25,
    driftRadius: 20,
  });

  const result = runScript(WLOC_SOURCE, {
    $response: { body: String.fromCharCode(...response) },
    $persistentStore: {
      read: (key) => (key === 'wloc_settings' ? settings : null),
    },
  });

  assert.ok(result && typeof result.body === 'string', '开启抖动后仍应改写');

  const bytes = toBytes(result.body);
  // 定点坐标是「度 × 1e8」，所以 20 米大约对应 20 / 111320 * 1e8 个单位。
  const unitsPerDegree = 1e8;
  const maxDelta = (20 / 111320) * unitsPerDegree * 1.5; // 留一点浮点余量

  const lat = Number(findVarintDeep(bytes, 1)) / unitsPerDegree;
  const lon = Number(findVarintDeep(bytes, 2)) / unitsPerDegree;

  assert.ok(
    Math.abs(lat - 23.129163) <= maxDelta / unitsPerDegree,
    `纬度偏移过大：${lat}`
  );
  assert.ok(
    Math.abs(lon - 113.264435) <= maxDelta / unitsPerDegree,
    `经度偏移过大：${lon}`
  );
});

test('关闭抖动时坐标与目标完全一致', () => {
  const response = buildSampleResponse();
  const settings = JSON.stringify({
    enabled: true,
    latitude: 23.129163,
    longitude: 113.264435,
    accuracy: 25,
    driftRadius: 0,
  });

  const result = runScript(WLOC_SOURCE, {
    $response: { body: String.fromCharCode(...response) },
    $persistentStore: {
      read: (key) => (key === 'wloc_settings' ? settings : null),
    },
  });

  const bytes = toBytes(result.body);
  assert.strictEqual(Number(findVarintDeep(bytes, 1)), Math.round(23.129163 * 1e8));
  assert.strictEqual(Number(findVarintDeep(bytes, 2)), Math.round(113.264435 * 1e8));
});

// ---------------------------------------------------------------------------
// 各客户端的 $done 形状
// ---------------------------------------------------------------------------

test('Quantumult X 环境下配置接口用顶层 status/headers/body 返回', () => {
  // QX 的 script-echo-response 要求顶层字段，且 status 是完整状态行。
  // 写成 { response: {...} } 会被 QX 丢弃，App 永远读不到坐标，
  // 表现就是「模块装了却一直报模块未生效」。
  const result = runScript(SETTINGS_SOURCE, {
    $task: {},
    $request: { url: 'https://gs-loc.apple.com/wloc-settings/save?action=query' },
    $prefs: {
      valueForKey: (key) => (key === 'wloc_settings'
        ? JSON.stringify({ enabled: true, latitude: 23.129163, longitude: 113.264435, accuracy: 25 })
        : null),
    },
  });

  assert.ok(result, '应当返回响应对象');
  assert.ok(!('response' in result), 'QX 下不应使用 response 包裹');
  assert.strictEqual(result.status, 'HTTP/1.1 200 OK');
  assert.ok(result.headers, '应当带 headers');

  const payload = JSON.parse(result.body);
  assert.strictEqual(payload.success, true);
  assert.strictEqual(payload.latitude, 23.129163);
});

test('非 Quantumult X 环境仍用 response 包裹', () => {
  const result = runScript(SETTINGS_SOURCE, {
    $persistentStore: {
      read: (key) => (key === 'wloc_settings'
        ? JSON.stringify({ enabled: true, latitude: 1.5, longitude: 2.5, accuracy: 25 })
        : null),
    },
    $request: { url: 'https://gs-loc.apple.com/wloc-settings/save?action=query' },
  });

  assert.ok(result && result.response, '其他客户端应当返回 { response: {...} }');
  assert.strictEqual(result.response.status, 200);
  const payload = JSON.parse(result.response.body);
  assert.strictEqual(payload.latitude, 1.5);
});

// ---------------------------------------------------------------------------
// 运行诊断
// ---------------------------------------------------------------------------

/** 带写入记录的存储桩。 */
function makeStore(initial) {
  const state = { ...initial };
  return {
    state,
    store: {
      read: (key) => (key in state ? state[key] : null),
      write: (value, key) => { state[key] = value; return true; },
    },
  };
}

test('未启用时也写下 disabled 诊断', () => {
  const { state, store } = makeStore({});

  const result = runScript(WLOC_SOURCE, {
    $response: { body: String.fromCharCode(...buildSampleResponse()) },
    $persistentStore: store,
  });

  assertPassthrough(result);
  const diag = JSON.parse(state.wloc_diag);
  assert.strictEqual(diag.outcome, 'disabled');
  assert.ok(typeof diag.ts === 'number' && diag.ts > 0, '应当带时间戳');
});

test('响应为 gzip 且无解压 API 时写 gzip 诊断', () => {
  const { state, store } = makeStore({
    wloc_settings: JSON.stringify({
      enabled: true, latitude: 22.281508, longitude: 114.1747, accuracy: 25,
    }),
  });
  // gzip 魔数开头的一段假数据：只要前两字节对，脚本就会走解压分支。
  const gzipLike = [0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04];

  const result = runScript(WLOC_SOURCE, {
    $response: { body: String.fromCharCode(...gzipLike) },
    $persistentStore: store,
  });

  // 当前沙箱没有 $utils.ungzip，应当原样放行并留下原因。
  assertPassthrough(result);
  assert.strictEqual(JSON.parse(state.wloc_diag).outcome, 'gzip');
});

test('改写成功时诊断带上信封与条目数', () => {
  const { bytes: response } = buildARPCResponse();
  const { state, store } = makeStore({
    wloc_settings: JSON.stringify({
      enabled: true, latitude: 22.281508, longitude: 114.1747, accuracy: 25,
    }),
  });

  const result = runScript(WLOC_SOURCE, {
    $response: { body: String.fromCharCode(...response) },
    $persistentStore: store,
  });

  assert.ok(result && typeof result.body === 'string');
  const diag = JSON.parse(state.wloc_diag);
  assert.strictEqual(diag.outcome, 'rewritten');
  assert.strictEqual(diag.envelope, 'arpc');
  assert.ok(diag.locations >= 1, '应当至少改写一个位置点');
});

test('配置接口把模块诊断一起返回', () => {
  const diag = JSON.stringify({ outcome: 'rewritten', ts: 1700000000000, locations: 2 });
  const result = runScript(SETTINGS_SOURCE, {
    $request: { url: 'https://gs-loc.apple.com/wloc-settings/save?action=query' },
    $persistentStore: {
      read: (key) => {
        if (key === 'wloc_settings') {
          return JSON.stringify({
            enabled: true, latitude: 22.5, longitude: 114.1, accuracy: 25,
          });
        }
        if (key === 'wloc_diag') return diag;
        return null;
      },
    },
  });

  const payload = JSON.parse(result.response.body);
  assert.strictEqual(payload.diag.outcome, 'rewritten');
  assert.strictEqual(payload.diag.locations, 2);
});

test('没有诊断记录时查询响应里 diag 为 null', () => {
  const result = runScript(SETTINGS_SOURCE, {
    $request: { url: 'https://gs-loc.apple.com/wloc-settings/save?action=query' },
    $persistentStore: {
      read: (key) => (key === 'wloc_settings'
        ? JSON.stringify({ enabled: true, latitude: 22.5, longitude: 114.1, accuracy: 25 })
        : null),
    },
  });

  const payload = JSON.parse(result.response.body);
  assert.strictEqual(payload.diag, null);
});

// ---------------------------------------------------------------------------
// 回包形状：客户端开没开 binary-body-mode，决定 $response.body 是字节数组
// 还是「每字符一字节」的二进制字符串，回错形状等于没改。
//
// 这两条是 1.0.8 修掉的老问题：早期版本一律回二进制字符串，Surge / Loon / QX
// 拿到字符串会按 UTF-8 重新编码，0x80 以上的字节被撑成两字节，protobuf 结构
// 当场破坏，系统解析失败直接丢弃这次定位——表现是「模块在跑、状态显示已连接、
// 定位纹丝不动」，而脚本自己报的还是「改写成功」。
// ---------------------------------------------------------------------------

const SETTINGS_ENABLED = JSON.stringify({
  enabled: true, latitude: 22.281508, longitude: 114.1747, accuracy: 25,
});

test('二进制模式（body 是字节数组）回 Uint8Array，并附带 bodyBytes', () => {
  const { bytes: response, lengthOffset } = buildARPCResponse();
  const { store } = makeStore({ wloc_settings: SETTINGS_ENABLED });

  const result = runScript(WLOC_SOURCE, {
    $response: { body: Uint8Array.from(response) },
    $persistentStore: store,
  });

  // 跨 realm：不能用 instanceof，用 ArrayBuffer.isView 判内部槽。
  assert.ok(ArrayBuffer.isView(result.body), 'body 应当是二进制视图');
  assert.strictEqual(result.body.length, result.bodyBytes.byteLength);

  const returned = Array.from(result.body);
  const viaBodyBytes = Array.from(new Uint8Array(result.bodyBytes));
  assert.deepStrictEqual(returned, viaBodyBytes, 'body 与 bodyBytes 必须是同一份内容');

  // 经二进制模式绕一圈回来，内容必须仍然是一份合法的 ARPC 帧。
  const payload = assertARPCLengthConsistent(returned, lengthOffset, 0);
  assert.strictEqual(Number(findVarintDeep(payload, 1)),
    Math.round(22.281508 * 1e8));
});

test('文本模式（body 是二进制字符串）仍回字符串', () => {
  const { bytes: response, lengthOffset } = buildARPCResponse();
  const { store } = makeStore({ wloc_settings: SETTINGS_ENABLED });

  const result = runScript(WLOC_SOURCE, {
    $response: { body: String.fromCharCode(...response) },
    $persistentStore: store,
  });

  assert.strictEqual(typeof result.body, 'string', '没开二进制模式就必须回字符串');
  assert.strictEqual(result.bodyBytes, undefined);

  const patched = toBytes(result.body);
  const payload = assertARPCLengthConsistent(patched, lengthOffset, 0);
  assert.strictEqual(Number(findVarintDeep(payload, 1)),
    Math.round(22.281508 * 1e8));
});

test('二进制模式下解压 gzip 后要去掉 Content-Encoding', () => {
  const { bytes: response } = buildARPCResponse();
  const gzipped = [0x1f, 0x8b, 0x08, 0x00, ...response];
  const { store } = makeStore({ wloc_settings: SETTINGS_ENABLED });

  const result = runScript(WLOC_SOURCE, {
    $response: {
      body: Uint8Array.from(gzipped),
      headers: { 'Content-Encoding': 'gzip', 'Content-Length': '999', 'X-Keep': '1' },
    },
    $persistentStore: store,
    // 客户端提供解压能力：直接回一份已解压的内容。
    $utils: { ungzip: () => String.fromCharCode(...response) },
  });

  assert.ok(ArrayBuffer.isView(result.body));
  assert.ok(result.headers, '解压过就必须回传 headers');
  assert.strictEqual(result.headers['Content-Encoding'], undefined);
  assert.strictEqual(result.headers['Content-Length'], undefined);
  assert.strictEqual(result.headers['X-Keep'], '1');
});

test('诊断里记下回包形状，便于判断是不是客户端没开二进制模式', () => {
  const { bytes: response } = buildARPCResponse();
  const { state, store } = makeStore({ wloc_settings: SETTINGS_ENABLED });

  runScript(WLOC_SOURCE, {
    $response: { body: String.fromCharCode(...response) },
    $persistentStore: store,
  });

  assert.strictEqual(JSON.parse(state.wloc_diag).binary, false);
});
