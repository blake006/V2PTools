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
for (const mod of ['tester', 'gateway', 'exporters', 'netcheck', 'proxyAgent', 'runner', 'clash', 'parser']) {
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
  for (const need of ['vendor/mihomo.exe', 'assets/rules']) {
    if (!froms.includes(need)) throw new Error('extraResources 缺少 ' + need);
  }
  const fsx = require('fs');
  if (!fsx.existsSync(path.join(ROOT, 'vendor', 'mihomo.exe'))) throw new Error('vendor/mihomo.exe 不存在');
  if (!fsx.existsSync(path.join(ROOT, 'assets', 'rules', 'cn-domain.yaml'))) throw new Error('assets/rules/cn-domain.yaml 不存在');
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
