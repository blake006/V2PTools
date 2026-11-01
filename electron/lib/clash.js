'use strict';

/**
 * 把节点导出成一份可直接使用的 Clash / mihomo 配置。
 *
 * 场景：在 V2PTools 里筛出「可用 + 健康度高」的节点，一键导出 YAML，
 * 直接丢给 Clash Verge / ClashX / mihomo 当订阅配置用。
 *
 * 节点模型的 conf 字段本身就是 mihomo 的 proxy 字段（内核配置生成时直接展开），
 * 所以这里只需要补 name / type / server / port，再拼上分组与规则。
 */

const yaml = require('js-yaml');

const GROUP_MAIN = '🚀 节点选择';
const GROUP_AUTO = '♻️ 自动选择';
const TEST_URL = 'http://cp.cloudflare.com/generate_204';

function clone(v) {
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clone);
  const out = {};
  for (const k of Object.keys(v)) out[k] = clone(v[k]);
  return out;
}

function flagEmoji(code) {
  const c = String(code || '').toUpperCase();
  if (c.length !== 2) return '';
  const A = 0x1f1e6;
  return String.fromCodePoint(...c.split('').map((ch) => A + (ch.charCodeAt(0) - 65)));
}

/** Clash 的节点名必须唯一；顺手去掉换行与超长尾巴 */
function uniqueName(base, used) {
  let name = String(base || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 60);
  if (!name) name = 'node';
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  let i = 2;
  while (used.has(`${name} #${i}`)) i += 1;
  const out = `${name} #${i}`;
  used.add(out);
  return out;
}

/**
 * @param {Array} nodes 节点列表（已按需要筛选过）
 * @param {object} [opts]
 * @param {boolean} [opts.regionGroups] 是否按国家/地区额外分组，默认 true
 * @param {boolean} [opts.autoGroup] 是否生成 url-test 自动选择分组，默认 true
 * @param {number} [opts.mixedPort] 混合端口，默认 7890
 * @returns {object} Clash 配置对象
 */
function buildClashConfig(nodes, opts = {}) {
  const list = (nodes || []).filter((n) => n && n.type && n.server && n.port);
  if (!list.length) throw new Error('没有可导出的节点');
  const used = new Set();
  const proxies = [];
  const nameById = new Map();
  const regionMap = new Map(); // 国家名 -> [节点名]

  for (const n of list) {
    const conf = clone(n.conf || {});
    const name = uniqueName(n.name || `${n.type}-${n.server}:${n.port}`, used);
    const proxy = {
      ...conf,
      name,
      type: n.type,
      server: n.server,
      port: Number(n.port),
    };
    proxies.push(proxy);
    nameById.set(n.id, name);

    const region = n.country || n.countryCode || '';
    if (region) {
      if (!regionMap.has(region)) regionMap.set(region, { code: n.countryCode || '', names: [] });
      regionMap.get(region).names.push(name);
    }
  }

  const names = proxies.map((p) => p.name);
  const groups = [];

  // 地区分组（只有 2 个以上地区、且覆盖到大部分节点时才加，避免配置里一堆单节点分组）
  const regionGroups = [];
  if (opts.regionGroups !== false && regionMap.size >= 2) {
    const sorted = [...regionMap.entries()].sort((a, b) => b[1].names.length - a[1].names.length);
    for (const [region, info] of sorted) {
      const gname = `${flagEmoji(info.code)} ${region}`.trim();
      regionGroups.push(gname);
      groups.push({ name: gname, type: 'select', proxies: info.names });
    }
  }

  if (opts.autoGroup !== false && names.length) {
    groups.unshift({
      name: GROUP_AUTO,
      type: 'url-test',
      url: TEST_URL,
      interval: 300,
      tolerance: 50,
      proxies: names,
    });
  }

  groups.unshift({
    name: GROUP_MAIN,
    type: 'select',
    proxies: [...(opts.autoGroup !== false && names.length ? [GROUP_AUTO] : []), ...regionGroups, ...names],
  });

  const cfg = {
    'mixed-port': Number(opts.mixedPort) || 7890,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'info',
    ipv6: false,
    'external-controller': '127.0.0.1:9090',
    'unified-delay': true,
    'tcp-concurrent': true,
    // 不依赖 geoip.metadb：导出的是纯节点配置，避免首次运行去下载地理库
    'geodata-mode': false,
    'geo-auto-update': false,
    profile: { 'store-selected': true, 'store-fake-ip': false },
    dns: {
      enable: true,
      ipv6: false,
      'enhanced-mode': 'fake-ip',
      'fake-ip-range': '198.18.0.1/16',
      'default-nameserver': ['223.5.5.5', '119.29.29.29'],
      nameserver: ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'],
    },
    proxies,
    'proxy-groups': groups,
    rules: [
      'DOMAIN-SUFFIX,local,DIRECT',
      'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
      'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
      'IP-CIDR,100.64.0.0/10,DIRECT,no-resolve',
      `MATCH,${GROUP_MAIN}`,
    ],
  };

  return { config: cfg, count: proxies.length, nameById };
}

/** 导出为 YAML 文本 */
function buildClashYaml(nodes, opts) {
  const { config, count } = buildClashConfig(nodes, opts);
  return { text: yaml.dump(config, { lineWidth: 4096, noRefs: true, quotingType: '"' }), count };
}

module.exports = { buildClashConfig, buildClashYaml, GROUP_MAIN, GROUP_AUTO };
