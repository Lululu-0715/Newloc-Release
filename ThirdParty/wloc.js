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
  try {
    if (typeof $utils !== 'undefined' && typeof $utils.ungzip === 'function') {
      const out = $utils.ungzip(toBinaryString(bytes));
      if (!out) return null;
      if (typeof out === 'string') return toBytes(out);
      return Array.from(out, (byte) => byte & 0xff);
    }
  } catch (error) {
    log(`gzip 解压失败: ${error}`);
  }
  return null;
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
  } else {
    payload.body = toBinaryString(bytes);
  }

  if (headers) payload.headers = headers;
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

/** 去掉与实体编码 / 长度相关的响应头。
 *
 * 解压过 body 之后这两条必须删掉：留着 `Content-Encoding: gzip` 会让
 * 客户端或系统去解压一段已经不压缩的数据，响应直接作废。
 */
function stripEntityHeaders(headers) {
  if (!headers || typeof headers !== 'object') return undefined;
  const out = {};
  for (const key in headers) {
    if (!Object.prototype.hasOwnProperty.call(headers, key)) continue;
    const lower = String(key).toLowerCase();
    if (lower === 'content-encoding' || lower === 'content-length'
        || lower === 'transfer-encoding') {
      continue;
    }
    out[key] = headers[key];
  }
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

  try {
    const result = patchWlocBody(bodyBytes, driftTarget(target));
    if (!result) {
      recordDiag('no-match', { in: bodyBytes.length });
      log('未找到可改写的位置数据，放行原始响应');
      $done({});
      return;
    }

    recordDiag('rewritten', {
      locations: result.locations,
      envelope: result.envelope,
      gzip: wasGzip,
      binary: binaryBody,
      in: bodyBytes.length,
      out: result.bytes.length,
    });
    log(`改写成功，信封 ${result.envelope}，位置条目 ${result.locations} 个，`
      + `回包形状 ${binaryBody ? '二进制' : '文本'}`);

    // 只在解压过的情况下才回传 headers——其余情况一律不动，避免引入回归。
    // 解压后 Content-Encoding / Content-Length 必须去掉，否则客户端会去解压
    // 一段已经不压缩的数据，响应直接作废。
    if (wasGzip) {
      finishBody(
        result.bytes,
        stripEntityHeaders(
          typeof $response !== 'undefined' ? $response.headers : undefined
        ),
        binaryBody
      );
      return;
    }

    finishBody(result.bytes, undefined, binaryBody);
  } catch (error) {
    recordDiag('error', {
      reason: String(error && error.message ? error.message : error),
    });
    log(`改写失败: ${error && error.message ? error.message : error}`);
    $done({});
  }
}

main();
