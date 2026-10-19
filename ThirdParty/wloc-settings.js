/**
 * WLOC 配置接口脚本
 *
 * 职责：拦截 https://gs-loc.apple.com/wloc-settings/save，响应本应用的
 * 查询 / 保存 / 清除请求，并把坐标持久化到客户端存储。
 *
 * 请求约定：
 *   ?action=query                查询当前保存的坐标
 *   ?action=clear                清除已保存的坐标
 *   ?lon=<WGS-84 经度>&lat=<WGS-84 纬度>&acc=<精度>&drift=<抖动半径>    保存坐标
 *
 * 响应约定（HTTP 200 + JSON）：
 *   { "success": true, "longitude": 113.0, "latitude": 22.0, "accuracy": 25, "driftRadius": 10 }
 *   { "success": false, "error": "错误说明" }
 *
 * 这个脚本必须与 wloc.js 使用同一个持久化键名，两者才能读到同一份配置。
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

const TAG = '[WLOC-SETTINGS]';
const SETTINGS_KEY = 'wloc_settings';

/**
 * 运行诊断键名，由 `wloc.js` 写入。
 *
 * 第三方模式下「规则装没装上」「脚本跑到哪一步」原本只能看客户端自己的
 * 日志，用户够不着。这里把它跟着查询响应一起回给本应用，于是应用里
 * 能直接显示「模块运行情况」，不用再靠猜。
 */
const DIAG_KEY = 'wloc_diag';

// ---------------------------------------------------------------------------
// 存储读写
// ---------------------------------------------------------------------------

// 与 wloc.js 保持同样的策略：按 API 能力探测而不是按客户端名字分派，
// 这样未列出的客户端也能正常读写同一份配置。
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

function readRaw() {
  return readRawKey(SETTINGS_KEY);
}

/** 读回 wloc.js 记录的最后一次运行结果。读不到返回 null。 */
function readDiag() {
  const raw = readRawKey(DIAG_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
}

function writeRaw(value) {
  try {
    if (typeof $prefs !== 'undefined' && typeof $prefs.setValueForKey === 'function') {
      $prefs.setValueForKey(value, SETTINGS_KEY);
      return true;
    }
  } catch (error) {
    log(`$prefs 写入失败: ${error}`);
  }

  try {
    if (typeof $persistentStore !== 'undefined'
        && typeof $persistentStore.write === 'function') {
      $persistentStore.write(value, SETTINGS_KEY);
      return true;
    }
  } catch (error) {
    log(`$persistentStore 写入失败: ${error}`);
  }

  try {
    if (typeof $rocket !== 'undefined' && $rocket.settings
        && typeof $rocket.settings.write === 'function') {
      $rocket.settings.write(SETTINGS_KEY, value);
      return true;
    }
  } catch (error) {
    log(`$rocket.settings 写入失败: ${error}`);
  }

  return false;
}

function readSettings() {
  const raw = readRaw();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    log('配置解析失败');
    return null;
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function log(message) {
  console.log(`${TAG} ${message}`);
}

/** 解析 URL 查询参数。 */
function parseQuery(url) {
  const result = {};
  const index = url.indexOf('?');
  if (index < 0) return result;

  const search = url.slice(index + 1).split('#')[0];
  for (const pair of search.split('&')) {
    if (!pair) continue;
    const [key, value = ''] = pair.split('=');
    result[decodeURIComponent(key)] = decodeURIComponent(value);
  }
  return result;
}

/** 统一的 JSON 响应。
 *
 * `env` 无条件带上：它回答的是「刚才是哪个客户端在执行这套模块」。
 * 应用侧拿它跟用户选的客户端比对——不一致就说明手机上真正在跑的是另一个
 * 代理软件，此时任何「已连接 / 未生效」都描述的是那个客户端，必须讲清楚。
 */
function respond(payload) {
  const body = JSON.stringify({ env: ENV, ...payload });
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };

  // 各客户端对「自己构造响应」要求的 $done 形状并不一致，这里必须分派：
  //
  //   Quantumult X 的 script-echo-response：官方 sample-echo-response.js 明确用
  //     顶层 status/headers/body，且 status 必须是完整的 "HTTP/1.1 200 OK" 字符串。
  //     写成 { response: { ... } } 会被 QX 当成「响应体只在 response 字段里」，
  //     回给 App 的 JSON 是空的 —— 表现就是模块装着、开关开着，App 却始终
  //     报「模块未生效」。
  //
  //   Loon / Shadowrocket / Surge / Stash / Egern：沿用 { response: { ... } }，
  //     这些客户端的脚本引擎直接支持该形状（与 wloc.js 的用法保持一致）。
  if (ENV === 'quantumultx') {
    $done({
      status: 'HTTP/1.1 200 OK',
      headers,
      body,
    });
    return;
  }

  $done({
    response: {
      status: 200,
      headers,
      body,
    },
  });
}

// ---------------------------------------------------------------------------
// 动作处理
// ---------------------------------------------------------------------------

/** 抖动半径只认这几档，与 MapLocationState.MotionDriftOption 保持一致。 */
const DRIFT_STEPS = [0, 5, 10, 20];

function normalizeDrift(value) {
  const parsed = toFiniteNumber(value);
  if (parsed === null) return 0;
  return DRIFT_STEPS.includes(parsed) ? parsed : 0;
}

function handleQuery() {
  const settings = readSettings();
  const diag = readDiag();

  if (!settings || settings.enabled !== true) {
    // 用 success:false 表示「模块在，但虚拟定位没开」，
    // 应用侧据此区分「模块未生效」和「模块已连接但未开启」。
    // 诊断信息照样带上：用户没开虚拟定位时，也要能看出模块到底跑没跑。
    respond({ success: false, error: '无已保存的坐标', diag });
    return;
  }

  respond({
    success: true,
    longitude: Number(settings.longitude),
    latitude: Number(settings.latitude),
    accuracy: Number(settings.accuracy) || 25,
    driftRadius: normalizeDrift(settings.driftRadius),
    diag,
  });
}

function handleClear() {
  const settings = readSettings();
  if (settings) {
    settings.enabled = false;
    writeRaw(JSON.stringify(settings));
  }
  log('已清除坐标');
  respond({ success: true });
}

/** 严格转数值：空串一律拒绝，避免 Number('') === 0 把缺参当成 0 度。 */
function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function handleSave(query) {
  const longitude = toFiniteNumber(query.lon);
  const latitude = toFiniteNumber(query.lat);
  const accuracy = toFiniteNumber(query.acc) || 25;
  const driftRadius = normalizeDrift(query.drift);

  if (longitude === null || latitude === null) {
    respond({ success: false, error: '经纬度参数无效' });
    return;
  }
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    respond({ success: false, error: '经纬度超出有效范围' });
    return;
  }

  const payload = {
    enabled: true,
    longitude,
    latitude,
    accuracy,
    driftRadius,
    updatedAt: Date.now(),
  };

  if (!writeRaw(JSON.stringify(payload))) {
    respond({ success: false, error: '无法写入客户端存储' });
    return;
  }

  log(`已保存坐标 ${latitude},${longitude}，抖动半径 ${driftRadius} 米`);
  // 契约要求：保存成功时回读的坐标必须与请求一致。
  respond({
    success: true,
    longitude,
    latitude,
    accuracy,
    driftRadius,
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  const url = typeof $request !== 'undefined' && $request.url ? $request.url : '';
  const query = parseQuery(url);
  const action = query.action;

  if (action === 'query') {
    handleQuery();
  } else if (action === 'clear') {
    handleClear();
  } else if (query.lon !== undefined && query.lat !== undefined) {
    handleSave(query);
  } else {
    respond({ success: false, error: '缺少必要参数' });
  }
}

main();
