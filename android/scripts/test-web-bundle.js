'use strict';

/**
 * 浏览器包冒烟测试
 *
 * 在 Node 的 vm 沙箱里模拟 window/self，按 index.html 的顺序加载 vendor 脚本，
 * 验证包装后的 parser / filter / merge / ruleFormat / clash / configgen
 * 在**没有 Node 环境**的情况下也能正常工作。
 *
 * 这是安卓端 WebView 里实际运行的代码路径 —— 不测就等于没写。
 *
 * 用法: node scripts/test-web-bundle.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const VENDOR = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'web', 'vendor');

let pass = 0;
let fail = 0;
const failures = [];

function ok(l, d) {
  pass += 1;
  console.log(`  ✔ ${l}${d ? '  ' + d : ''}`);
}
function bad(l, d) {
  fail += 1;
  failures.push(l);
  console.log(`  ✘ ${l}${d ? '  ' + d : ''}`);
}
function eq(l, actual, wanted) {
  const a = JSON.stringify(actual);
  const w = JSON.stringify(wanted);
  if (a === w) ok(l, a);
  else bad(l, `${w} ← 实际 ${a}`);
}

/** 建一个尽量贴近浏览器的沙箱 */
function makeSandbox() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.console = console;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = setInterval;
  sandbox.clearInterval = clearInterval;
  sandbox.navigator = { userAgent: 'Android' };
  // WebView 里有、vm 沙箱里没有的 Web/Node 全局
  sandbox.URL = URL;
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.TextDecoder = TextDecoder;
  sandbox.TextEncoder = TextEncoder;
  sandbox.atob = (s) => Buffer.from(String(s), 'base64').toString('binary');
  sandbox.btoa = (s) => Buffer.from(String(s), 'binary').toString('base64');
  sandbox.queueMicrotask = queueMicrotask;
  return vm.createContext(sandbox);
}

function load(ctx, file) {
  const code = fs.readFileSync(path.join(VENDOR, file), 'utf8');
  vm.runInContext(code, ctx, { filename: file });
}

const ORDER = ['js-yaml.min.js', 'loader.js', 'filter.js', 'merge.js', 'parser.js', 'ruleFormat.js', 'clash.js', 'configgen.js'];

console.log('浏览器包冒烟测试（模拟 WebView 加载顺序）');

const ctx = makeSandbox();
try {
  for (const f of ORDER) load(ctx, f);
  ok('全部脚本加载无异常', ORDER.length + ' 个文件');
} catch (e) {
  bad('脚本加载抛错', e.message);
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(1);
}

const W = ctx;

/* ---------- 全局是否就位 ---------- */
if (W.jsyaml && typeof W.jsyaml.load === 'function') ok('js-yaml 就位');
else bad('js-yaml 未挂载');

if (W.V2P && W.V2P.parser) ok('V2P.parser 就位');
else bad('V2P.parser 缺失');

if (W.IPHFilter) ok('IPHFilter 就位');
else bad('IPHFilter 缺失');

if (W.IPHMerge) ok('IPHMerge 就位');
else bad('IPHMerge 缺失');

if (W.V2PConfigGen) ok('V2PConfigGen 就位');
else bad('V2PConfigGen 缺失');

/* ---------- parser ---------- */
const SAMPLE = [
  'ss://YWVzLTEyOC1nY206cGFzcw@1.2.3.4:8388#HK-01',
  'trojan://pw@5.6.7.8:443?sni=a.com#JP-02',
  'socks5://9.9.9.9:1080#SG-03',
].join('\n');

let parsed = null;
try {
  parsed = W.V2P.parser.parseText(SAMPLE, { plainType: 'socks5' });
  eq('解析出 3 个节点', parsed.nodes.length, 3);
  eq('首个节点名称', parsed.nodes[0].name, 'HK-01');
  eq('首个节点协议', parsed.nodes[0].type, 'ss');
} catch (e) {
  bad('parser.parseText 抛错', e.message);
}

/* ---------- configgen ---------- */
if (parsed && parsed.nodes.length) {
  try {
    const built = W.V2PConfigGen.buildMihomoConfig({
      nodes: parsed.nodes,
      routeMode: 'bypass-cn',
      mixedPort: 7890,
      ctlPort: 9090,
      listenerBase: 20000,
    });
    eq('生成 listeners', built.config.listeners.length, 3);
    eq('listener 绑定节点', built.config.listeners[0].proxy, 'HK-01');
    eq('规则顺序', built.config.rules[0], 'RULE-SET,cn-domain,DIRECT');
    if (built.yaml.includes('proxies:') && built.yaml.includes('listeners:')) ok('YAML 文本包含关键段');
    else bad('YAML 文本缺少关键段');
  } catch (e) {
    bad('configgen 抛错', e.message);
  }
}

/* ---------- clash 导出 ---------- */
if (parsed && parsed.nodes.length) {
  try {
    const built = W.V2P.clash.buildClashYaml(parsed.nodes, {});
    if (built.text.includes('proxy-groups:') && built.text.includes('proxies:')) ok('clash 导出可用');
    else bad('clash 导出内容异常');
    eq('导出节点数', built.count, 3);
  } catch (e) {
    bad('clash 导出抛错', e.message);
  }
}

/* ---------- filter / merge ---------- */
if (parsed && W.IPHFilter) {
  try {
    const fake = parsed.nodes.map((n, i) => Object.assign({}, n, {
      status: 'ok', latency: 100 + i * 10, health: 80, country: '中国香港', countryCode: 'HK',
    }));
    // 签名：matches(node, filter, query, skip)
    const kept = fake.filter((n) => W.IPHFilter.matches(n, W.IPHFilter.EMPTY, ''));
    eq('filter.matches 全通过', kept.length, fake.length);

    const filtered = fake.filter((n) => W.IPHFilter.matches(n, { minHealth: 90 }, ''));
    eq('filter 按健康度过滤生效', filtered.length, 0);

    const facets = W.IPHFilter.facetCounts(fake, W.IPHFilter.EMPTY, '', 'country', W.IPHFilter.countryKey);
    if (facets && typeof facets.get === 'function') ok('filter.facetCounts 可用', `${facets.size} 个分组`);
    else bad('filter.facetCounts 返回值异常');
  } catch (e) {
    bad('filter 抛错', e.message);
  }
}

if (parsed && W.IPHMerge) {
  try {
    // 签名：mergeFromSource(state, src, incoming, removeGone)
    const state = { nodes: [], selected: new Set() };
    const src = { url: 'https://sub.example.com/x' };
    const incoming = parsed.nodes.map((n) => Object.assign({}, n, { source: src.url }));
    const r1 = W.IPHMerge.mergeFromSource(state, src, incoming, false);
    eq('merge 首次导入', r1.added, incoming.length);

    const r2 = W.IPHMerge.mergeFromSource(state, src, incoming, false);
    eq('merge 重复导入不新增', r2.added, 0);
    eq('merge 后节点总数', state.nodes.length, incoming.length);

    const key = W.IPHMerge.keyOf(parsed.nodes[0]);
    if (typeof key === 'string' && key.length) ok('merge.keyOf 可用', key);
    else bad('merge.keyOf 返回值异常');
  } catch (e) {
    bad('merge 抛错', e.message);
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) console.log('失败项: ' + failures.join(' / '));
process.exit(fail ? 1 : 0);
