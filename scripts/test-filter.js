'use strict';

/** 筛选逻辑单测 */

const assert = require('assert');
const F = require('../renderer/filter');

function n(o) {
  return Object.assign(
    {
      id: o.id || 'n',
      name: o.name || 'node',
      type: o.type || 'ss',
      server: o.server || '1.1.1.1',
      port: o.port || 443,
      group: o.group || '',
      status: o.status || 'ok',
      latency: o.latency === undefined ? 100 : o.latency,
      speed: o.speed === undefined ? 10 : o.speed,
      health: o.health === undefined ? 90 : o.health,
      ip: o.ip || '1.1.1.1',
      country: o.country || '中国香港',
      countryCode: o.countryCode || 'HK',
      city: o.city || '香港',
      isp: o.isp || 'HKT',
      asn: o.asn || 'AS1',
      proxyFlag: !!o.proxyFlag,
      hostingFlag: !!o.hostingFlag,
      mobileFlag: !!o.mobileFlag,
      dnsbl: o.dnsbl || [],
    },
    o
  );
}

const nodes = [
  n({ id: 'a', name: 'HK-01', type: 'ss', group: '香港', status: 'ok', latency: 50, speed: 20, health: 95, countryCode: 'HK' }),
  n({ id: 'b', name: 'JP-01', type: 'vmess', group: '日本', status: 'ok', latency: 180, speed: 5, health: 72, countryCode: 'JP', country: '日本', city: '东京', hostingFlag: true }),
  n({ id: 'c', name: 'US-01', type: 'trojan', group: '', status: 'fail', latency: null, speed: null, health: null, countryCode: 'US', country: '美国', city: '洛杉矶', ip: '', dnsbl: ['Spamhaus'] }),
  n({ id: 'd', name: 'SG-01', type: 'ss', group: '新加坡', status: 'idle', latency: null, speed: null, health: null, countryCode: 'SG', country: '新加坡', city: '新加坡', ip: '', mobileFlag: true }),
];

const base = () => JSON.parse(JSON.stringify(F.EMPTY));

function ids(f, q) {
  return nodes.filter((x) => F.matches(x, f, q || '')).map((x) => x.id);
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

t('默认不过滤', () => {
  assert.deepStrictEqual(ids(base()), ['a', 'b', 'c', 'd']);
});

t('按状态筛选', () => {
  const f = base();
  f.status = 'ok';
  assert.deepStrictEqual(ids(f), ['a', 'b']);
  f.status = 'fail';
  assert.deepStrictEqual(ids(f), ['c']);
});

t('按分组筛选（含未分组）', () => {
  const f = base();
  f.group = '日本';
  assert.deepStrictEqual(ids(f), ['b']);
  f.group = 'none';
  assert.deepStrictEqual(ids(f), ['c']);
});

t('协议多选是「或」', () => {
  const f = base();
  f.protocols = ['vmess', 'trojan'];
  assert.deepStrictEqual(ids(f), ['b', 'c']);
});

t('地区多选是「或」', () => {
  const f = base();
  f.countries = ['HK', 'SG'];
  assert.deepStrictEqual(ids(f), ['a', 'd']);
});

t('IP 类型筛选', () => {
  const f = base();
  f.ipTypes = ['hosting'];
  assert.deepStrictEqual(ids(f), ['b']);
  f.ipTypes = ['mobile'];
  assert.deepStrictEqual(ids(f), ['d']);
  f.ipTypes = ['residential'];
  assert.deepStrictEqual(ids(f), ['a']);
});

t('健康度 / 延迟 / 速度区间', () => {
  const f = base();
  f.minHealth = 90;
  assert.deepStrictEqual(ids(f), ['a']);

  const f2 = base();
  f2.maxLatency = 100;
  assert.deepStrictEqual(ids(f2), ['a']);

  const f3 = base();
  f3.minSpeed = 10;
  assert.deepStrictEqual(ids(f3), ['a']);
});

t('未测节点不满足数值条件', () => {
  const f = base();
  f.minHealth = 1;
  const got = ids(f);
  assert.deepStrictEqual(got, ['a', 'b']);
  assert.ok(!got.includes('d'), '未测节点应被排除');
});

t('只看黑名单命中', () => {
  const f = base();
  f.dnsblOnly = true;
  assert.deepStrictEqual(ids(f), ['c']);
});

t('搜索匹配多字段', () => {
  assert.deepStrictEqual(ids(base(), 'jp-01'), ['b']);
  assert.deepStrictEqual(ids(base(), '东京'), ['b']);
  assert.deepStrictEqual(ids(base(), 'as1'), ['a', 'b', 'c', 'd']);
});

t('不同维度之间是「且」', () => {
  const f = base();
  f.status = 'ok';
  f.protocols = ['ss'];
  f.countries = ['HK'];
  assert.deepStrictEqual(ids(f), ['a']);
});

t('facetCounts 会排除自身维度', () => {
  const f = base();
  f.group = '日本';
  // 计算协议维度的可选数量时，分组条件仍生效 → 只有 b
  const p = F.facetCounts(nodes, f, '', 'protocols', (x) => x.type);
  assert.strictEqual(p.get('vmess'), 1);
  assert.strictEqual(p.get('ss'), undefined);

  // 计算分组维度时，分组条件不生效 → 全部分组
  const g = F.facetCounts(nodes, f, '', 'group', (x) => x.group || '');
  assert.strictEqual(g.get('香港'), 1);
  assert.strictEqual(g.get('日本'), 1);
  assert.strictEqual(g.get(''), 1);
});

t('isActive / activeCount', () => {
  assert.strictEqual(F.isActive(base(), ''), false);
  const f = base();
  f.status = 'ok';
  f.minHealth = 80;
  f.countries = ['HK'];
  assert.strictEqual(F.isActive(f, ''), true);
  assert.strictEqual(F.activeCount(f, ''), 3);
  assert.strictEqual(F.activeCount(base(), 'hk'), 1);
});

t('normalize 把 Set 转成数组且补全字段', () => {
  const f = F.normalize({ protocols: new Set(['ss']), countries: new Set(['HK']) });
  assert.deepStrictEqual(f.protocols, ['ss']);
  assert.deepStrictEqual(f.countries, ['HK']);
  assert.strictEqual(f.status, 'all');
  assert.strictEqual(f.group, 'all');
});

console.log(`\n通过 ${pass} 项`);
