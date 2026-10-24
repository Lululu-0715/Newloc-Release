/**
 * WLOC 定位响应改写脚本
 *
 * 职责：拦截 Apple 定位服务的 /clls/wloc 响应，把其中的 WiFi 热点、蜂窝基站
 * 和位置条目里的经纬度替换为配置文件里保存的目标坐标。
 *
 * 这个脚本运行在第三方代理客户端（Shadowrocket / Surge / Quantumult X /
 * Loon / Stash / Egern）的脚本引擎里，不是普通浏览器环境，因此：
 *   - 只能用各客户端共同支持的 API 子集；
 *   - 不能依赖 fetch、Promise 之外的东西；
 *   - 持久化必须走客户端的 key-value 存储。
 *
 * 坐标系：配置里保存的是 WGS-84，直接写入响应，不做转换。
 */

// ---------------------------------------------------------------------------
// 运行环境探测
// ---------------------------------------------------------------------------

const ENV = (() => {
  if (typeof $task !== 'undefined') return 'quantumultx';
  if (typeof $loon !== 'undefined') return 'loon';
  if (typeof $rocket !== 'undefined') return 'shadowrocket';
  if (typeof $environment !== 'undefined' && $environment['surge-version']) return 'surge';
  if (typeof $environment !== 'undefined' && $environment['stash-version']) return 'stash';
  if (typeof $environment !== 'undefined' && $environment['egern-version']) return 'egern';
  return 'unknown';
})();

const TAG = '[WLOC]';

/** 持久化存储键名，与 wloc-settings.js 共用。 */
const SETTINGS_KEY = 'wloc_settings';

/**
 * 运行诊断键名。
 *
 * 第三方模式下「规则装没装上」「脚本跑没跑」「跑到了哪一步」全靠客户端自己
 * 的日志，用户看不到；本应用只能通过配置接口间接读回来。每次改写都会把
 * 最后一步的结果写进这个键，`wloc-settings.js` 查询时一并返回，
 * 于是「设置 → 连接状态 → 第三方代理 → 模块运行情况」就能直接说出原因，
 * 而不是让用户对着「定位不生效」干猜。
 */
const DIAG_KEY = 'wloc_diag';

// ---------------------------------------------------------------------------
// 存储读写
// ---------------------------------------------------------------------------

// 各客户端的持久化 API 名字不同。这里按「能力探测」而非「客户端名字」来选择，
// 好处是遇到未列出的客户端（或客户端改了 API 名字）时仍能工作。
// 按优先级排列：Quantumult X 用 $prefs，其余用 $persistentStore，少数用 $rocket.settings。
function readRawKey(key) {
  try {
    if (typeof $prefs !== 'undefined' && typeof $prefs.valueForKey === 'function') {
      return $prefs.valueForKey(key);
    }
  } catch (error) {
    log(`$prefs 读取失败: ${error}`);
  }

  try {
    if (typeof $persistentStore !== 'undefined'
        && typeof $persistentStore.read === 'function') {
      return $persistentStore.read(key);
    }
  } catch (error) {
    log(`$persistentStore 读取失败: ${error}`);
  }

  try {
    if (typeof $rocket !== 'undefined' && $rocket.settings
        && typeof $rocket.settings.read === 'function') {
      return $rocket.settings.read(key);
    }
  } catch (error) {
    log(`$rocket.settings 读取失败: ${error}`);
  }

  return null;
}

/** 写一个键。写不进去时返回 false——诊断写失败不影响改写本身。 */
function writeRawKey(key, value) {
  try {
    if (typeof $prefs !== 'undefined' && typeof $prefs.setValueForKey === 'function') {
      $prefs.setValueForKey(value, key);
      return true;
    }
  } catch (error) {
    log(`$prefs 写入失败: ${error}`);
  }

  try {
    if (typeof $persistentStore !== 'undefined'
        && typeof $persistentStore.write === 'function') {
      $persistentStore.write(value, key);
      return true;
    }
  } catch (error) {
    log(`$persistentStore 写入失败: ${error}`);
  }

  try {
    if (typeof $rocket !== 'undefined' && $rocket.settings
        && typeof $rocket.settings.write === 'function') {
      $rocket.settings.write(key, value);
      return true;
    }
  } catch (error) {
    log(`$rocket.settings 写入失败: ${error}`);
  }

  return false;
}

function readRawSettings() {
  return readRawKey(SETTINGS_KEY);
}

function readSettings() {
  const raw = readRawSettings();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    // 简单校验，避免读到半截数据就往下走。
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (error) {
    log(`配置解析失败: ${error}`);
    return null;
  }
}

/**
 * 记录一次运行结果，供本应用回读。
 *
 * `outcome` 是机器可读的结论，取值固定为下面几个，应用侧据此显示中文：
 *   rewritten    改写成功
 *   disabled     模块在跑，但坐标没写入（虚拟定位没开过）
 *   bad-target   配置里的坐标非法
 *   empty-body   脚本拿不到响应体（客户端没给 body）
 *   gzip         响应是 gzip 且当前客户端不提供解压 API
 *   no-match     响应里找不到可改写的位置数据
 *   error        改写过程抛异常
 *
 * 写诊断本身失败不影响改写，所以整体包在 try 里。
 */
function recordDiag(outcome, extra) {
  try {
    const record = {
      outcome,
      ts: Date.now(),
      env: ENV,
    };
    for (const key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) {
        record[key] = extra[key];
      }
    }
    writeRawKey(DIAG_KEY, JSON.stringify(record));
  } catch (error) {
    log(`诊断写入失败: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

function log(message) {
  console.log(`${TAG} ${message}`);
}

// ---------------------------------------------------------------------------
// Protobuf 编解码
// ---------------------------------------------------------------------------

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

/** 读取一个 varint，返回值与消耗字节数。 */
function readVarint(bytes, offset) {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;

  while (cursor < bytes.length) {
    const byte = bytes[cursor];
    value |= BigInt(byte & 0x7f) << shift;
    cursor += 1;
    if ((byte & 0x80) === 0) {
      return { value, length: cursor - offset };
    }
    shift += 7n;
    if (shift > 63n) throw new Error('varint 过长');
  }
  throw new Error('varint 被截断');
}

/** 把 non-negative BigInt 编码成 varint 字节数组。 */
function writeVarint(value) {
  const out = [];
  let current = BigInt.asUintN(64, value);
  while (current >= 0x80n) {
    out.push(Number(current & 0x7fn) | 0x80);
    current >>= 7n;
  }
  out.push(Number(current));
  return out;
}

function writeTag(number, wireType) {
  return writeVarint(BigInt(number * 8 + wireType));
}

function writeLengthDelimited(number, payload) {
  return [...writeTag(number, WIRE_LENGTH_DELIMITED),
          ...writeVarint(BigInt(payload.length)),
          ...payload];
}

function writeVarintField(number, value) {
  return [...writeTag(number, WIRE_VARINT), ...writeVarint(value)];
}

/** 解析一段 protobuf 载荷，返回字段数组（保留原始字节）。 */
function decodeFields(bytes) {
  const fields = [];
  let cursor = 0;

  while (cursor < bytes.length) {
    const start = cursor;
    const tag = readVarint(bytes, cursor);
    cursor += tag.length;

    const number = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (number === 0) throw new Error('字段号为 0');

    let payload;

    if (wireType === WIRE_VARINT) {
      const item = readVarint(bytes, cursor);
      payload = bytes.slice(cursor, cursor + item.length);
      cursor += item.length;
    } else if (wireType === WIRE_FIXED64) {
      payload = bytes.slice(cursor, cursor + 8);
      cursor += 8;
    } else if (wireType === WIRE_LENGTH_DELIMITED) {
      const length = readVarint(bytes, cursor);
      cursor += length.length;
      const size = Number(length.value);
      payload = bytes.slice(cursor, cursor + size);
      cursor += size;
    } else if (wireType === WIRE_FIXED32) {
      payload = bytes.slice(cursor, cursor + 4);
      cursor += 4;
    } else {
      throw new Error(`不支持的 wire type ${wireType}`);
    }

    fields.push({
      number,
      wireType,
      value: payload,
      raw: bytes.slice(start, cursor),
    });
  }

  return fields;
}

function hasVarintField(fields, number) {
  return fields.some((field) => field.number === number && field.wireType === WIRE_VARINT);
}

/**
 * 把 source 追加到 target 尾部并返回 target（原地追加）。
 *
 * 为什么不用 `target = target.concat(source)`：`concat` 每次都会新建一个数组并把
 * 已有内容整份复制过去，累加出来的代价是 O(n²)。本脚本在一个 WiFi 热点条目上
 * 就要拼十几次，热点多的时候（商场里几十个）整个响应会从毫秒级涨到几百毫秒，
 * 而 iOS 的 locationd 对 WLOC 查询有超时 —— 一旦超时就丢弃整次响应退回缓存，
 * 表现就是「定位慢、时灵时不灵」。
 */
function pushAll(target, source) {
  for (let i = 0; i < source.length; i += 1) target.push(source[i]);
  return target;
}

// ---------------------------------------------------------------------------
// 改写逻辑
// ---------------------------------------------------------------------------

const MAC_PATTERN = /^[0-9a-fA-F]{1,2}(:[0-9a-fA-F]{1,2}){5}$/;
const MARKER_MAGIC = [0x00, 0x00, 0x00, 0x01, 0x00, 0x00];

/** 十进制度 → 定点整数（×1e8）。 */
function encodeCoordinate(degrees) {
  return BigInt(Math.round(degrees * 1e8));
}

/** 改写单条位置条目。 */
function patchLocationEntry(entry, target) {
  const fields = decodeFields(entry);
  if (!hasVarintField(fields, 1) || !hasVarintField(fields, 2)) {
    return { bytes: entry, changed: false, locations: 0 };
  }

  const lat = encodeCoordinate(target.latitude);
  const lon = encodeCoordinate(target.longitude);
  const accuracy = BigInt(target.accuracy);

  let out = [];
  let changed = false;

  for (const field of fields) {
    if (field.number === 1 && field.wireType === WIRE_VARINT) {
      const rewritten = writeVarintField(1, lat);
      if (!sameBytes(rewritten, field.raw)) changed = true;
      pushAll(out, rewritten);
    } else if (field.number === 2 && field.wireType === WIRE_VARINT) {
      const rewritten = writeVarintField(2, lon);
      if (!sameBytes(rewritten, field.raw)) changed = true;
      pushAll(out, rewritten);
    } else if (field.number === 3 && field.wireType === WIRE_VARINT) {
      const rewritten = writeVarintField(3, accuracy);
      if (!sameBytes(rewritten, field.raw)) changed = true;
      pushAll(out, rewritten);
    } else {
      pushAll(out, field.raw);
    }
  }

  return { bytes: out, changed, locations: changed ? 1 : 0 };
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 改写一个 WiFi 设备条目。 */
function patchWiFiDevice(device, target) {
  const fields = decodeFields(device);

  const isDevice = fields.some(
    (field) => field.number === 1
      && field.wireType === WIRE_LENGTH_DELIMITED
      && MAC_PATTERN.test(String.fromCharCode(...field.value))
  );
  if (!isDevice) return { bytes: device, changed: false, locations: 0 };

  let out = [];
  let changed = false;
  let locations = 0;

  for (const field of fields) {
    if (field.number === 2 && field.wireType === WIRE_LENGTH_DELIMITED) {
      const result = patchLocationEntry(field.value, target);
      if (result.changed) {
        changed = true;
        locations += result.locations;
      }
      pushAll(out, writeLengthDelimited(2, result.bytes));
    } else {
      pushAll(out, field.raw);
    }
  }

  return { bytes: out, changed, locations };
}

/** 改写一段蜂窝基站数据。 */
function patchCellSection(section, target) {
  const fields = decodeFields(section);
  let out = [];
  let changed = false;
  let locations = 0;

  for (const field of fields) {
    if (field.number === 5 && field.wireType === WIRE_LENGTH_DELIMITED) {
      const result = patchLocationEntry(field.value, target);
      if (result.changed) {
        changed = true;
        locations += result.locations;
      }
      pushAll(out, writeLengthDelimited(5, result.bytes));
    } else {
      pushAll(out, field.raw);
    }
  }

  return { bytes: out, changed, locations };
}

/** 改写 wloc 载荷本体。 */
function patchWlocPayload(payload, target) {
  const fields = decodeFields(payload);
  let out = [];
  let changed = false;
  let locations = 0;

  for (const field of fields) {
    if (field.number === 2 && field.wireType === WIRE_LENGTH_DELIMITED) {
      const result = patchWiFiDevice(field.value, target);
      if (result.changed) {
        changed = true;
        locations += result.locations;
      }
      pushAll(out, writeLengthDelimited(2, result.bytes));
    } else if ((field.number === 22 || field.number === 24)
               && field.wireType === WIRE_LENGTH_DELIMITED) {
      const result = patchCellSection(field.value, target);
      if (result.changed) {
        changed = true;
        locations += result.locations;
      }
      pushAll(out, writeLengthDelimited(field.number, result.bytes));
    } else {
      pushAll(out, field.raw);
    }
  }

  return { bytes: out, changed, locations };
}

/** 尝试按 ARPC 信封解析。
 *
 * ARPC 布局（与 `Core/wloc.go` 的 `patchARPCPayload` 一一对应）：
 *
 *   2 字节协议头
 *   3 × (uint16 大端长度 + 字符串)   通常是 host / path / 服务名
 *   4 字节 functionId
 *   4 字节 uint32 大端**载荷长度**
 *   载荷
 *   可能的尾部字节
 *
 * 为什么必须单独处理：这里是 Apple 定位服务最外层的封装，**长度前缀是
 * uint32**。如果漏掉它而靠「逐偏移量扫描」的兜底路径命中，载荷会被改写、
 * 但那个 uint32 前缀不会跟着更新 —— 只要改写后载荷长度与原长度不等
 * （精度从 65 变成 25、经纬度 varint 少一字节都会触发），系统按旧长度
 * 截取到的就是一段被截断的 protobuf，解析失败后这次定位请求被直接丢弃，
 * 表现正是「模块装着、坐标写进去了，定位却纹丝不动」。
 */
function patchARPCFrame(bytes, target) {
  if (bytes.length < 10) return null;

  let cursor = 2;
  for (let i = 0; i < 3; i += 1) {
    if (cursor + 2 > bytes.length) return null;
    const length = (bytes[cursor] << 8) | bytes[cursor + 1];
    cursor += 2;
    if (length > bytes.length - cursor) return null;
    cursor += length;
  }

  if (cursor + 8 > bytes.length) return null;

  const lengthOffset = cursor + 4;
  const payloadOffset = lengthOffset + 4;
  // 用乘法而不是 << 24：JS 的位移是 32 位有符号运算，首字节 ≥ 0x80 时会变成负数。
  const payloadLength = (bytes[lengthOffset] * 0x1000000)
    + (bytes[lengthOffset + 1] << 16)
    + (bytes[lengthOffset + 2] << 8)
    + bytes[lengthOffset + 3];

  if (payloadLength <= 0 || payloadOffset + payloadLength > bytes.length) return null;

  let result;
  try {
    result = patchWlocPayload(bytes.slice(payloadOffset, payloadOffset + payloadLength), target);
  } catch (error) {
    return null;
  }
  if (!result.changed) return null;

  const lengthBytes = [
    (result.bytes.length >>> 24) & 0xff,
    (result.bytes.length >>> 16) & 0xff,
    (result.bytes.length >>> 8) & 0xff,
    result.bytes.length & 0xff,
  ];

  return {
    bytes: [...bytes.slice(0, lengthOffset), ...lengthBytes, ...result.bytes,
            ...bytes.slice(payloadOffset + payloadLength)],
    locations: result.locations,
  };
}

/** 尝试按 marker 信封解析。
 *
 * marker 信封有两种常见布局，二者都以「uint16 大端长度 + 载荷」收尾：
 *   A. 8 字节前缀 + 长度 + 载荷   （wloccore 的 patchAtOffset 处理的是这种）
 *   B. 6 字节魔数 + 长度 + 载荷
 *
 * 因为 6 字节魔数 00 00 00 01 00 00 恰好是 8 字节前缀 00 01 00 00 00 01 00 00
 * 的后 6 字节，如果只按魔数搜索，会在偏移 2 处产生伪匹配并把载荷前两字节
 * 误读成长度（结果是 0x1201 这类超大值或 0，直接放弃改写）。
 * 因此这里显式先试 8 字节前缀，再回退到魔数搜索。
 */
function patchMarkerFrame(bytes, target) {
  // 变体 A：8 字节前缀 + uint16 长度 + 载荷。
  const prefixResult = patchAtOffset(bytes, 0, target);
  if (prefixResult) return prefixResult;

  // 变体 B：6 字节魔数 + uint16 长度 + 载荷。
  let searchFrom = 0;

  while (searchFrom <= bytes.length - MARKER_MAGIC.length) {
    let magicOffset = -1;
    outer: for (let i = searchFrom; i <= bytes.length - MARKER_MAGIC.length; i += 1) {
      for (let j = 0; j < MARKER_MAGIC.length; j += 1) {
        if (bytes[i + j] !== MARKER_MAGIC[j]) continue outer;
      }
      magicOffset = i;
      break;
    }
    if (magicOffset < 0) return null;

    const lengthOffset = magicOffset + MARKER_MAGIC.length;
    const payloadOffset = lengthOffset + 2;
    if (payloadOffset > bytes.length) return null;

    const length = (bytes[lengthOffset] << 8) | bytes[lengthOffset + 1];
    if (length <= 0 || payloadOffset + length > bytes.length) {
      searchFrom = magicOffset + 1;
      continue;
    }

    try {
      const result = patchWlocPayload(bytes.slice(payloadOffset, payloadOffset + length), target);
      if (result.changed) {
        const lengthBytes = [(result.bytes.length >> 8) & 0xff, result.bytes.length & 0xff];
        return {
          bytes: [...bytes.slice(0, lengthOffset), ...lengthBytes, ...result.bytes,
                  ...bytes.slice(payloadOffset + length)],
          locations: result.locations,
        };
      }
    } catch (error) {
      // 该候选位置不是真正的帧头，继续往后找。
    }

    searchFrom = magicOffset + 1;
  }

  return null;
}

/** 尝试按「8 字节前缀 + uint16 长度 + 载荷」解析。
 *
 * **这个函数对任意输入都不得抛异常**，原因见下方 try 的说明。
 */
function patchAtOffset(bytes, offset, target) {
  // 任意字节都可能被当成「8 字节前缀」而走进来，拿到的 length 自然也是随机的，
  // 于是 `patchWlocPayload` 十有八九会解析失败。**必须在这里就地咽掉异常**：
  // 本函数的两个调用点（`patchMarkerFrame` 的变体 A、`patchWlocBody` 的偏移扫描）
  // 都没有 try 保护，异常会一路穿到 `main()` 的 catch，被当成「改写过程出错」，
  // 于是 `$done({})` 放行原始响应 —— 后面几层兜底（魔数搜索、裸载荷）一次都跑不到。
  // 结果就是：只要某个 offset 恰好能被当成合法帧头、而载荷又不是合法 protobuf，
  // 整次改写就被放弃，表现正是「模块装着、定位纹丝不动」。
  // Go 侧对应实现（`Core/wloc.go` 的 `patchAtOffset`）返回 error 由上层跳过，
  // 不存在这个失败模式 —— 两边的契约要一致。
  try {
    if (bytes.length < offset + 10) return null;

    const length = (bytes[offset + 8] << 8) | bytes[offset + 9];
    if (length <= 0 || offset + 10 + length > bytes.length) return null;

    const result = patchWlocPayload(bytes.slice(offset + 10, offset + 10 + length), target);
    if (!result.changed) return null;

    const lengthBytes = [(result.bytes.length >> 8) & 0xff, result.bytes.length & 0xff];
    return {
      bytes: [...bytes.slice(0, offset + 8), ...lengthBytes, ...result.bytes,
              ...bytes.slice(offset + 10 + length)],
      locations: result.locations,
    };
  } catch (error) {
    // 该偏移不是真正的帧头，交给下一个候选；不是失败，不要往上抛。
    return null;
  }
}

/** 主改写入口：依次尝试各种信封格式。
 *
 * 顺序与 `Core/wloc.go` 的 `patchWlocBody` 保持一致——ARPC 是 Apple 定位
 * 服务最外层最常见的封装，必须第一个试；先命中它，长度前缀才会被正确回填。
 * 兜底路径（逐偏移量扫描）虽然也能改到载荷，但没有信封上下文，改不了长度
 * 前缀，只能作为最后手段。
 */
function patchWlocBody(bytes, target) {
  const arpc = patchARPCFrame(bytes, target);
  if (arpc) return { ...arpc, envelope: 'arpc' };

  const marker = patchMarkerFrame(bytes, target);
  if (marker) return { ...marker, envelope: 'marker' };

  // 常见偏移优先尝试，再补齐扫描范围内剩余的位置。
  const limit = Math.min(96, Math.max(0, bytes.length - 10));
  for (let offset = 0; offset <= limit; offset += 1) {
    const result = patchAtOffset(bytes, offset, target);
    if (result) return { ...result, envelope: 'length-prefix' };
  }

  const fallbackLimit = Math.min(256, bytes.length);
  for (let i = 0; i <= fallbackLimit; i += 1) {
    try {
      const result = patchWlocPayload(bytes.slice(i), target);
      if (result.changed) {
        return {
          bytes: [...bytes.slice(0, i), ...result.bytes],
          locations: result.locations,
          envelope: 'raw',
        };
      }
    } catch (error) {
      // 该偏移处解析失败是预期内的，继续尝试下一个。
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 响应体处理
// ---------------------------------------------------------------------------

/** 判断数据是否为 gzip。 */
function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * 尝试解压 gzip 响应体，返回字节数组；拿不到解压能力时返回 null。
 *
 * 为什么必须做这件事：Apple 的定位响应经常带 `Content-Encoding: gzip`。
 * 部分客户端会把 body 解压后再交给脚本，另一些直接给原始 gzip 流。
 * 旧版本遇到 gzip 直接 `$done({})` 放行——注释写着「在能解压的情况下处理」，
 * 实际一行解压代码都没有，于是**在所有这类客户端上改写都静默不发生**，
 * 表现就是「模块装着、坐标写进去了、定位纹丝不动」。
 *
 * Surge / Egern / Loon / Stash 提供 `$utils.ungzip`，能用就用；用不上时
 * 由调用方把这件事记进诊断，让用户在应用里直接看到原因。
 */
function gunzipBytes(bytes) {
  let native = null;
  try {
    if (typeof $utils !== 'undefined' && typeof $utils.ungzip === 'function') {
      const out = $utils.ungzip(toBinaryString(bytes));
      if (out) {
        native = typeof out === 'string' ? toBytes(out) : Array.from(out, (byte) => byte & 0xff);
      }
    }
  } catch (error) {
    log(`客户端解压 API 失败: ${error}`);
  }
  if (native) return native;

  // 客户端没给解压能力（Shadowrocket / Quantumult X 都没有）→ 用自己的实现。
  // 这是 2026-10-23 补的那条路：以前这里直接返回 null，于是这两个客户端上
  // 只要 Apple 用 gzip 回包，改写就整段静默跳过。
  return inflateGzipBytes(bytes);
}

// ---------------------------------------------------------------------------
// 纯 JS 解压（RFC 1952 gzip 封装 + RFC 1951 deflate）
// ---------------------------------------------------------------------------
//
// 为什么值得自己写一份：`$utils.ungzip` 只有 Surge / Egern / Loon / Stash 提供，
// **Shadowrocket 和 Quantumult X 没有**，而 Shadowrocket 恰好是默认客户端。
// 在那两个客户端上，遇到 gzip 就等于「模块装着、坐标写了、定位不动」。
//
// 只做解压，不做压缩：解压后由调用方去掉 Content-Encoding 回明文（见 main）。

/** 长度码 257~285 的基准值与额外位数。 */
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];

/** 距离码 0~29 的基准值与额外位数。 */
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/** 动态块里「码长码」的传输顺序（RFC 1951 §3.2.7）。 */
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** 解一个 gzip 容器，返回解压后的字节数组；失败返回 null。 */
function inflateGzipBytes(bytes) {
  if (!isGzip(bytes) || bytes.length < 18) return null;

  const flags = bytes[3] & 0xff;
  let offset = 10;

  if (flags & 0x04) {                       // FEXTRA
    if (offset + 2 > bytes.length) return null;
    const xlen = bytes[offset] | (bytes[offset + 1] << 8);
    offset += 2 + xlen;
  }
  if (flags & 0x08) {                       // FNAME
    while (offset < bytes.length && bytes[offset] !== 0) offset += 1;
    offset += 1;
  }
  if (flags & 0x10) {                       // FCOMMENT
    while (offset < bytes.length && bytes[offset] !== 0) offset += 1;
    offset += 1;
  }
  if (flags & 0x02) offset += 2;            // FHCRC

  if (offset >= bytes.length) return null;

  try {
    return inflateRawBytes(bytes, offset);
  } catch (error) {
    log(`内置解压失败: ${error && error.message ? error.message : error}`);
    return null;
  }
}

/** 规范 Huffman 表：`(码长:码字) → 符号`。 */
function buildHuffman(lengths) {
  let maxLen = 0;
  for (let i = 0; i < lengths.length; i += 1) {
    if (lengths[i] > maxLen) maxLen = lengths[i];
  }

  const counts = [];
  for (let len = 0; len <= maxLen; len += 1) counts.push(0);
  for (let i = 0; i < lengths.length; i += 1) {
    if (lengths[i]) counts[lengths[i]] += 1;
  }

  const nextCode = [];
  let code = 0;
  for (let len = 1; len <= maxLen; len += 1) {
    code = (code + counts[len - 1]) << 1;
    nextCode[len] = code;
  }

  const table = {};
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const len = lengths[symbol];
    if (!len) continue;
    table[`${len}:${nextCode[len]}`] = symbol;
    nextCode[len] += 1;
  }

  return { table, maxLen };
}

/** 固定 Huffman 表（块类型 1）。规范里的码长分布，交给上面同一套算法生成。 */
function fixedHuffmanTables() {
  const litLengths = [];
  for (let i = 0; i <= 287; i += 1) {
    if (i <= 143) litLengths.push(8);
    else if (i <= 255) litLengths.push(9);
    else if (i <= 279) litLengths.push(7);
    else litLengths.push(8);
  }
  const distLengths = [];
  for (let i = 0; i < 30; i += 1) distLengths.push(5);
  return { lit: buildHuffman(litLengths), dist: buildHuffman(distLengths) };
}

let fixedTables = null;

/** 解一段 raw deflate，返回字节数组；数据不合法时抛错。 */
function inflateRawBytes(bytes, start) {
  let bitPos = start * 8;
  const out = [];

  function readBit() {
    const index = bitPos >> 3;
    if (index >= bytes.length) throw new Error('数据提前结束');
    const bit = (bytes[index] >> (bitPos & 7)) & 1;
    bitPos += 1;
    return bit;
  }

  function readBits(count) {
    let value = 0;
    for (let i = 0; i < count; i += 1) value |= readBit() << i;
    return value;
  }

  function alignToByte() { bitPos = (bitPos + 7) & ~7; }

  function decodeSymbol(huffman) {
    let code = 0;
    for (let len = 1; len <= huffman.maxLen; len += 1) {
      code = (code << 1) | readBit();
      const symbol = huffman.table[`${len}:${code}`];
      if (symbol !== undefined) return symbol;
    }
    throw new Error('无效的 Huffman 编码');
  }

  for (;;) {
    const isFinal = readBits(1);
    const type = readBits(2);

    if (type === 0) {
      // 存储块：按字节对齐后直拷。
      alignToByte();
      const index = bitPos >> 3;
      if (index + 4 > bytes.length) throw new Error('存储块头部不完整');
      const length = bytes[index] | (bytes[index + 1] << 8);
      const inverse = bytes[index + 2] | (bytes[index + 3] << 8);
      if ((length ^ 0xffff) !== inverse) throw new Error('存储块长度校验失败');
      bitPos = (index + 4) * 8;
      for (let i = 0; i < length; i += 1) out.push(readBits(8));

    } else if (type === 1 || type === 2) {
      let litTable;
      let distTable;

      if (type === 1) {
        if (!fixedTables) fixedTables = fixedHuffmanTables();
        litTable = fixedTables.lit;
        distTable = fixedTables.dist;
      } else {
        const litCount = readBits(5) + 257;
        const distCount = readBits(5) + 1;
        const codeCount = readBits(4) + 4;

        const codeLengths = new Array(19).fill(0);
        for (let i = 0; i < codeCount; i += 1) {
          codeLengths[CODE_LENGTH_ORDER[i]] = readBits(3);
        }
        const codeTable = buildHuffman(codeLengths);

        const lengths = [];
        while (lengths.length < litCount + distCount) {
          const symbol = decodeSymbol(codeTable);
          if (symbol < 16) { lengths.push(symbol); continue; }

          let repeat = 0;
          let value = 0;
          if (symbol === 16) {
            if (!lengths.length) throw new Error('重复码缺少前值');
            value = lengths[lengths.length - 1];
            repeat = 3 + readBits(2);
          } else if (symbol === 17) {
            repeat = 3 + readBits(3);
          } else {
            repeat = 11 + readBits(7);
          }
          for (let i = 0; i < repeat; i += 1) lengths.push(value);
        }

        litTable = buildHuffman(lengths.slice(0, litCount));
        distTable = buildHuffman(lengths.slice(litCount, litCount + distCount));
      }

      for (;;) {
        const symbol = decodeSymbol(litTable);
        if (symbol < 256) { out.push(symbol); continue; }
        if (symbol === 256) break;

        const lengthIndex = symbol - 257;
        if (lengthIndex < 0 || lengthIndex >= LENGTH_BASE.length) {
          throw new Error('长度码越界');
        }
        const length = LENGTH_BASE[lengthIndex] + readBits(LENGTH_EXTRA[lengthIndex]);

        const distSymbol = decodeSymbol(distTable);
        if (distSymbol >= DIST_BASE.length) throw new Error('距离码越界');
        const distance = DIST_BASE[distSymbol] + readBits(DIST_EXTRA[distSymbol]);
        if (distance > out.length) throw new Error('回溯距离越界');

        for (let i = 0; i < length; i += 1) {
          out.push(out[out.length - distance]);
        }
      }

    } else {
      throw new Error('无效的块类型');
    }

    if (isFinal) break;
  }

  return out;
}

/** 把响应体转成字节数组。
 *
 * 代理客户端给到的响应体是「二进制字符串」——每个字符就是一字节，
 * 取值范围 0x00-0xFF，不是 UTF-8 文本。因此这里绝不能做 UTF-8 重编码：
 * 一旦把 0x92 这类高位字符编码成两字节，protobuf 结构立刻被破坏。
 * 只在字符码确实超出单字节范围时才退化成分字节处理。
 */
function toBytes(input) {
  if (typeof input === 'string') {
    const out = [];
    for (let i = 0; i < input.length; i += 1) {
      out.push(input.charCodeAt(i) & 0xff);
    }
    return out;
  }
  return Array.from(input, (byte) => byte & 0xff);
}

/** 字节数组转二进制字符串，供各客户端 API 使用。 */
function toBinaryString(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * 回写改写后的响应体。
 *
 * **进来什么样、出去就什么样**，这是本函数存在的全部理由。
 *
 * 客户端开没开 `binary-body-mode`，决定了 `$response.body` 是 `Uint8Array`
 * 还是一串「每字符一字节」的二进制字符串，两者必须回对应形状：
 *
 *   - 二进制模式（数组进）→ 回 `Uint8Array`。额外带一份 `ArrayBuffer` 放在
 *     `bodyBytes`：Quantumult X 的二进制重写只认这个字段，只给 `body` 会被
 *     当成文本处理。
 *   - 文本模式（字符串进）→ 回二进制字符串，与 1.0.7 及以前一致，
 *     老客户端不会因此变差。
 *
 * 早期版本一律回二进制字符串。Surge / Loon / QX 拿到字符串会按 UTF-8 重新
 * 编码，0x80 以上的字节被撑成两字节，protobuf 结构当场破坏——系统解析失败
 * 后直接丢弃这次定位，表现正是「模块装着、状态显示已连接、定位纹丝不动」，
 * 而且脚本自己报的还是「改写成功」，非常难查。
 */
function finishBody(bytes, headers, binaryIn) {
  const payload = {};

  if (binaryIn) {
    const view = Uint8Array.from(bytes);
    payload.body = view;
    payload.bodyBytes = view.buffer;
    // 同一个 buffer 挂三个字段名：各客户端取值习惯不同（Surge 认 body，
    // 部分 Quantumult X 版本认 bodyBytes，还有直接读 rawBody 的），
    // 多给一份没有代价，少给一份就是静默不改。
    payload.rawBody = view;
  } else {
    payload.body = toBinaryString(bytes);
  }

  payload.headers = buildHeaders(headers, bytes.length, binaryIn);
  // 状态码固定 200：改写后的 body 已经是完整可用的响应，沿用原来的 4xx/5xx
  // 会让系统直接丢弃它。上游脚本同样这么做。
  payload.status = 200;
  payload.statusCode = 200;

  $done(payload);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 严格转数值：null / undefined / 空串 / 非数字一律返回 null。
 *
 * 不能直接用 Number()：Number(null) === 0、Number('') === 0，
 * 会把「配置里没有坐标」误判成「坐标是 0,0」，静默把定位改到几内亚湾。
 */
function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// 运动状态模拟（原地抖动）
// ---------------------------------------------------------------------------

/** 抖动半径只认这几档，与 MapLocationState.MotionDriftOption 保持一致。 */
const DRIFT_STEPS = [0, 5, 10, 20];

/** 纬度方向 1 度对应的米数（地球平均半径估算）。 */
const METERS_PER_DEGREE_LATITUDE = 111320;

/**
 * 在同一位置附近的抖动半径内随机取一个偏移点。
 *
 * 开启后每次改写都会重新取点，系统看到的是「同一个位置附近的微小漂移」，
 * 这正是真实 GPS 的表现；死钉在一个坐标上反而容易被判定为伪造。
 * 关闭（半径 0）时原样返回。
 */
function driftTarget(target) {
  const radiusMeters = DRIFT_STEPS.includes(target.driftRadius) ? target.driftRadius : 0;
  if (radiusMeters <= 0) return target;

  // 半径按 sqrt(u) 取样，点在圆面积上才是均匀分布，否则会明显偏向圆心。
  const radius = Math.sqrt(Math.random()) * radiusMeters;
  const angle = Math.random() * 2 * Math.PI;

  const deltaLat = (radius * Math.cos(angle)) / METERS_PER_DEGREE_LATITUDE;
  const cosLat = Math.cos((target.latitude * Math.PI) / 180);

  // 极点附近 cos(lat) 趋近 0，经度差会发散，此时只抖纬度。
  if (Math.abs(cosLat) < 1e-6) {
    return { ...target, latitude: target.latitude + deltaLat };
  }

  const deltaLon = (radius * Math.sin(angle)) / (METERS_PER_DEGREE_LATITUDE * cosLat);
  return {
    ...target,
    latitude: target.latitude + deltaLat,
    longitude: target.longitude + deltaLon,
  };
}

/** 构造回传的响应头。
 *
 * 三件事必须做，缺一件都可能让「改写成功」变成「系统没用这份响应」：
 *
 * 1. **删掉 `Content-Encoding`**：解压过的 body 已经不压缩了，留着它会让
 *    客户端再去解压一段原始数据，响应直接作废。
 * 2. **删掉 `Transfer-Encoding`**：分块传输的描述对一段完整内存 buffer 没有意义。
 * 3. **按新长度重设 `Content-Length`**：改写后长度不一定与原来相等 ——
 *    精度从 200 米改成 25 米，varint 就从 2 字节变 1 字节。头里还是旧长度时，
 *    以头为准的客户端会截断或多读，系统拿到的是一段坏 protobuf，
 *    解析失败后本次定位作废，而脚本这边报的仍是「改写成功」。
 *
 * **文本模式不重设长度**：那时 body 是二进制字符串，客户端会按 UTF-8 重新
 * 编码，0x80 以上的字节撑成两字节，真实字节数已经无法在这里算准，
 * 写一个错的长度比不写更糟，交给客户端自己算。
 */
function buildHeaders(headers, byteLength, binaryIn) {
  const out = {};
  if (headers && typeof headers === 'object') {
    for (const key in headers) {
      if (!Object.prototype.hasOwnProperty.call(headers, key)) continue;
      const lower = String(key).toLowerCase();
      if (lower === 'content-encoding' || lower === 'content-length'
          || lower === 'transfer-encoding') {
        continue;
      }
      out[key] = headers[key];
    }
  }
  if (binaryIn) out['Content-Length'] = String(byteLength);
  return out;
}

function main() {
  const settings = readSettings();
  if (!settings || settings.enabled !== true) {
    recordDiag('disabled');
    log('未启用虚拟定位，放行原始响应');
    $done({});
    return;
  }

  const target = {
    latitude: toFiniteNumber(settings.latitude),
    longitude: toFiniteNumber(settings.longitude),
    accuracy: toFiniteNumber(settings.accuracy) || 25,
    driftRadius: toFiniteNumber(settings.driftRadius) || 0,
  };

  if (target.latitude === null || target.longitude === null) {
    recordDiag('bad-target');
    log('配置中的坐标无效，放行原始响应');
    $done({});
    return;
  }

  const rawBody = typeof $response !== 'undefined' ? $response.body : undefined;
  if (!rawBody) {
    recordDiag('empty-body');
    log('响应体为空，放行');
    $done({});
    return;
  }

  // 客户端开了 binary-body-mode 时给的是 Uint8Array / ArrayBuffer，
  // 没开时给的是二进制字符串。回包形状必须跟着它走，见 finishBody。
  const binaryBody = typeof rawBody !== 'string';

  let bodyBytes = toBytes(rawBody);

  // 响应体可能是 gzip 压缩的，先尝试解压；解不开仍然放行，
  // 但把原因写进诊断，用户在应用里能看到「响应是 gzip，客户端未解压」。
  let wasGzip = false;
  if (isGzip(bodyBytes)) {
    const unzipped = gunzipBytes(bodyBytes);
    if (!unzipped) {
      recordDiag('gzip', { in: bodyBytes.length });
      log('响应体为 gzip 压缩，当前客户端未提供解压 API，放行');
      $done({});
      return;
    }
    wasGzip = true;
    bodyBytes = unzipped;
  }

  // 抖动只取一次：既要用于改写，也要原样上报给应用。
  //
  // 上报坐标（lat/lon）是 2026-10-24 加的：应用拿它跟本轮目标比对，
  // 才能分辨「这次改写确实是为当前目标做的」还是「脚本还停在上一处」。
  // 以前诊断里只有条数和信封，应用无法判断改的是哪个点。
  const applied = driftTarget(target);

  try {
    const result = patchWlocBody(bodyBytes, applied);
    if (!result) {
      recordDiag('no-match', { in: bodyBytes.length });
      log('未找到可改写的位置数据，放行原始响应');
      $done({});
      return;
    }

    recordDiag('rewritten', {
      lat: applied.latitude,
      lon: applied.longitude,
      locations: result.locations,
      envelope: result.envelope,
      gzip: wasGzip,
      binary: binaryBody,
      in: bodyBytes.length,
      out: result.bytes.length,
    });
    log(`改写成功，信封 ${result.envelope}，位置条目 ${result.locations} 个，`
      + `回包形状 ${binaryBody ? '二进制' : '文本'}`);

    // headers 一律回传并重算，不再按「是否解压过」分叉：
    // 解压场景要摘掉 Content-Encoding；没解压的场景也可能因为精度 varint
    // 变短而改变长度。分叉正是「gzip 那条修好了、普通响应还在坏」的来源。
    finishBody(
      result.bytes,
      typeof $response !== 'undefined' ? $response.headers : undefined,
      binaryBody
    );
  } catch (error) {
    recordDiag('error', {
      reason: String(error && error.message ? error.message : error),
    });
    log(`改写失败: ${error && error.message ? error.message : error}`);
    $done({});
  }
}

main();
