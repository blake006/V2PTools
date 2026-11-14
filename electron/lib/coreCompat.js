'use strict';

/**
 * mihomo 内核兼容层
 *
 * 起因（1.5.0）：配置里写了 `global-client-fingerprint`，mihomo 1.19.x 已移除该顶层字段。
 * 内核其实只是打印一条 level=error 提示，配置照样加载完成、端口照样监听，
 * 但旧版 briefError() 会把「日志里第一条 error」当成启动失败原因报给用户，
 * 于是界面显示一句完全误导人的英文 "The global-client-fingerprint configuration is removed…"。
 *
 * 这层做四件事：
 *  1) 生成配置前清掉已知被移除的顶层字段（同时保留 proxy 级的 client-fingerprint）
 *  2) 启动前用内核自带 `-t` 预检配置，真正的配置错误立刻报，不等 15 秒超时
 *  3) 区分「致命错误」和「非致命提示」，不再拿提示冒充失败原因
 *  4) 启动失败时给出结构化诊断：进程是否退出、端口是否监听、日志尾部、下一步建议
 *
 * 以后内核再改字段名，只需要往 DEPRECATED_TOP_LEVEL / HARMLESS_LOG 里加一条，
 * 不用在每个调用点各写一遍。
 */

const { execFile } = require('child_process');

/** 已被新版内核移除 / 不再接受的顶层字段 */
const DEPRECATED_TOP_LEVEL = new Set(['global-client-fingerprint']);

/**
 * 内核会打印 level=error 但并不影响启动的提示。
 * 这些必须过滤掉，否则失败归因永远指向它们。
 */
const HARMLESS_LOG = [
  /global-client-fingerprint.*(is removed|deprecated)/i,
  /^Geodata Loader mode/i,
  /^Geosite Matcher implementation/i,
  /^Initial configuration complete/i,
  /^Start initial (configuration|compatible provider)/i,
];

/**
 * 只有这些才算「真致命」。
 *
 * 不能把「日志里出现 level=error」等同于失败：mihomo 对废弃字段、
 * 规则集下载失败（可降级）、单个节点不可用都会打 error，但配置照样加载完、
 * 端口照样监听。1.5.0 之前正是这个等价判断把一条废弃字段提示报成了启动失败。
 *
 * 反过来也不能太宽松：真正的配置解析错误必须立刻拦住，别让用户干等 15 秒超时。
 */
const FATAL_PATTERNS = [
  /error parsing|yaml:.*error|cannot unmarshal|invalid character/i,
  /configuration file .* (is|test) (not|in)valid/i,
  /unsupported proxy type|unsupported protocol|unknown proxy type/i,
  /address already in use|bind:.*in use|listen tcp.*bind|only one usage of each socket/i,
  /proxy .* (not found|does not exist)|rule .* refers to/i,
  /failed to parse|parse config|load config.*failed/i,
  /permission denied|access is denied/i,
];

/** 常见英文错误 → 中文人话 */
const TRANSLATIONS = [
  [/global-client-fingerprint.*(is removed|deprecated)/i, '配置含内核已移除的 global-client-fingerprint（程序已自动清理）'],
  [/unsupported proxy type|unsupported protocol|unknown proxy type/i, '节点协议不被当前内核支持'],
  [/address already in use|bind:.*in use|listen tcp.*bind|only one usage of each socket/i, '本地端口被其它程序占用'],
  [/configuration file .* (is|test) (not|in)valid|error parsing|yaml:.*error|cannot unmarshal/i, '内核配置格式错误'],
  [/proxy .* not found|proxy .* does not exist/i, '规则引用了不存在的代理'],
  [/rule-providers.*(not found|failed|error)/i, '分流规则文件加载失败'],
  [/dial tcp.*(timeout|refused)|no such host/i, '节点地址无法连接（DNS 或网络不通）'],
  [/permission denied|access is denied/i, '没有权限（文件被占用或需要管理员权限）'],
];

function translate(text) {
  const s = String(text || '').trim();
  for (const [re, human] of TRANSLATIONS) {
    if (re.test(s)) return `${human}（${s.slice(0, 120)}）`;
  }
  return s;
}

/**
 * 清掉配置顶层已被内核移除的字段。
 * 只删顶层：proxy 上的 `client-fingerprint` 是新内核唯一认可的位置，必须保留。
 * @returns {{ config: object, removed: string[] }}
 */
function sanitizeConfig(cfg) {
  const out = cfg || {};
  const removed = [];
  for (const key of Object.keys(out)) {
    if (DEPRECATED_TOP_LEVEL.has(key)) {
      delete out[key];
      removed.push(key);
    }
  }
  return { config: out, removed };
}

function isHarmless(line) {
  const s = String(line || '');
  return HARMLESS_LOG.some((re) => re.test(s.replace(/^.*?msg="?/, '')));
}

/** 从内核日志里分离致命错误与非致命提示 */
function scanLog(log) {
  const lines = String(log || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const fatal = [];
  const harmless = [];
  for (const line of lines) {
    if (!/level=(error|fatal)/i.test(line)) continue;
    const m = /msg="?([^"]+)"?$/.exec(line);
    const msg = m ? m[1] : line;
    if (!isHarmless(msg) && FATAL_PATTERNS.some((re) => re.test(msg))) fatal.push(msg);
    else harmless.push(msg);
  }
  return {
    lines,
    fatal,
    harmless,
    listening: lines.filter((l) => /listening at/i.test(l)),
  };
}

/**
 * 启动前用内核自己校验配置：`mihomo -t -d <dir> -f <file>`
 * 注意：内核对某些废弃字段仍返回 exit=0，所以不能只看退出码，还要扫日志里的 error 行。
 * @returns {Promise<{ok:boolean, errors:string[], reason:string}>}
 */
function validateConfig(corePath, configPath, dataDir, timeout = 8000) {
  return new Promise((resolve) => {
    if (!corePath || !configPath) {
      resolve({ ok: false, errors: [], reason: '内核路径或配置路径为空' });
      return;
    }
    execFile(
      corePath,
      ['-t', '-d', dataDir, '-f', configPath],
      { timeout, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        const combined = `${stdout || ''}\n${stderr || ''}`;
        const scan = scanLog(combined);
        const errors = scan.fatal.map(translate);
        const warnings = scan.harmless.map(translate);
        const failedByCode = !!err && (typeof err.code === 'number' ? err.code !== 0 : true);
        const ok = !failedByCode && errors.length === 0;
        let reason = '';
        if (errors.length) reason = errors.join('；');
        else if (failedByCode) reason = translate((err && err.message) || '内核配置校验失败');
        resolve({ ok, errors, warnings, reason, raw: combined });
      }
    );
  });
}

/**
 * 生成「启动失败」的可读诊断。
 * 旧实现只挑日志里第一条 error 行 —— 一旦日志里只有一条无害提示，
 * 就会把一个跟失败毫无关系的字段改动报成故障原因。
 */
function diagnoseStart(opts = {}) {
  const { log = '', procAlive = false, exitCode = null, ctlPort = 0, mixedPort = 0, portBusy = null, timedOut = true } = opts;
  const scan = scanLog(log);
  const tail = scan.lines.slice(-3).join(' | ').slice(0, 260);
  const parts = [];

  if (scan.fatal.length) {
    parts.push(`配置/内核报错：${scan.fatal.map(translate).join('；').slice(0, 200)}`);
  } else if (!procAlive && exitCode !== null) {
    parts.push(`内核启动后立即退出（code=${exitCode}）`);
  } else if (scan.listening.length) {
    parts.push(`内核日志显示端口已监听，但 127.0.0.1:${ctlPort} 连不上（多半是安全软件/防火墙拦截了本机回环，或本机开了 TUN 把回环流量劫持了）`);
  } else if (procAlive) {
    parts.push(`内核进程仍在运行，但 ${timedOut ? '15 秒内' : ''}没有就绪（控制端口 127.0.0.1:${ctlPort} / 代理端口 ${mixedPort} 无响应）`);
  } else {
    parts.push('内核进程已退出且未留下明确错误');
  }

  if (portBusy === false) parts.push('端口未被任何程序占用');
  if (tail) parts.push(`日志：${tail}`);

  // 给一句可执行建议，别让用户对着英文报错猜
  if (scan.listening.length) {
    parts.push('建议：退出其它 VPN/TUN 工具、检查杀软对本机回环的拦截，再用「一键修复网络」复位');
  } else if (!scan.fatal.length) {
    parts.push('建议：点「关闭代理」后重新开启；仍失败请退出其它代理工具再试');
  }

  // 这条文案会直接进 toast，太长会把提示框撑爆；控制在两行内能读完的长度
  return parts.join('。').slice(0, 360);
}

/** 从日志里取一句最贴切的失败原因（供 core.js 复用） */
function briefError(log) {
  const scan = scanLog(log);
  if (scan.fatal.length) return translate(scan.fatal[0]).slice(0, 200);
  const last = scan.lines[scan.lines.length - 1] || '未知错误';
  const m = /msg="?([^"]+)"?$/.exec(last);
  return translate(m ? m[1] : last).slice(0, 200);
}

module.exports = {
  DEPRECATED_TOP_LEVEL,
  HARMLESS_LOG,
  FATAL_PATTERNS,
  sanitizeConfig,
  scanLog,
  translate,
  validateConfig,
  diagnoseStart,
  briefError,
};
