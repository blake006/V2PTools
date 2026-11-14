'use strict';

/**
 * 构建前自检
 *
 * 起因：连续两次出现「代码里引用了某个常量，但定义没写进去」的情况——
 * 语法检查过得去（引用是合法标识符），打包也成功，但一运行就崩。
 * 这里在打包前把关键模块真正跑一遍，跑不通就别打包。
 */

const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const results = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

// 1) 模块能加载（能抓出未定义的顶层引用）
for (const mod of ['tester', 'gateway', 'exporters', 'netcheck', 'netGuard', 'coreCompat', 'sysproxy', 'proxyAgent', 'runner', 'clash', 'parser', 'core']) {
  check('加载 electron/lib/' + mod, () => require(path.join(ROOT, 'electron', 'lib', mod)));
}

// 2) 关键函数真能跑出结果
check('生成分流规则（三种模式）', () => {
  const { Gateway } = require(path.join(ROOT, 'electron', 'lib', 'gateway'));
  const g = new Gateway({ corePath: 'x', dataDir: path.join(os.tmpdir(), 'v2p-preflight'), rulesDir: path.join(ROOT, 'assets', 'rules') });
  for (const mode of ['bypass-cn', 'proxy-list', 'global']) {
    const r = g.buildRouting(mode);
    if (!r || !Array.isArray(r.rules) || r.rules.length === 0) throw new Error(mode + ' 规则为空');
  }
});

check('sing-box 导出', () => {
  const { buildSingBox } = require(path.join(ROOT, 'electron', 'lib', 'exporters'));
  const r = buildSingBox([{ type: 'vmess', server: 'a.com', port: 443, name: 't', conf: { uuid: 'u' } }]);
  if (!r || !r.count) throw new Error('没有生成 outbound');
});

check('Clash 配置导出', () => {
  const clash = require(path.join(ROOT, 'electron', 'lib', 'clash'));
  const r = clash.buildClashYaml([{ type: 'vmess', server: 'a.com', port: 443, name: 't', conf: { uuid: 'u' } }], {});
  if (!r || !r.text || r.count < 1) throw new Error('没有生成配置');
});

check('IP 源常量已导出', () => {
  const t = require(path.join(ROOT, 'electron', 'lib', 'tester'));
  if (!Array.isArray(t.PROXY_CHECK_IP_URLS) || !t.PROXY_CHECK_IP_URLS.length) throw new Error('PROXY_CHECK_IP_URLS 缺失');
  if (!Array.isArray(t.DIRECT_CHECK_IP_URLS) || !t.DIRECT_CHECK_IP_URLS.length) throw new Error('DIRECT_CHECK_IP_URLS 缺失');
  if (!Array.isArray(t.DOMESTIC_CHECK_IP_URLS) || !t.DOMESTIC_CHECK_IP_URLS.length) throw new Error('DOMESTIC_CHECK_IP_URLS 缺失');
});

// 3) 主进程里引用的 tester 常量必须都导入（之前漏过 DOMESTIC_CHECK_IP_URLS）
check('主进程常量引用齐全', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const m = src.match(/const \{([^}]+)\} = require\('\.\/lib\/tester'\)/);
  const imported = new Set((m ? m[1] : '').split(',').map((s) => s.trim()));
  for (const key of ['PROXY_CHECK_IP_URLS', 'DIRECT_CHECK_IP_URLS', 'DOMESTIC_CHECK_IP_URLS']) {
    if (src.includes(key) && !imported.has(key)) throw new Error('main.js 引用了 ' + key + ' 但没导入');
  }
});

// 3.5) 打包资源必须覆盖内核与规则（1.3.9 漏过内核）
check('打包资源覆盖内核与规则', () => {
  const pkg = require(path.join(ROOT, 'package.json'));
  const res = (pkg.build && pkg.build.extraResources) || [];
  const froms = res.map((r) => r.from);
  for (const need of ['vendor/mihomo.exe', 'vendor/wintun.dll', 'assets/rules']) {
    if (!froms.includes(need)) throw new Error('extraResources 缺少 ' + need);
  }
  const fsx = require('fs');
  if (!fsx.existsSync(path.join(ROOT, 'vendor', 'mihomo.exe'))) throw new Error('vendor/mihomo.exe 不存在');
  if (!fsx.existsSync(path.join(ROOT, 'vendor', 'wintun.dll'))) throw new Error('vendor/wintun.dll 不存在（TUN 会报缺驱动）');
  if (!fsx.existsSync(path.join(ROOT, 'assets', 'rules', 'cn-domain.yaml'))) throw new Error('assets/rules/cn-domain.yaml 不存在');
});

// 3.6) 内核配置兼容：废弃字段必须被清掉，且「无害提示」不能被当成致命错误
check('内核配置不含已移除字段', () => {
  const { Gateway } = require(path.join(ROOT, 'electron', 'lib', 'gateway'));
  const { DEPRECATED_TOP_LEVEL } = require(path.join(ROOT, 'electron', 'lib', 'coreCompat'));
  const g = new Gateway({ corePath: 'x', dataDir: os.tmpdir(), rulesDir: '' });
  const cfg = g.buildConfig(
    { id: 'n', name: 'n', type: 'ss', server: 'a.com', port: 443, conf: { cipher: 'aes-128-gcm', password: 'p' } },
    7890,
    7891,
    { routeMode: 'global' }
  );
  for (const key of DEPRECATED_TOP_LEVEL) {
    if (Object.prototype.hasOwnProperty.call(cfg, key)) throw new Error('生成配置仍包含已移除字段 ' + key);
  }
});

check('内核错误分级：无害提示不算致命', () => {
  const { scanLog } = require(path.join(ROOT, 'electron', 'lib', 'coreCompat'));
  const log = [
    'level=error msg="The `global-client-fingerprint` configuration is removed, please set `client-fingerprint` directly on the proxy instead"',
    'level=info msg="RESTful API listening at: 127.0.0.1:7891"',
  ].join('\n');
  const r = scanLog(log);
  if (r.fatal.length) throw new Error('把无害的废弃字段提示误判成致命错误');
  if (r.harmless.length !== 1) throw new Error('无害提示没有被单独归类');
  const fatal = scanLog('level=error msg="yaml: unmarshal errors: cannot unmarshal !!str into int"');
  if (!fatal.fatal.length) throw new Error('真正的配置解析错误没被识别');
});

// 3.7) 系统代理护栏：绕过列表不能有 <-loopback>，归属标记必须存在
check('系统代理护栏常量与方法齐全', () => {
  const sp = require(path.join(ROOT, 'electron', 'lib', 'sysproxy'));
  if (/<-loopback>/i.test(sp.DEFAULT_BYPASS)) throw new Error('默认绕过列表仍含 <-loopback>（会劫持本机回环）');
  const cleaned = sp.sanitizeBypass('localhost;<-loopback>;127.*;localhost');
  if (/<-loopback>/i.test(cleaned)) throw new Error('sanitizeBypass 没清掉 <-loopback>');
  if (cleaned !== 'localhost;127.*') throw new Error('sanitizeBypass 去重 / 保留用户条目不正确：' + cleaned);
  if (!sp.OWNER_KEY) throw new Error('缺少注册表归属标记 OWNER_KEY');
  const S = sp.SystemProxy;
  for (const m of ['markOwner', 'readOwner', 'clearOwner', 'forceDirect', 'recoverIfStale']) {
    if (typeof S.prototype[m] !== 'function') throw new Error('SystemProxy 缺少方法 ' + m);
  }
});

// 3.75) 应急修复脚本必须存在且会被放进包根目录（应用打不开时也能自救）
check('独立应急修复脚本随包分发', () => {
  const fsx = require('fs');
  const cmd = path.join(ROOT, 'scripts', 'repair-network.cmd');
  if (!fsx.existsSync(cmd)) throw new Error('缺少 scripts/repair-network.cmd');
  const text = fsx.readFileSync(cmd, 'utf8');
  if (!/ProxyEnable \/t REG_DWORD \/d 0/.test(text)) throw new Error('应急脚本没有关闭系统代理开关');
  // 故意不删除别人的代理服务器地址，避免把公司/其它工具的代理一起清掉
  if (/reg delete.*\/v ProxyServer/.test(text)) throw new Error('应急脚本不应无条件删除 ProxyServer');
  const build = fsx.readFileSync(path.join(ROOT, 'scripts', 'build-win.js'), 'utf8');
  if (!build.includes("'repair-network.cmd'")) throw new Error('build-win.js 没有把应急脚本放进包里');
});

// 3.78) 切换节点/模式失败必须能回退，且主进程有断网兜底
check('切换失败回退与断网兜底接线齐全', () => {
  const fsx = require('fs');
  const gw = fsx.readFileSync(path.join(ROOT, 'electron', 'lib', 'gateway.js'), 'utf8');
  const main = fsx.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  if (!gw.includes('async restartKeepingPort(')) throw new Error('gateway 缺少失败回退重启');
  if (!gw.includes('e.rolledBack = true')) throw new Error('回退成功没有标记，上层无法区分');
  if (!main.includes('async function ensureProxySafe(')) throw new Error('主进程缺少断网兜底');
  const calls = (main.match(/ensureProxySafe\(\)/g) || []).length;
  if (calls < 2) throw new Error('proxy:switch / proxy:route 没有都接上兜底（实际 ' + calls + ' 处）');
});

// 3.8) 护栏 IPC / preload / 渲染层入口齐全（避免「主进程写了、界面没接」）
check('一键修复网络链路接线齐全', () => {
  const fsx = require('fs');
  const main = fsx.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const pre = fsx.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  const app = fsx.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  const html = fsx.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  for (const [label, hay, needles] of [
    ['主进程 IPC', main, ["'net:inspect'", "'net:repair'"]],
    ['preload', pre, ['netInspect:', 'netRepair:', 'onNetGuardNotice:']],
    ['渲染层', app, ['function repairNetwork', 'function inspectNetwork', 'menuNetRepair', 'btnRepairNetwork']],
    ['界面按钮', html, ['id="menuNetRepair"', 'id="btnRepairNetwork"', 'id="btnNetInspect"']],
  ]) {
    for (const n of needles) if (!hay.includes(n)) throw new Error(label + ' 缺少 ' + n);
  }
});

// 3.79) 订阅抓取必须带 SSRF 防护（本机/内网拦截 + 重定向逐跳校验）
check('订阅抓取 SSRF 防护存在', () => {
  const fsx = require('fs');
  const sub = fsx.readFileSync(path.join(ROOT, 'electron', 'lib', 'subscribe.js'), 'utf8');
  for (const n of ['function isBlockedHost', 'function assertSafeUrl', 'function isPrivateIPv4', 'function isPrivateIPv6']) {
    if (!sub.includes(n)) throw new Error('subscribe.js 缺少 ' + n);
  }
  // 入口、Node 路径、Electron 初始地址、重定向各一处，共 4 个真实调用点
  if (!sub.includes('assertSafeUrl(url);')) throw new Error('fetchSubscription/fetchWithNet 入口缺少校验');
  if (!sub.includes('u = assertSafeUrl(url)')) throw new Error('Node 路径 fetchUrl 缺少校验');
  if (!sub.includes('assertSafeUrl(redirectUrl)')) throw new Error('缺少重定向逐跳校验');
  if (!sub.includes("request.on('redirect'")) throw new Error('Electron 路径缺少 redirect 拦截');
});

// 3.80) 经代理的 TLS 默认必须校验证书
check('TLS 证书默认校验', () => {
  const fsx = require('fs');
  const pa = fsx.readFileSync(path.join(ROOT, 'electron', 'lib', 'proxyAgent.js'), 'utf8');
  if (!pa.includes('V2P_INSECURE_TLS')) throw new Error('proxyAgent 缺少 TLS 校验应急开关');
  if (/rejectUnauthorized\s*:\s*false/.test(pa)) throw new Error('proxyAgent 仍无条件关闭证书校验');
});

// 3.81) 内核子进程必须记录 pid 并在退出/启动时清理，避免孤儿进程
check('内核孤儿进程治理齐全', () => {
  const fsx = require('fs');
  const core = fsx.readFileSync(path.join(ROOT, 'electron', 'lib', 'core.js'), 'utf8');
  const gw = fsx.readFileSync(path.join(ROOT, 'electron', 'lib', 'gateway.js'), 'utf8');
  const main = fsx.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const pc = fsx.readFileSync(path.join(ROOT, 'electron', 'lib', 'procCleanup.js'), 'utf8');
  for (const [label, src] of [['core.js', core], ['gateway.js', gw]]) {
    if (!src.includes('writePid(')) throw new Error(label + ' 未写 pid 文件');
    if (!src.includes('cleanupStale(')) throw new Error(label + ' 未在启动时清理残留');
    if (!src.includes('removePid(')) throw new Error(label + ' 未在停止时移除 pid');
  }
  if (!pc.includes('nameMatches(')) throw new Error('procCleanup 未做进程名校验（可能误杀复用 pid 的程序）');
  if (!main.includes("process.on('exit'")) throw new Error('主进程缺少退出时杀内核的兜底');
});

// 4) 渲染层 / 主进程语法
const { execFileSync } = require('child_process');
for (const f of ['renderer/app.js', 'electron/main.js', 'electron/preload.js', 'electron/preload-traffic.js']) {
  check('语法 ' + f, () => {
    execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
  });
}

// 4) 渲染层不能引用未定义的全局（粗查：几个关键函数必须存在）
check('渲染层关键函数存在', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  for (const fn of ['moveColumn', 'autoFitColumn', 'removeInvalidNodes', 'tagColumnKeys']) {
    if (!new RegExp('function\\s+' + fn + '\\s*\\(').test(src)) throw new Error('缺少函数 ' + fn);
  }
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name + (r.ok ? '' : '\n      ' + r.error));
}

if (failed.length) {
  console.error(`\n构建前自检失败：${failed.length} 项`);
  process.exit(1);
}
console.log(`\n构建前自检通过：${results.length} 项`);
