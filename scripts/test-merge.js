'use strict';

/** 订阅同步合并逻辑测试 */

const assert = require('assert');
const { mergeFromSource, keyOf } = require('../renderer/merge');

function node(o) {
  return {
    id: o.id,
    name: o.name || '',
    type: o.type || 'ss',
    server: o.server,
    port: o.port,
    conf: o.conf || { cipher: 'aes-128-gcm', password: 'pw' },
    raw: o.raw || '',
    source: o.source || '',
    group: o.group || '',
    status: o.status || 'idle',
    latency: o.latency == null ? null : o.latency,
    health: o.health == null ? null : o.health,
  };
}

function makeState(nodes) {
  return { nodes, selected: new Set() };
}

let pass = 0;
function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('✔', name);
  } catch (e) {
    console.log('✘', name, '\n   ', e.message);
    process.exitCode = 1;
  }
}

const SRC = { url: 'https://a.example.com/sub', group: 'a.example.com' };

t('新节点被追加并打上来源', () => {
  const state = makeState([]);
  const r = mergeFromSource(state, SRC, [node({ id: 'x1', server: '1.1.1.1', port: 443 })], true);
  assert.deepStrictEqual(r, { added: 1, updated: 0, removed: 0 });
  assert.strictEqual(state.nodes.length, 1);
  assert.strictEqual(state.nodes[0].source, SRC.url);
  assert.strictEqual(state.nodes[0].group, 'a.example.com');
});

t('已存在节点只更新配置，保留检测结果', () => {
  const old = node({ id: 'n1', server: '1.1.1.1', port: 443, source: SRC.url, status: 'ok', latency: 88, health: 95 });
  old.conf = { cipher: 'old' };
  const state = makeState([old]);
  const fresh = node({ id: 'n2', server: '1.1.1.1', port: 443, conf: { cipher: 'new' }, name: '新名字' });
  const r = mergeFromSource(state, SRC, [fresh], true);
  assert.deepStrictEqual(r, { added: 0, updated: 1, removed: 0 });
  assert.strictEqual(state.nodes.length, 1);
  const n = state.nodes[0];
  assert.strictEqual(n.id, 'n1', '应保留原节点对象');
  assert.strictEqual(n.conf.cipher, 'new', '配置应更新');
  assert.strictEqual(n.name, '新名字');
  assert.strictEqual(n.latency, 88, '延迟结果应保留');
  assert.strictEqual(n.health, 95, '健康度应保留');
  assert.strictEqual(n.status, 'ok');
});

t('订阅中消失的节点被移除（removeGone=true）', () => {
  const keep = node({ id: 'n1', server: '1.1.1.1', port: 443, source: SRC.url });
  const gone = node({ id: 'n2', server: '2.2.2.2', port: 443, source: SRC.url });
  const other = node({ id: 'n3', server: '3.3.3.3', port: 443, source: 'https://other/sub' });
  const state = makeState([keep, gone, other]);
  state.selected.add('n2');
  const r = mergeFromSource(state, SRC, [node({ id: 'f1', server: '1.1.1.1', port: 443 })], true);
  assert.strictEqual(r.removed, 1);
  assert.deepStrictEqual(state.nodes.map((n) => n.id).sort(), ['n1', 'n3']);
  assert.strictEqual(state.selected.has('n2'), false, '选中状态应清理');
});

t('removeGone=false 时保留消失节点', () => {
  const keep = node({ id: 'n1', server: '1.1.1.1', port: 443, source: SRC.url });
  const gone = node({ id: 'n2', server: '2.2.2.2', port: 443, source: SRC.url });
  const state = makeState([keep, gone]);
  const r = mergeFromSource(state, SRC, [node({ id: 'f1', server: '1.1.1.1', port: 443 })], false);
  assert.strictEqual(r.removed, 0);
  assert.strictEqual(state.nodes.length, 2);
});

t('其它来源已有的同节点不会重复添加', () => {
  const other = node({ id: 'n1', server: '1.1.1.1', port: 443, source: 'https://other/sub' });
  const state = makeState([other]);
  const r = mergeFromSource(state, SRC, [node({ id: 'f1', server: '1.1.1.1', port: 443 })], true);
  assert.deepStrictEqual(r, { added: 0, updated: 0, removed: 0 });
  assert.strictEqual(state.nodes.length, 1);
});

t('端口/协议不同视为不同节点', () => {
  const a = node({ id: 'n1', server: '1.1.1.1', port: 443, source: SRC.url });
  const state = makeState([a]);
  const r = mergeFromSource(
    state,
    SRC,
    [node({ id: 'f1', server: '1.1.1.1', port: 8443 }), node({ id: 'f2', server: '1.1.1.1', port: 443, type: 'trojan' })],
    true
  );
  // 原 443/ss 节点不在新列表中，按 removeGone 移除；新增 8443 与 trojan:443
  assert.deepStrictEqual(r, { added: 2, updated: 0, removed: 1 });
  assert.strictEqual(state.nodes.length, 2);
});

t('服务器名大小写不敏感', () => {
  const a = node({ id: 'n1', server: 'Example.COM', port: 443, source: SRC.url });
  const state = makeState([a]);
  const r = mergeFromSource(state, SRC, [node({ id: 'f1', server: 'example.com', port: 443 })], true);
  assert.deepStrictEqual(r, { added: 0, updated: 1, removed: 0 });
  assert.strictEqual(keyOf(state.nodes[0]), 'ss|example.com|443');
});

t('同一订阅源重复同步是幂等的', () => {
  const state = makeState([]);
  const payload = [node({ id: 'a', server: '1.1.1.1', port: 443 }), node({ id: 'b', server: '2.2.2.2', port: 443 })];
  mergeFromSource(state, SRC, payload, true);
  const r2 = mergeFromSource(state, SRC, payload, true);
  assert.deepStrictEqual(r2, { added: 0, updated: 2, removed: 0 });
  assert.strictEqual(state.nodes.length, 2);
});

t('新节点无名称时自动命名', () => {
  const state = makeState([]);
  mergeFromSource(state, SRC, [node({ id: 'x', server: '9.9.9.9', port: 1080, name: '' })], true);
  assert.strictEqual(state.nodes[0].name, '9.9.9.9:1080');
});

console.log(`\n通过 ${pass} 项`);
