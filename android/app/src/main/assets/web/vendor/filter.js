/**
 * 筛选 / 过滤核心逻辑（纯函数，便于单测）
 *
 * 规则：不同维度之间是「且」，同一维度内多选是「或」。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IPHFilter = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const EMPTY = {
    status: 'all', // all | ok | fail | idle
    group: 'all', // all | none | 分组名
    protocols: [], // 协议 type 列表
    countries: [], // 国家码列表（空字符串代表未知）
    ipTypes: [], // residential | hosting | proxy | mobile | unknown
    minHealth: null,
    maxLatency: null,
    minSpeed: null,
    dnsblOnly: false,
  };

  function normalize(f) {
    const out = Object.assign({}, EMPTY, f || {});
    out.protocols = Array.from(out.protocols || []);
    out.countries = Array.from(out.countries || []);
    out.ipTypes = Array.from(out.ipTypes || []);
    if (out.group == null) out.group = 'all';
    return out;
  }

  /** IP 类型归类（住宅 / 机房 / 代理 / 移动 / 未知） */
  function ipTypeKey(n) {
    if (n.mobileFlag) return 'mobile';
    if (n.hostingFlag) return 'hosting';
    if (n.proxyFlag) return 'proxy';
    if (n.ip) return 'residential';
    return 'unknown';
  }

  function countryKey(n) {
    return (n.countryCode || '').toUpperCase();
  }

  function textMatch(n, q) {
    if (!q) return true;
    const hay = [n.name, n.server, n.country, n.city, n.isp, n.asn, n.ip, n.type, n.group]
      .join(' ')
      .toLowerCase();
    return hay.includes(q.toLowerCase());
  }

  /**
   * @param {object} n 节点
   * @param {object} f 筛选条件
   * @param {string} query 搜索词
   * @param {string} [skip] 跳过某个维度（用于计算该维度的可选数量）
   */
  function matches(n, f, query, skip) {
    const c = normalize(f);

    if (skip !== 'status' && c.status !== 'all' && n.status !== c.status) return false;

    if (skip !== 'group' && c.group !== 'all') {
      const g = n.group || '';
      if (c.group === 'none') {
        if (g) return false;
      } else if (g !== c.group) {
        return false;
      }
    }

    if (skip !== 'protocols' && c.protocols.length && !c.protocols.includes(n.type)) return false;

    if (skip !== 'countries' && c.countries.length && !c.countries.includes(countryKey(n))) return false;

    if (skip !== 'ipTypes' && c.ipTypes.length && !c.ipTypes.includes(ipTypeKey(n))) return false;

    if (skip !== 'numeric') {
      if (c.minHealth != null && (n.health == null || n.health < c.minHealth)) return false;
      if (c.maxLatency != null && (n.latency == null || n.latency > c.maxLatency)) return false;
      if (c.minSpeed != null && (n.speed == null || n.speed < c.minSpeed)) return false;
      if (c.dnsblOnly && !(n.dnsbl && n.dnsbl.length)) return false;
    }

    if (skip !== 'query' && !textMatch(n, query)) return false;
    return true;
  }

  /** 某个维度取值的可选数量（其余条件生效，本维度不生效） */
  function facetCounts(nodes, f, query, facet, keyOf) {
    const map = new Map();
    for (const n of nodes) {
      if (!matches(n, f, query, facet)) continue;
      const k = keyOf(n);
      map.set(k, (map.get(k) || 0) + 1);
    }
    return map;
  }

  /** 是否存在任何筛选条件（用于显示「清除筛选」） */
  function isActive(f, query) {
    const c = normalize(f);
    return (
      c.status !== 'all' ||
      c.group !== 'all' ||
      c.protocols.length > 0 ||
      c.countries.length > 0 ||
      c.ipTypes.length > 0 ||
      c.minHealth != null ||
      c.maxLatency != null ||
      c.minSpeed != null ||
      c.dnsblOnly ||
      !!query
    );
  }

  function activeCount(f, query) {
    const c = normalize(f);
    let n = 0;
    if (c.status !== 'all') n += 1;
    if (c.group !== 'all') n += 1;
    if (c.protocols.length) n += 1;
    if (c.countries.length) n += 1;
    if (c.ipTypes.length) n += 1;
    if (c.minHealth != null || c.maxLatency != null || c.minSpeed != null || c.dnsblOnly) n += 1;
    if (query) n += 1;
    return n;
  }

  return { EMPTY, normalize, matches, facetCounts, isActive, activeCount, ipTypeKey, countryKey };
});
