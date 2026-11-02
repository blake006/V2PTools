'use strict';

/**
 * 配置生成器回归测试：node android/scripts/test-configgen.js
 *
 * 关键约束（曾经踩过）：
 *   1) 所有节点都要进 proxies —— 否则第 201 个之后的节点「设为使用中」时在配置里不存在
 *   2) 测速 listener 只给前 MAX_LISTENERS 个节点开 —— 几千个 inbound 会把内核内存吃光
 *   3) listener.proxy 必须与节点名一一对应，否则测的是别人的延迟
 */

const path = require('path');
const cg = require(path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'web', 'vendor', 'configgen.js'));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + name);
  } else {
    fail += 1;
    console.log('  ✗ ' + name + (extra ? ' — ' + extra : ''));
  }
};

const nodes = [];
for (let i = 0; i < 320; i += 1) {
  nodes.push({ name: 'N' + i, type: 'ss', server: '1.2.3.' + (i % 250), port: 1000 + i, conf: { cipher: 'aes-128-gcm', password: 'p' + i } });
}

const built = cg.buildMihomoConfig({ nodes, routeMode: 'global', mixedPort: 7890, ctlPort: 9090, listenerBase: 20000 });
const conf = built.config;
const cap = cg.MAX_LISTENERS;

console.log('配置生成');

ok('proxies 覆盖全部节点', conf.proxies.length === nodes.length, conf.proxies.length + '/' + nodes.length);
ok('listeners 数量等于上限', conf.listeners.length === cap, conf.listeners.length + '/' + cap);
ok('listener 端口连续', conf.listeners.every((l, i) => l.port === 20000 + i));
ok('listener 绑定到对应节点', conf.listeners.every((l, i) => l.proxy === 'N' + i), conf.listeners[0].proxy + '…');
ok('所有 listener 都是 mixed', conf.listeners.every((l) => l.type === 'mixed'));
ok('PROXY 组包含全部节点名', conf['proxy-groups'][0].proxies.length === nodes.length, String(conf['proxy-groups'][0].proxies.length));
ok('yaml 非空', typeof built.yaml === 'string' && built.yaml.length > 1000);

// 节点名重复时不能撞名（撞名会让 listener 指向错误节点）
const dup = cg.buildMihomoConfig({
  nodes: [{ name: '同名', type: 'ss', server: 'a.1', port: 1, conf: { password: 'a' } }, { name: '同名', type: 'ss', server: 'a.2', port: 2, conf: { password: 'b' } }],
  mixedPort: 7890,
  ctlPort: 9090,
});
const names = dup.config.proxies.map((p) => p.name);
ok('重名节点自动去重', new Set(names).size === names.length, names.join(','));

// 配置体积上限：节点再多也只写前 MAX_PROXIES 个，避免 YAML 过大 / 跨桥传输过大
const many = [];
for (let i = 0; i < 900; i += 1) {
  many.push({ name: 'M' + i, type: 'ss', server: '5.6.7.' + (i % 250), port: 2000 + i, conf: { cipher: 'aes-128-gcm', password: 'q' + i } });
}
const big = cg.buildMihomoConfig({ nodes: many, mixedPort: 7890, ctlPort: 9090 });
ok('超量节点按上限截断', big.config.proxies.length === cg.MAX_PROXIES, big.config.proxies.length + '/' + cg.MAX_PROXIES);
ok('截断标记为 true', big.truncated === true);
ok('返回总数与使用数', big.total === 900 && big.used === cg.MAX_PROXIES, big.total + '/' + big.used);
ok('YAML 体积可控（< 1MB）', Buffer.byteLength(big.yaml, 'utf8') < 1024 * 1024, (Buffer.byteLength(big.yaml, 'utf8') / 1024).toFixed(0) + 'KB');

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
