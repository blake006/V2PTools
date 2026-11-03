'use strict';

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

const state = {
  nodes: [],
  settings: {
    concurrency: 8,
    latencyTimeout: 8000,
    speedTimeout: 20000,
    speedBytes: 10,
    speedSource: 'cloudflare',
    deepHealth: true,
    autoSyncOnStart: false,
    latencyUrls: [],
    ipUrls: [],
    plainType: 'socks5',
    theme: 'dark',
    systemProxyPort: 7890,
    systemProxyBypass: '',
    systemProxyWinhttp: false,
    routeMode: 'global',
  },
  filters: {
    status: 'all',
    group: 'all',
    protocols: [],
    countries: [],
    ipTypes: [],
    minHealth: null,
    maxLatency: null,
    minSpeed: null,
    dnsblOnly: false,
    dnsblClean: false,
  },
  sidebarHidden: false,
  query: '',
  sort: { key: 'latency', dir: 1 },
  selected: new Set(),
  running: false,
  progress: { finished: 0, total: 0 },
  importTab: 'batch',
  sources: [],
  syncing: false,
  proxy: { on: false, gateway: { running: false, port: 0, node: null }, system: {} },
  proxyBusy: false,
};

const rowMap = new Map();
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const TYPE_LABEL = {
  vmess: 'VMess', vless: 'VLESS', trojan: 'Trojan', ss: 'SS', ssr: 'SSR',
  hysteria: 'Hy2?', hysteria2: 'Hysteria2', tuic: 'TUIC', anytls: 'AnyTLS',
  socks5: 'SOCKS5', http: 'HTTP', wireguard: 'WG', ssh: 'SSH',
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function flagEmoji(code) {
  if (!code || code.length !== 2) return '';
  const A = 0x1f1e6;
  const cps = code.toUpperCase().split('').map((c) => A + (c.charCodeAt(0) - 65));
  return String.fromCodePoint(...cps);
}

function fmtLatency(ms) {
  if (ms == null) return '<span class="dim">—</span>';
  const cls = ms < 300 ? 'lat-good' : ms < 800 ? 'lat-mid' : 'lat-bad';
  return `<span class="${cls}">${ms} <span class="dim" style="font-size:11px">ms</span></span>`;
}

function fmtSpeed(mbps) {
  if (mbps == null) return '<span class="dim">—</span>';
  const cls = mbps >= 10 ? 'lat-good' : mbps >= 3 ? 'lat-mid' : 'lat-bad';
  return `<span class="${cls}">${mbps.toFixed(1)} <span class="dim" style="font-size:11px">Mbps</span></span>`;
}

function healthColor(score) {
  if (score == null) return 'var(--text-faint)';
  if (score >= 85) return '#3ecf8e';
  if (score >= 70) return '#4f8cff';
  if (score >= 50) return '#f5a524';
  return '#f0605a';
}

function healthText(score) {
  if (score == null) return '未检测';
  if (score >= 85) return '优秀';
  if (score >= 70) return '良好';
  if (score >= 50) return '一般';
  return '较差';
}

function toast(msg, type, duration) {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  $('#toastWrap').appendChild(el);
  const ttl = Number(duration) > 0 ? Number(duration) : 2600;
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, ttl);
}

function setStatus(text) {
  const el = $('#statusText');
  if (el) el.textContent = text;
}

function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  state.settings.theme = t;
  document.documentElement.dataset.theme = t;
  if (window.api.setTheme) window.api.setTheme(t);
}

function saveNodes() {
  window.api.setStore('nodes', state.nodes);
}

/* ------------------------------------------------------------------ */
/* 表格渲染                                                            */
/* ------------------------------------------------------------------ */

function matchesFilters(n, skip) {
  return window.IPHFilter.matches(n, state.filters, state.query, skip);
}

function nodeVisible(n) {
  return matchesFilters(n);
}

/** 重新计算所有筛选相关的显示（行可见性 / 条件条 / 分面计数 / 状态计数） */
function applyFilters() {
  for (const tr of rowMap.values()) {
    const n = tr.__node;
    if (n) tr.style.display = matchesFilters(n) ? '' : 'none';
  }
  renderActiveFilters();
  updateFilterBadge();
  renderSidebar();
  updateStatusCounts();
}

let afPending = false;
/** 拖动滑杆等高频操作时按帧合并刷新 */
function scheduleApplyFilters() {
  if (afPending) return;
  afPending = true;
  requestAnimationFrame(() => {
    afPending = false;
    applyFilters();
  });
}

function updateFilterBadge() {
  const c = window.IPHFilter.activeCount(state.filters, state.query);
  const badge = $('#filterCount');
  badge.textContent = c;
  badge.classList.toggle('show', c > 0);
  $('#btnFilter').classList.toggle('active', c > 0);
}

/** 顶部「已激活筛选条件」chips */
function renderActiveFilters() {
  const box = $('#activeFilters');
  const chips = [];
  const f = window.IPHFilter.normalize(state.filters);
  const add = (label, onRemove) => chips.push({ label, onRemove });

  if (f.status !== 'all') {
    const map = { ok: '可用', fail: '失败', idle: '未测' };
    add(`状态：${map[f.status] || f.status}`, () => setStatusFilter('all'));
  }
  if (f.group !== 'all') {
    add(`分组：${f.group === 'none' ? '未分组' : f.group}`, () => setGroupFilter('all'));
  }
  if (f.protocols.length) {
    add(`协议：${f.protocols.map((t) => TYPE_LABEL[t] || t).join(' / ')}`, () => {
      state.filters.protocols = [];
      applyFilters();
    });
  }
  if (f.countries.length) {
    add(`地区：${f.countries.map((c) => (c ? flagEmoji(c) + c : '未知')).join(' ')}`, () => {
      state.filters.countries = [];
      applyFilters();
    });
  }
  if (f.ipTypes.length) {
    const map = { residential: '住宅', hosting: '机房', proxy: '代理', mobile: '移动', unknown: '未知' };
    add(`IP 类型：${f.ipTypes.map((t) => map[t] || t).join(' / ')}`, () => {
      state.filters.ipTypes = [];
      syncFilterPanel();
      applyFilters();
    });
  }
  const nums = [];
  if (f.minHealth != null) nums.push(`健康度 ≥ ${f.minHealth}`);
  if (f.maxLatency != null) nums.push(`延迟 ≤ ${f.maxLatency}ms`);
  if (f.minSpeed != null) nums.push(`速度 ≥ ${f.minSpeed}Mbps`);
  if (f.dnsblOnly) nums.push('命中黑名单');
  if (f.dnsblClean) nums.push('未命中黑名单');
  if (nums.length) {
    add(nums.join('，'), () => {
      state.filters.minHealth = null;
      state.filters.maxLatency = null;
      state.filters.minSpeed = null;
      state.filters.dnsblOnly = false;
      state.filters.dnsblClean = false;
      syncFilterPanel();
      applyFilters();
    });
  }
  if (state.query) add(`搜索：${state.query}`, () => { state.query = ''; $('#searchInput').value = ''; applyFilters(); });

  if (!chips.length) {
    box.classList.remove('show');
    box.innerHTML = '';
    return;
  }
  box.classList.add('show');
  box.innerHTML =
    '<span class="af-label">筛选</span>' +
    chips
      .map(
        (c, i) =>
          `<span class="af-chip">${esc(c.label)}<button data-af="${i}" title="移除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg></button></span>`
      )
      .join('') +
    '<button class="af-clear" id="afClear">清除全部</button>';

  box.querySelectorAll('[data-af]').forEach((b) => {
    b.addEventListener('click', () => {
      const c = chips[Number(b.dataset.af)];
      if (c) c.onRemove();
    });
  });
  const clear = box.querySelector('#afClear');
  if (clear) clear.addEventListener('click', resetFilters);
}

function resetFilters() {
  state.filters = {
    status: 'all',
    group: 'all',
    protocols: [],
    countries: [],
    ipTypes: [],
    minHealth: null,
    maxLatency: null,
    minSpeed: null,
    dnsblOnly: false,
    dnsblClean: false,
  };
  state.query = '';
  const si = $('#searchInput');
  if (si) si.value = '';
  $$('#filterChips .chip').forEach((x) => x.classList.toggle('active', x.dataset.filter === 'all'));
  syncFilterPanel();
  applyFilters();
}

function setStatusFilter(status) {
  state.filters.status = status;
  $$('#filterChips .chip').forEach((x) => x.classList.toggle('active', x.dataset.filter === status));
  applyFilters();
}

function setGroupFilter(group) {
  state.filters.group = group;
  applyFilters();
}

/** 状态 chip 上的数字：统计「除状态外」其它筛选生效后的数量 */
function updateStatusCounts() {
  const pool = state.nodes.filter((n) => matchesFilters(n, 'status'));
  const c = { all: pool.length, ok: 0, fail: 0, idle: 0 };
  for (const n of pool) {
    if (c[n.status] != null) c[n.status] += 1;
  }
  $('#cAll').textContent = c.all;
  $('#cOk').textContent = c.ok;
  $('#cFail').textContent = c.fail;
  $('#cIdle').textContent = c.idle;
}

function sortedNodes() {
  const arr = state.nodes.slice();
  const { key, dir } = state.sort;
  const num = ['latency', 'speed', 'health', 'tcp'];
  arr.sort((a, b) => {
    let va = a[key];
    let vb = b[key];
    if (num.includes(key)) {
      if (va == null) va = Infinity;
      if (vb == null) vb = Infinity;
      return (va - vb) * dir;
    }
    va = String(va == null ? '' : va);
    vb = String(vb == null ? '' : vb);
    return va.localeCompare(vb, 'zh') * dir;
  });
  return arr;
}

function rowHtml(n) {
  const typeLabel = TYPE_LABEL[n.type] || n.type;
  const sel = state.selected.has(n.id) ? ' selected' : '';
  const failCls = n.status === 'fail' ? ' fail' : '';
  const inUse = proxyInUseId() === n.id;
  return `
    <td class="col-check"><input type="checkbox" data-check="${n.id}" ${state.selected.has(n.id) ? 'checked' : ''} /></td>
    <td class="col-status"><span class="status-dot ${n.status === 'ok' ? 'ok' : n.status === 'fail' ? 'fail' : n.status === 'testing' ? 'testing' : ''}" title="${esc(n.error || '')}"></span></td>
    <td class="col-name">
      <div class="name-cell">
        <span class="badge ${n.type}">${esc(typeLabel)}</span>
        <span class="name-text" title="${esc(n.name)}">${esc(n.name || n.server)}</span>
        ${inUse ? '<span class="pill ok use-pill">系统代理</span>' : ''}
      </div>
    </td>
    <td class="col-server mono dim" title="${esc(n.server)}">${esc(n.server)}:${n.port}</td>
    <td class="col-num" data-cell="latency">${fmtLatency(n.latency)}</td>
    <td class="col-num dim" data-cell="jitter">${n.jitter != null ? n.jitter + ' ms' : '—'}</td>
    <td class="col-num" data-cell="speed">${fmtSpeed(n.speed)}</td>
    <td class="col-ip mono" data-cell="ip">${n.ip ? esc(n.ip) : '<span class="dim">—</span>'}</td>
    <td class="col-loc" data-cell="loc">${locHtml(n)}</td>
    <td class="col-isp dim" data-cell="isp" title="${esc(n.isp || '')}">${esc(n.isp || '—')}</td>
    <td class="col-iptype" data-cell="iptype">${ipTypeCell(n)}</td>
    <td class="col-health" data-cell="health">${healthHtml(n)}</td>
    <td class="col-act">
      <div class="row-act">
        <button class="icon-mini ${inUse ? 'on' : ''}" data-act="use" data-id="${n.id}" title="${inUse ? '系统代理正在使用该节点' : '设为系统代理'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v9" stroke-linecap="round"/><path d="M6.4 6.4a8 8 0 1 0 11.2 0" stroke-linecap="round"/></svg>
        </button>
        <button class="icon-mini" data-act="test" data-id="${n.id}" title="单独检测">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" stroke-linejoin="round"/></svg>
        </button>
        <button class="icon-mini" data-act="detail" data-id="${n.id}" title="详情">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01" stroke-linecap="round"/></svg>
        </button>
        <button class="icon-mini" data-act="del" data-id="${n.id}" title="删除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </td>`;
}

function locHtml(n) {
  if (!n.country && !n.city) return '<span class="dim">—</span>';
  const flag = n.countryCode ? `<span class="flag">${flagEmoji(n.countryCode)}</span>` : '';
  const main = n.country || '';
  const sub = [...new Set([n.city, n.region].filter(Boolean))]
    .filter((v) => v !== n.country)
    .join(' · ');
  return `${flag}${esc(main)}${sub ? `<span class="dim" style="margin-left:6px;font-size:11.5px">${esc(sub)}</span>` : ''}`;
}

/** 表格里的 IP 类型单元格：颜色区分住宅/机房/代理，悬停看判定依据 */
function ipTypeCell(n) {
  if (!n.ipType) return '<span class="dim">—</span>';
  const key = n.ipTypeKey || 'unknown';
  const cls = { residential: 'ok', hosting: 'bad', proxy: 'warn', mobile: '', unknown: 'dim' }[key] || '';
  const why = (n.ipTypeReasons || []).join('；');
  const conf = n.ipTypeConfidence ? `（置信度 ${n.ipTypeConfidence}%）` : '';
  return `<span class="pill ${cls}" title="${esc(why + conf)}">${esc(n.ipType)}</span>`;
}

function healthHtml(n) {
  if (n.health == null) return '<span class="dim" style="font-size:11.5px">—</span>';
  const c = healthColor(n.health);
  return `<div class="health-cell">
      <div class="health-bar"><i style="width:${n.health}%;background:${c}"></i></div>
      <span class="health-num" style="color:${c}">${n.health}</span>
    </div>`;
}

function renderTable() {
  const tbody = $('#tbody');
  const list = sortedNodes();
  const frag = document.createDocumentFragment();
  rowMap.clear();

  for (const n of list) {
    const tr = document.createElement('tr');
    tr.dataset.id = n.id;
    if (state.selected.has(n.id)) tr.classList.add('selected');
    if (n.status === 'fail') tr.classList.add('fail');
    if (proxyInUseId() === n.id) tr.classList.add('in-use');
    tr.innerHTML = rowHtml(n);
    tr.__node = n;
    frag.appendChild(tr);
    rowMap.set(n.id, tr);
  }
  tbody.innerHTML = '';
  tbody.appendChild(frag);
  $('#emptyState').classList.toggle('show', list.length === 0);
  const proxyBtn = $('#btnProxy');
  if (proxyBtn) proxyBtn.disabled = !list.length || state.proxyBusy;
  updateStats();
  applyFilters();
  updateSelInfo();
}

function updateRow(n) {
  const tr = rowMap.get(n.id);
  if (!tr) return;
  const dot = tr.querySelector('.status-dot');
  if (dot) dot.className = 'status-dot ' + (n.status === 'ok' ? 'ok' : n.status === 'fail' ? 'fail' : n.status === 'testing' ? 'testing' : '');
  tr.classList.toggle('fail', n.status === 'fail');
  const set = (name, html) => {
    const el = tr.querySelector(`[data-cell="${name}"]`);
    if (el) el.innerHTML = html;
  };
  set('latency', fmtLatency(n.latency));
  set('jitter', n.jitter != null ? n.jitter + ' ms' : '—');
  set('speed', fmtSpeed(n.speed));
  set('ip', n.ip ? esc(n.ip) : '<span class="dim">—</span>');
  set('loc', locHtml(n));
  set('isp', esc(n.isp || '—'));
  set('iptype', ipTypeCell(n));
  set('health', healthHtml(n));
  tr.style.display = nodeVisible(n) ? '' : 'none';
}

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */

function updateStats() {
  const total = state.nodes.length;
  const ok = state.nodes.filter((n) => n.status === 'ok');
  const fail = state.nodes.filter((n) => n.status === 'fail').length;
  const idle = state.nodes.filter((n) => n.status === 'idle').length;

  $('#stTotal').textContent = total;
  $('#stTotalHint').textContent = total ? `${new Set(state.nodes.map((n) => n.type)).size} 种协议` : '等待导入';

  $('#stAlive').textContent = ok.length;
  $('#stAliveHint').textContent = total ? `可用率 ${Math.round((ok.length / total) * 100)}%` : '可用率 —';

  const lats = ok.map((n) => n.latency).filter((v) => v != null);
  if (lats.length) {
    const avg = Math.round(lats.reduce((a, b) => a + b, 0) / lats.length);
    $('#stLatency').textContent = avg + ' ms';
    $('#stLatencyHint').textContent = '最优 ' + Math.min(...lats) + ' ms';
  } else {
    $('#stLatency').textContent = '—';
    $('#stLatencyHint').textContent = '最优 —';
  }

  const sps = ok.map((n) => n.speed).filter((v) => v != null);
  if (sps.length) {
    const avg = sps.reduce((a, b) => a + b, 0) / sps.length;
    $('#stSpeed').textContent = avg.toFixed(1) + ' Mbps';
    $('#stSpeedHint').textContent = '峰值 ' + Math.max(...sps).toFixed(1) + ' Mbps';
  } else {
    $('#stSpeed').textContent = '—';
    $('#stSpeedHint').textContent = '峰值 —';
  }

  const hs = ok.map((n) => n.health).filter((v) => v != null);
  if (hs.length) {
    const avg = Math.round(hs.reduce((a, b) => a + b, 0) / hs.length);
    $('#stHealth').textContent = avg;
    $('#stHealthHint').textContent = `优秀 ${hs.filter((v) => v >= 85).length} 个`;
  } else {
    $('#stHealth').textContent = '—';
    $('#stHealthHint').textContent = '优秀 0 个';
  }

  $('#cAll').textContent = total;
  $('#cOk').textContent = ok.length;
  $('#cFail').textContent = fail;
  $('#cIdle').textContent = idle;
}

function updateSelInfo() {
  const n = state.selected.size;
  $('#selInfo').textContent = n ? `已选择 ${n} 项` : '';
  $('#selCount').textContent = `已选 ${n}`;
  $('#btnDeleteSel').disabled = n === 0;
  const all = state.nodes.length > 0 && n === state.nodes.length;
  $('#checkAll').checked = all;
}

/* ------------------------------------------------------------------ */
/* 分组 & 分面侧栏                                                     */
/* ------------------------------------------------------------------ */

const IP_TYPE_LABEL = { residential: '住宅', hosting: '机房', proxy: '代理', mobile: '移动', unknown: '未知' };

function sbRow(opts) {
  const { label, count, active, value, facet, more } = opts;
  const zero = count === 0 && !active ? ' zero' : '';
  return `<div class="sb-item${active ? ' active' : ''}${zero}" data-facet="${facet}" data-value="${esc(value)}" title="${esc(label)}">
      <span class="sb-name">${label}</span>
      <span class="sb-num">${count}</span>
      ${more ? `<button class="icon-mini sb-more" data-gmore="${esc(value)}" title="分组操作">
        <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
      </button>` : ''}
    </div>`;
}

function renderSidebar() {
  if (!state.nodes.length) {
    $('#groupList').innerHTML = '<div class="sb-empty">还没有节点</div>';
    $('#protoList').innerHTML = '<div class="sb-empty">—</div>';
    $('#countryList').innerHTML = '<div class="sb-empty">—</div>';
    return;
  }

  const F = window.IPHFilter;
  const f = state.filters;

  /* 分组 */
  const gCounts = F.facetCounts(state.nodes, f, state.query, 'group', (n) => n.group || '');
  const allCount = [...gCounts.values()].reduce((a, b) => a + b, 0);
  const ungrouped = gCounts.get('') || 0;
  const groups = [...gCounts.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh'));

  let html = sbRow({ label: '全部节点', count: allCount, active: f.group === 'all', value: 'all', facet: 'group' });
  html += sbRow({ label: '未分组', count: ungrouped, active: f.group === 'none', value: 'none', facet: 'group' });
  html += groups
    .map((g) => sbRow({ label: esc(g), count: gCounts.get(g) || 0, active: f.group === g, value: g, facet: 'group', more: true }))
    .join('');
  $('#groupList').innerHTML = html;

  /* 协议 */
  const pCounts = F.facetCounts(state.nodes, f, state.query, 'protocols', (n) => n.type);
  const protos = [...new Set(state.nodes.map((n) => n.type))].sort((a, b) => {
    const ca = pCounts.get(a) || 0;
    const cb = pCounts.get(b) || 0;
    return cb - ca || a.localeCompare(b);
  });
  $('#protoList').innerHTML = protos
    .map((t) =>
      sbRow({
        label: TYPE_LABEL[t] || t,
        count: pCounts.get(t) || 0,
        active: f.protocols.includes(t),
        value: t,
        facet: 'protocols',
      })
    )
    .join('');

  /* 地区 */
  const cCounts = F.facetCounts(state.nodes, f, state.query, 'countries', (n) => F.countryKey(n));
  const countries = [...cCounts.keys()].sort((a, b) => (cCounts.get(b) || 0) - (cCounts.get(a) || 0));
  const limit = state.countryLimit || 12;
  const shown = countries.slice(0, limit);
  let cHtml = shown
    .map((code) =>
      sbRow({
        label: code ? `${flagEmoji(code)} ${code}` : '未知',
        count: cCounts.get(code) || 0,
        active: f.countries.includes(code),
        value: code,
        facet: 'countries',
      })
    )
    .join('');
  if (countries.length > limit) {
    cHtml += `<div class="sb-item" data-facet="countries-more" data-value="1" style="color:var(--accent)">
      <span class="sb-name">显示全部 ${countries.length} 个地区</span></div>`;
  }
  $('#countryList').innerHTML = cHtml || '<div class="sb-empty">暂无归属地数据</div>';
}

/** 侧栏点击 */
function bindSidebar() {
  const onClick = (e) => {
    const moreBtn = e.target.closest('[data-gmore]');
    if (moreBtn) {
      e.stopPropagation();
      openGroupMenu(moreBtn.dataset.gmore, moreBtn);
      return;
    }
    const item = e.target.closest('.sb-item');
    if (!item) return;
    const { facet, value } = item.dataset;

    if (facet === 'group') {
      setGroupFilter(value);
    } else if (facet === 'protocols') {
      toggleFacet('protocols', value);
    } else if (facet === 'countries') {
      toggleFacet('countries', value);
    } else if (facet === 'countries-more') {
      state.countryLimit = 999;
      renderSidebar();
    }
  };
  ['#groupList', '#protoList', '#countryList'].forEach((sel) => {
    const el = $(sel);
    el.removeEventListener('click', onClick);
    el.addEventListener('click', onClick);
  });
}

function toggleFacet(key, value) {
  const arr = state.filters[key];
  const i = arr.indexOf(value);
  if (i === -1) arr.push(value);
  else arr.splice(i, 1);
  applyFilters();
}

/** 分组右键菜单 */
function openGroupMenu(name, anchorEl) {
  const r = anchorEl.getBoundingClientRect();
  showContextMenu(
    [
      { label: '重命名分组…', onClick: () => renameGroup(name) },
      { label: '把选中节点移入', onClick: () => moveSelectedToGroup(name) },
      '-',
      { label: '导出该分组链接', onClick: () => exportGroup(name) },
      { label: '删除分组（保留节点）', danger: true, onClick: () => deleteGroup(name) },
    ],
    r.left - 130,
    r.bottom + 4
  );
}

let ctxEl = null;
function closeContextMenu() {
  if (ctxEl && ctxEl.parentNode) ctxEl.remove();
  ctxEl = null;
}
function showContextMenu(items, x, y) {
  closeContextMenu();
  const el = document.createElement('div');
  el.className = 'menu open ctx-menu';
  el.innerHTML = items
    .map((it, i) => (it === '-' ? '<hr/>' : `<button data-ci="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`))
    .join('');
  el.style.left = Math.max(8, Math.min(x, window.innerWidth - 200)) + 'px';
  el.style.top = Math.min(y, window.innerHeight - 40 - items.length * 32) + 'px';
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ci]');
    if (!b) return;
    const it = items[Number(b.dataset.ci)];
    closeContextMenu();
    if (it && it.onClick) it.onClick();
  });
  document.body.appendChild(el);
  ctxEl = el;
}

/** 输入框弹窗（Electron 不支持 window.prompt） */
function askText(title, value = '', placeholder = '') {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask open';
    mask.style.zIndex = 220;
    mask.innerHTML = `<div class="modal" style="width:400px">
      <div class="modal-head"><div class="modal-title">${esc(title)}</div></div>
      <div class="modal-body"><input class="input" id="askInput" value="${esc(value)}" placeholder="${esc(placeholder)}" /></div>
      <div class="modal-foot"><div class="foot-btns">
        <button class="btn" data-ask="cancel">取消</button>
        <button class="btn btn-primary" data-ask="ok">确定</button>
      </div></div></div>`;
    document.body.appendChild(mask);
    const input = mask.querySelector('#askInput');
    const done = (v) => {
      mask.remove();
      resolve(v);
    };
    mask.addEventListener('click', (e) => {
      if (e.target === mask) return done(null);
      const b = e.target.closest('[data-ask]');
      if (!b) return;
      done(b.dataset.ask === 'ok' ? input.value.trim() : null);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value.trim());
      if (e.key === 'Escape') done(null);
      e.stopPropagation();
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  });
}

/* ---- 分组操作 ---- */

async function renameGroup(oldName) {
  const name = await askText('重命名分组', oldName, '输入新的分组名');
  if (name == null) return;
  if (!name) return toast('分组名不能为空', 'err');
  let n = 0;
  for (const node of state.nodes) {
    if ((node.group || '') === oldName) {
      node.group = name;
      n += 1;
    }
  }
  if (state.filters.group === oldName) state.filters.group = name;
  saveNodes();
  applyFilters();
  toast(`已将 ${n} 个节点重命名到「${name}」`, 'ok');
}

function deleteGroup(name) {
  const count = state.nodes.filter((n) => (n.group || '') === name).length;
  const ok = confirm(`删除分组「${name}」？\n该分组下的 ${count} 个节点会变成「未分组」，不会被删除。`);
  if (!ok) return;
  for (const node of state.nodes) {
    if ((node.group || '') === name) node.group = '';
  }
  if (state.filters.group === name) state.filters.group = 'all';
  saveNodes();
  applyFilters();
  toast('分组已删除，节点已归入未分组', 'ok');
}

function moveSelectedToGroup(name) {
  if (!state.selected.size) return toast('请先选择节点', 'err');
  let n = 0;
  for (const node of state.nodes) {
    if (state.selected.has(node.id)) {
      node.group = name;
      n += 1;
    }
  }
  saveNodes();
  applyFilters();
  toast(`已将 ${n} 个节点移入「${name || '未分组'}」`, 'ok');
}

async function newGroupFromSelection() {
  if (!state.selected.size) return toast('请先选择要归组的节点', 'err');
  const name = await askText('新建分组', '', '输入分组名称，例如：香港-家宽');
  if (name == null) return;
  if (!name) return toast('分组名不能为空', 'err');
  moveSelectedToGroup(name);
}

function autoGroupBy(kind) {
  if (!state.nodes.length) return toast('没有节点', 'err');
  for (const node of state.nodes) {
    if (kind === 'country') node.group = node.country || '未知地区';
    else node.group = TYPE_LABEL[node.type] || node.type;
  }
  saveNodes();
  applyFilters();
  toast(kind === 'country' ? '已按地区重新分组' : '已按协议重新分组', 'ok');
}

function clearGroups() {
  if (!state.nodes.some((n) => n.group)) return toast('当前没有分组', 'err');
  if (!confirm('清除全部分组？节点会归入「未分组」，不会被删除。')) return;
  for (const node of state.nodes) node.group = '';
  state.filters.group = 'all';
  saveNodes();
  applyFilters();
  toast('已清除全部分组', 'ok');
}

function exportGroup(name) {
  const list = state.nodes.filter((n) => (n.group || '') === name && n.status !== 'idle');
  const src = list.length ? list : state.nodes.filter((n) => (n.group || '') === name);
  if (!src.length) return toast('该分组没有节点', 'err');
  const content = src.map((n) => n.raw || `${n.type}://${n.server}:${n.port}`).join('\n');
  window.api
    .exportFile({ format: 'txt', content, defaultName: `iphealth-${name || 'ungrouped'}` })
    .then((r) => {
      if (r && r.ok) toast('已导出到 ' + r.path, 'ok');
    });
}

/* ---- 移动到分组面板 ---- */
function renderMoveGroupPanel() {
  const groups = [...new Set(state.nodes.map((n) => n.group || ''))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh'));
  const items = groups.map((g) => {
    const c = state.nodes.filter((n) => (n.group || '') === g).length;
    return `<button class="move-item" data-move="${esc(g)}">${esc(g)}<span class="sb-num">${c}</span></button>`;
  });
  $('#moveGroupList').innerHTML =
    items.join('') +
    `<button class="move-item" data-move="">未分组</button>
     <div class="fsep"></div>
     <button class="move-item" data-move="__new__" style="color:var(--accent)">＋ 新建分组…</button>
     <div class="fsep"></div>
     <button class="move-item" data-auto-group="country">按地区自动分组</button>
     <button class="move-item" data-auto-group="type">按协议自动分组</button>`;
}

/** 一键按地区 / 协议重新分组（IPHealth 的「自动分组」，省得手动一个个拖） */
function autoGroupBy(kind) {
  if (!state.nodes.length) return toast('还没有节点', 'err');
  let changed = 0;
  state.nodes.forEach((n) => {
    let g = '';
    if (kind === 'country') {
      g = n.country || n.countryCode || '未知地区';
    } else {
      g = TYPE_LABEL[n.type] || n.type || '未知协议';
    }
    if (n.group !== g) changed += 1;
    n.group = g;
  });
  saveNodes();
  renderAll();
  toast(`已按${kind === 'country' ? '地区' : '协议'}重新分组（${changed} 个节点变更）`, 'ok');
}

/* ---- 高级筛选面板 ---- */
function syncFilterPanel() {
  const f = state.filters;
  $('#fHealth').value = f.minHealth == null ? 0 : f.minHealth;
  $('#fHealthVal').textContent = f.minHealth == null ? '不限' : `≥ ${f.minHealth}`;
  $('#fLatency').value = f.maxLatency == null ? 3000 : f.maxLatency;
  $('#fLatencyVal').textContent = f.maxLatency == null ? '不限' : `≤ ${f.maxLatency}`;
  $('#fSpeed').value = f.minSpeed == null ? 0 : f.minSpeed;
  $('#fSpeedVal').textContent = f.minSpeed == null ? '不限' : `≥ ${f.minSpeed}`;
  $$('#fIpTypes .chip').forEach((c) => c.classList.toggle('active', f.ipTypes.includes(c.dataset.iptype)));
  $('#fDnsbl').checked = !!f.dnsblOnly;
  $('#fDnsblClean').checked = !!f.dnsblClean;
}

function bindFilterPanel() {
  $('#fHealth').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    state.filters.minHealth = v === 0 ? null : v;
    $('#fHealthVal').textContent = v === 0 ? '不限' : `≥ ${v}`;
    scheduleApplyFilters();
  });
  $('#fLatency').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    state.filters.maxLatency = v >= 3000 ? null : v;
    $('#fLatencyVal').textContent = v >= 3000 ? '不限' : `≤ ${v}`;
    scheduleApplyFilters();
  });
  $('#fSpeed').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    state.filters.minSpeed = v === 0 ? null : v;
    $('#fSpeedVal').textContent = v === 0 ? '不限' : `≥ ${v}`;
    scheduleApplyFilters();
  });
  $$('#fIpTypes .chip').forEach((c) => {
    c.addEventListener('click', () => {
      toggleFacet('ipTypes', c.dataset.iptype);
      syncFilterPanel();
    });
  });
  $('#fDnsbl').addEventListener('change', (e) => {
    state.filters.dnsblOnly = e.target.checked;
    if (e.target.checked) {
      state.filters.dnsblClean = false;
      $('#fDnsblClean').checked = false;
    }
    applyFilters();
  });
  $('#fDnsblClean').addEventListener('change', (e) => {
    state.filters.dnsblClean = e.target.checked;
    if (e.target.checked) {
      state.filters.dnsblOnly = false;
      $('#fDnsbl').checked = false;
    }
    applyFilters();
  });
  $('#btnResetFilter').addEventListener('click', resetFilters);
}

/* ------------------------------------------------------------------ */
/* 导入                                                                */
/* ------------------------------------------------------------------ */

function openModal(id) { $('#' + id).classList.add('open'); }
function closeModal(id) { $('#' + id).classList.remove('open'); }

function mergeNodes(incoming) {
  const dedupe = $('#dedupeCheck').checked;
  const keyOf = (n) => `${n.type}|${String(n.server).toLowerCase()}|${n.port}`;
  const existing = new Set(state.nodes.map(keyOf));
  const added = [];
  for (const n of incoming) {
    const k = keyOf(n);
    if (dedupe && existing.has(k)) continue;
    existing.add(k);
    if (!n.name) n.name = `${n.server}:${n.port}`;
    added.push(n);
  }
  state.nodes = state.nodes.concat(added);
  saveNodes();
  renderTable();
  return added.length;
}

/* ------------------------------------------------------------------ */
/* 订阅源：登记 / 更新                                                */
/* ------------------------------------------------------------------ */

function saveSources() {
  window.api.setStore('sources', state.sources);
}

/** 登记一个订阅源（已存在则刷新节点数与时间） */
function registerSource(url, group, count, format) {
  if (!url) return null;
  let src = state.sources.find((x) => x.url === url);
  if (!src) {
    src = {
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      url,
      group: group || '',
      count: count || 0,
      format: format || '',
      lastSync: Date.now(),
      addedAt: Date.now(),
      error: '',
    };
    state.sources.push(src);
  } else {
    src.count = count != null ? count : src.count;
    src.format = format || src.format;
    src.lastSync = Date.now();
    src.error = '';
  }
  saveSources();
  renderSources();
  return src;
}

/** 合并某订阅源的最新节点（实现见 merge.js） */
function mergeFromSource(src, incoming, removeGone) {
  return window.IPHMerge.mergeFromSource(state, src, incoming, removeGone);
}

async function syncSources(list) {
  if (state.syncing) return toast('正在更新中，请稍候', 'err');
  if (state.running) toast('检测进行中，更新订阅会与检测抢带宽，测速结果可能偏低', 'warn', 4000);
  if (!list || !list.length) {
    return toast('没有可更新的订阅源，请先在「导入代理 → 订阅地址」添加', 'err');
  }
  const removeGone = $('#syncRemoveGone').checked;

  state.syncing = true;
  updateSyncButtons();
  let added = 0;
  let updated = 0;
  let removed = 0;
  let viaNodeCount = 0;
  const failures = [];

  // 拉取并行（网络 IO 才是瓶颈），合并仍串行 —— 并发改 state.nodes 会互相覆盖
  let done = 0;
  const fetched = await Promise.all(
    list.map(async (src) => {
      try {
        const res = await window.api.fetchSubscription(src.url);
        return { src, res, err: null };
      } catch (e) {
        return { src, res: null, err: e };
      } finally {
        done += 1;
        $('#statusText').textContent = `正在更新订阅 ${done}/${list.length}`;
        $('#progressBar').style.width = `${Math.round((done / list.length) * 100)}%`;
      }
    })
  );

  for (const item of fetched) {
    const src = item.src;
    try {
      if (item.err) throw item.err;
      const res = item.res;
      if (!res || !res.nodes || !res.nodes.length) throw new Error('未解析到节点');
      if (res.viaNode) viaNodeCount += 1;
      const r = mergeFromSource(src, res.nodes, removeGone);
      added += r.added;
      updated += r.updated;
      removed += r.removed;
      src.count = res.nodes.length;
      src.lastSync = Date.now();
      src.format = res.format || src.format;
      src.error = '';
    } catch (e) {
      failures.push({ src, error: e.message || String(e) });
      src.error = e.message || String(e);
    }
    renderSources();
    saveSources();
  }

  state.syncing = false;
  updateSyncButtons();
  saveNodes();
  renderTable();
  $('#progressBar').style.width = '100%';
  setTimeout(() => {
    if (!state.running && !state.syncing) $('#progressBar').style.width = '0';
  }, 900);

  const viaNote = viaNodeCount ? `（其中 ${viaNodeCount} 个订阅经可用节点拉取）` : '';
  const summary = `更新完成：新增 ${added} · 更新 ${updated} · 移除 ${removed}${viaNote}`;
  $('#statusText').textContent = summary;
  if (failures.length) {
    toast(`${summary}；${failures.length} 个订阅源失败：${failures[0].error}`, 'err');
  } else {
    toast(summary, 'ok');
  }
  return { added, updated, removed, failures };
}

function updateSyncButtons() {
  const on = state.syncing || state.running;
  $('#btnSync').disabled = on;
  $('#btnSyncMenu').disabled = on;
  $('#btnSyncAllInModal').disabled = on;
  $('#btnSync').classList.toggle('busy', on);
  $('#btnSyncAllInModal').textContent = on ? '更新中…' : '更新全部';
}

function renderSources() {
  const box = $('#srcList');
  if (!box) return;
  if (!state.sources.length) {
    box.innerHTML = `<div class="src-empty">还没有订阅源<br/>在「导入代理 → 订阅地址」导入订阅后，会自动登记在这里</div>`;
    return;
  }
  box.innerHTML = state.sources
    .map((src) => {
      const name = src.group || (() => {
        try {
          return new URL(src.url).hostname;
        } catch (e) {
          return '订阅源';
        }
      })();
      const last = src.lastSync ? new Date(src.lastSync).toLocaleString('zh-CN') : '未更新';
      const err = src.error ? `<div class="src-meta" style="color:var(--bad)">${esc(src.error)}</div>` : '';
      return `<div class="src-item" data-src="${src.id}">
        <div class="src-main">
          <div class="src-name">${esc(name)}<span class="src-count">${src.count || 0} 个节点</span></div>
          <div class="src-url" title="${esc(src.url)}">${esc(src.url)}</div>
          <div class="src-meta">上次更新：${last}${src.format ? ' · ' + esc(src.format) : ''}</div>
          ${err}
        </div>
        <div class="src-actions">
          <button class="btn btn-mini" data-src-act="sync" data-src-id="${src.id}">更新</button>
          <button class="icon-mini" data-src-act="del" data-src-id="${src.id}" title="移除订阅源（不删除节点）">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>`;
    })
    .join('');
}

function switchTab(tab) {
  state.importTab = tab;
  $$('#importTabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
}

async function doImport() {
  const tab = state.importTab;
  try {
    if (tab === 'batch') {
      const text = $('#batchInput').value;
      if (!text.trim()) return toast('请先粘贴代理链接', 'err');
      const res = await window.api.parseImport(text, { plainType: state.settings.plainType });
      if (!res.nodes.length) {
        return toast('没有解析到有效节点' + (res.errors.length ? `：${res.errors[0].error}` : ''), 'err');
      }
      const added = mergeNodes(res.nodes);
      toast(`已识别 ${res.format || '链接列表'}：导入 ${added} 个节点${res.errors.length ? `，${res.errors.length} 行无法识别` : ''}`, 'ok');
      $('#batchInput').value = '';
      updateBatchCount();
      closeModal('importModal');
    } else if (tab === 'sub') {
      const url = $('#subUrl').value.trim();
      if (!url) return toast('请填写订阅链接', 'err');
      $('#subResult').className = 'sub-result';
      $('#subResult').textContent = '正在拉取订阅…';
      const res = await window.api.fetchSubscription(url);
      if (!res.nodes.length) {
        $('#subResult').className = 'sub-result err';
        $('#subResult').textContent = res.errors && res.errors.length
          ? '订阅内容无法解析：' + res.errors[0].error
          : '订阅内容中未找到可识别的节点';
        return;
      }
      const added = mergeNodes(res.nodes);
      registerSource(url, new URL(url).hostname, res.nodes.length, res.format);
      $('#subResult').className = 'sub-result ok';
      const via = res.viaNode
        ? `，经节点「${res.viaNode.name}」拉取`
        : res.viaProxy
          ? res.autoProxy
            ? `，已自动借用本机代理 ${res.viaProxy}`
            : `，经代理 ${res.viaProxy}`
          : '';
      $('#subResult').textContent = `订阅解析成功（${res.format || '未知格式'}）：识别 ${res.nodes.length} 个节点，新增 ${added} 个${via}，已登记为订阅源`;
      toast(`订阅导入成功，新增 ${added} 个节点${res.viaNode ? '（经节点拉取）' : ''}`, 'ok');
      closeModal('importModal');
    } else if (tab === 'single') {
      const text = $('#singleInput').value.trim();
      if (!text) return toast('请填写代理链接', 'err');
      const res = await window.api.parseImport(text, {
        plainType: $('#plainType').value,
        allowHttpProxy: true,
      });
      if (!res.nodes.length) {
        $('#singleResult').className = 'sub-result err';
        $('#singleResult').textContent = res.errors.length ? '解析失败：' + res.errors[0].error : '无法识别的代理格式';
        return;
      }
      const name = $('#singleName').value.trim();
      if (name) res.nodes[0].name = name;
      const added = mergeNodes(res.nodes);
      $('#singleResult').className = 'sub-result ok';
      $('#singleResult').textContent = added ? `已添加：${res.nodes[0].name}` : '该节点已存在（已按去重规则跳过）';
      if (added) {
        $('#singleInput').value = '';
        $('#singleName').value = '';
        toast('节点已添加', 'ok');
      }
    } else if (tab === 'file') {
      const res = await window.api.importFile();
      if (!res) return;
      if (!res.nodes.length) {
        $('#fileResult').className = 'sub-result err';
        $('#fileResult').textContent = '文件中未找到可识别的节点';
        return;
      }
      const added = mergeNodes(res.nodes);
      $('#fileResult').className = 'sub-result ok';
      $('#fileResult').textContent = `${res.file}：识别 ${res.nodes.length} 个节点，新增 ${added} 个`;
      toast(`文件导入成功，新增 ${added} 个节点`, 'ok');
      closeModal('importModal');
    }
  } catch (e) {
    toast('导入失败：' + (e.message || e), 'err');
    const box = state.importTab === 'sub' ? $('#subResult') : null;
    if (box) {
      box.className = 'sub-result err';
      box.textContent = e.message || String(e);
    }
  }
}

function updateBatchCount() {
  const v = $('#batchInput').value;
  const n = v.split(/\r?\n/).filter((l) => l.trim()).length;
  $('#batchCount').textContent = n + ' 行';
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

function setRunning(on) {
  state.running = on;
  $('#btnTestAll').disabled = on;
  $('#btnTestMenu').disabled = on;
  $('#btnImport').disabled = on;
  $('#btnSync').disabled = on;
  $('#btnSyncMenu').disabled = on;
  $('#btnStop').disabled = !on;
  $('#statusText').textContent = on ? '检测中…' : '就绪';
  if (!on) {
    $('#progressBar').style.width = '100%';
    setTimeout(() => { if (!state.running) $('#progressBar').style.width = '0'; }, 800);
  }
}

async function runTest(mode, onlySelected, scope) {
  if (state.running) return toast('已有检测任务在进行', 'err');
  // 允许并行：订阅更新走主进程 HTTP，检测走独立内核实例，互不冲突（只是抢带宽）
  if (state.syncing) toast('订阅正在更新，检测结果可能受带宽影响', 'warn', 4000);
  let targets;
  if (scope === 'pending') {
    targets = state.nodes.filter((n) => n.status === 'idle' || n.status === 'testing');
  } else if (scope === 'failed') {
    targets = state.nodes.filter((n) => n.status === 'fail');
  } else {
    targets = onlySelected ? state.nodes.filter((n) => state.selected.has(n.id)) : state.nodes.slice();
  }
  if (!targets.length) {
    const msg = scope === 'pending' ? '没有未检测的节点' : scope === 'failed' ? '没有失败的节点' : onlySelected ? '请先选择节点' : '没有可检测的节点';
    return toast(msg, 'err');
  }

  targets.forEach((n) => {
    n.status = 'testing';
    n.error = '';
    updateRow(n);
  });
  state.progress = { finished: 0, total: targets.length };
  setRunning(true);
  $('#progressBar').style.width = '0%';
  $('#statusText').textContent = `准备检测 ${targets.length} 个节点…`;

  const payload = {
    nodes: targets.map((n) => ({
      id: n.id,
      name: n.name,
      type: n.type,
      server: n.server,
      port: n.port,
      conf: n.conf,
    })),
    mode,
    settings: state.settings,
  };

  const res = await window.api.runTest(payload);
  setRunning(false);
  if (res && res.error) toast(res.error, 'err');
  else toast(`检测完成：${state.progress.finished}/${state.progress.total}`, 'ok');
  saveNodes();
  updateStats();
}

function handleTestEvent(ev) {
  if (ev.type === 'run-start') {
    state.progress = { finished: 0, total: ev.total };
  } else if (ev.type === 'phase') {
    if (ev.phase === 'starting-core') $('#statusText').textContent = `正在启动内核（${ev.count} 个节点）…`;
    else if (ev.phase === 'geo') $('#statusText').textContent = '正在查询 IP 归属地与黑名单…';
    else $('#statusText').textContent = '正在检测节点…';
  } else if (ev.type === 'core-error') {
    toast('内核错误：' + ev.error, 'err');
  } else if (ev.type === 'node') {
    const node = state.nodes.find((n) => n.id === ev.id);
    if (!node) return;
    Object.assign(node, ev.patch);
    updateRow(node);
    if (!ev.silent) {
      state.progress.finished = ev.finished;
      const pct = ev.total ? Math.round((ev.finished / ev.total) * 100) : 0;
      $('#progressBar').style.width = pct + '%';
      $('#statusText').textContent = `检测中 ${ev.finished}/${ev.total} · ${node.name}`;
      updateStats();
    } else {
      updateStats();
    }
  } else if (ev.type === 'run-end') {
    $('#statusText').textContent = ev.aborted ? '已停止' : `检测完成 ${ev.finished}/${ev.total}`;
    $('#progressBar').style.width = '100%';
    updateStats();
  }
}

/* ------------------------------------------------------------------ */
/* 详情抽屉                                                            */
/* ------------------------------------------------------------------ */

function openDrawer(id) {
  const n = state.nodes.find((x) => x.id === id);
  if (!n) return;
  $('#drawerTitle').textContent = n.name || n.server;
  $('#drawerSub').innerHTML = `<span class="badge ${n.type}">${esc(TYPE_LABEL[n.type] || n.type)}</span>
    <span style="margin-left:6px">${esc(n.server)}:${n.port}</span>`;

  const kv = (k, v) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const pills = [];
  if (n.proxyFlag) pills.push('<span class="pill warn">代理特征</span>');
  if (n.hostingFlag) pills.push('<span class="pill warn">机房 IP</span>');
  if (n.mobileFlag) pills.push('<span class="pill ok">移动网络</span>');
  if (n.ipType) {
    const why = (n.ipTypeReasons || []).join('；');
    const conf = n.ipTypeConfidence ? `（置信度 ${n.ipTypeConfidence}%）` : '';
    pills.push(`<span class="pill" title="${esc(why + conf)}">${esc(n.ipType)}</span>`);
  }
  if (n.dnsbl && n.dnsbl.length) pills.push(`<span class="pill bad">黑名单: ${esc(n.dnsbl.join('/'))}</span>`);
  else if (n.dnsbl && n.dnsbl.length === 0) pills.push('<span class="pill ok">未命中黑名单</span>');

  const confJson = JSON.stringify(n.conf, null, 2);

  const reasonPills = (n.healthReasons || []).map((r) => `<span class="pill">${esc(r)}</span>`).join('');

  $('#drawerBody').innerHTML = `
    <div class="pill-row">${pills.join('') || '<span class="pill">未检测</span>'}</div>
    <div class="drawer-actions">
      <button class="btn btn-primary btn-mini" data-act="use" data-id="${n.id}">
        ${proxyInUseId() === n.id ? '系统代理使用中' : state.proxy && state.proxy.on ? '切换系统代理到此节点' : '设为系统代理'}
      </button>
    </div>
    ${reasonPills ? `<div class="section-title">健康度依据</div><div class="pill-row">${reasonPills}</div>` : ''}
    <div class="section-title">检测结果</div>
    <div>
      ${kv('健康度', n.health != null ? `<b style="color:${healthColor(n.health)}">${n.health} · ${healthText(n.health)}</b>` : '—')}
      ${kv('状态', n.status === 'ok' ? '<span style="color:var(--ok)">可用</span>' : n.status === 'fail' ? `<span style="color:var(--bad)">失败 ${esc(n.error || '')}</span>` : '未检测')}
      ${kv('TCP 握手', n.tcp != null ? n.tcp + ' ms' : '—')}
      ${kv('代理延迟', n.latency != null ? n.latency + ' ms' : '—')}
      ${kv('抖动', n.jitter != null ? n.jitter + ' ms' : '—')}
      ${kv('下载速度', n.speed != null ? n.speed.toFixed(2) + ' Mbps' : '—')}
      ${kv('检测时间', n.testedAt ? new Date(n.testedAt).toLocaleString('zh-CN') : '—')}
      ${n.group ? kv('来源分组', esc(n.group)) : ''}
    </div>
    <div class="section-title">出口 IP</div>
    <div>
      ${kv('IP 地址', n.ip ? `<span class="mono" style="user-select:text">${esc(n.ip)}</span>` : '—')}
      ${kv('国家 / 地区', n.country ? `${flagEmoji(n.countryCode)} ${esc(n.country)}` : '—')}
      ${kv('城市', esc(n.city || '—'))}
      ${kv('ISP', esc(n.isp || '—'))}
      ${kv('ASN', esc(n.asn || '—'))}
    </div>
    <div class="section-title">节点配置</div>
    <div class="code-block">${esc(confJson)}</div>
    ${n.raw ? `<div class="section-title">原始链接</div><div class="code-block">${esc(n.raw)}</div>` : ''}
  `;
  $('#drawer').classList.add('open');
  $('#drawerMask').classList.add('open');
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawerMask').classList.remove('open');
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

function buildExport(format) {
  const nodes = sortedNodes().filter((n) => n.status !== 'idle');
  const list = nodes.length ? nodes : state.nodes;
  if (format === 'json') {
    return JSON.stringify(
      list.map((n) => ({
        name: n.name, type: n.type, server: n.server, port: n.port,
        status: n.status, latency: n.latency, jitter: n.jitter, speed: n.speed,
        ip: n.ip, country: n.country, countryCode: n.countryCode, city: n.city,
        isp: n.isp, asn: n.asn, ipType: n.ipType, health: n.health,
        dnsbl: n.dnsbl, testedAt: n.testedAt, raw: n.raw,
      })),
      null,
      2
    );
  }
  if (format === 'txt') {
    return list.map((n) => n.raw || `${n.type}://${n.server}:${n.port}`).join('\n');
  }
  const head = ['名称', '协议', '服务器', '端口', '状态', '延迟(ms)', '抖动(ms)', '速度(Mbps)', '出口IP', '国家', '城市', 'ISP', 'ASN', 'IP类型', '健康度', '黑名单'];
  const rows = list.map((n) => [
    n.name, n.type, n.server, n.port,
    n.status === 'ok' ? '可用' : n.status === 'fail' ? '失败' : '未测',
    n.latency == null ? '' : n.latency,
    n.jitter == null ? '' : n.jitter,
    n.speed == null ? '' : n.speed,
    n.ip, n.country, n.city, n.isp, n.asn, n.ipType,
    n.health == null ? '' : n.health,
    (n.dnsbl || []).join('/'),
  ]);
  const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  return '\ufeff' + csv;
}

/* ------------------------------------------------------------------ */
/* 系统代理                                                            */
/* ------------------------------------------------------------------ */

/** 当前正被系统代理使用的节点 id（内核在跑才算） */
function proxyInUseId() {
  const g = state.proxy && state.proxy.gateway;
  return g && g.running && g.node ? g.node.id : null;
}

/** 顶部按钮要作用于哪个节点：优先「只勾选了一个」，否则用正在使用的，否则列表唯一节点 */
function pickProxyNode() {
  if (state.selected.size === 1) return [...state.selected][0];
  const inUse = proxyInUseId();
  if (inUse) return inUse;
  if (state.nodes.length === 1) return state.nodes[0].id;
  if (state.selected.size > 1) return [...state.selected][0];
  return null;
}

const ROUTE_LABEL = { global: '全局代理', 'bypass-cn': '绕过大陆', 'proxy-list': '仅名单代理' };

function currentRouteMode() {
  const s = state.proxy || {};
  return s.routeMode || state.settings.routeMode || 'global';
}

function renderProxyState(st) {
  if (st) state.proxy = st;
  const s = state.proxy || {};
  const on = !!s.on;
  const gw = s.gateway || {};
  const node = gw.node;
  const routeMode = currentRouteMode();
  const routeLabel = ROUTE_LABEL[routeMode] || '全局代理';
  const pstate = s.state || (on ? 'on' : 'off');

  const btn = $('#btnProxy');
  btn.classList.toggle('on', on);
  btn.disabled = !state.nodes.length || state.proxyBusy;
  $('#btnProxyText').textContent = on ? (gw.tunMode ? `TUN :${gw.port}` : `代理 :${gw.port}`) : '系统代理';
  btn.title = on ? `系统代理已开启 → 127.0.0.1:${gw.port}（${routeLabel}），点击关闭` : '把选中的节点设为系统代理';

  const badge = $('#proxyBadge');
  badge.classList.toggle('ok', pstate === 'on');
  badge.classList.toggle('warn', pstate === 'hijacked' || pstate === 'foreign');
  badge.classList.toggle('err', pstate === 'orphan' || pstate === 'starting');
  badge.dataset.state = pstate;

  // 徽标文案：每种异常态都要一眼看懂
  const probe = gw.lastProbe;
  let text;
  if (pstate === 'on') {
    text = `${gw.tunMode ? 'TUN 全局' : '系统代理'} · ${routeLabel}`;
    if (probe) text += probe.ok ? ` · ${probe.ip}` : ' · 链路异常';
  } else if (pstate === 'starting') {
    text = '系统代理 启动中…';
  } else if (pstate === 'hijacked') {
    text = '系统代理 被外部修改';
  } else if (pstate === 'orphan') {
    text = '系统代理 已失联';
  } else if (pstate === 'foreign') {
    text = '系统代理 指向其它地址';
  } else {
    text = '系统代理 已关闭';
  }
  $('#proxyBadgeText').textContent = text;

  // 悬浮提示：完整说清「怎么了 + 怎么办」
  const lines = [];
  if (pstate === 'on') {
    lines.push(`✅ 已生效：系统流量 → 127.0.0.1:${gw.port}`);
    lines.push(`出口节点：${node ? node.name || node.server : '—'}`);
    lines.push(`分流：${routeLabel}`);
    if (gw.uptime) lines.push(`已运行：${formatDuration(gw.uptime)}`);
    if (probe) {
      lines.push(probe.ok ? `链路探测：正常 · 出口 IP ${probe.ip}${probe.ms ? ` · ${probe.ms}ms` : ''}` : `链路探测：失败（${probe.error}）`);
    }
    lines.push('点击关闭并还原系统代理');
  } else if (pstate === 'hijacked') {
    lines.push('⚠️ 系统代理已开启，但被其它程序改动');
    lines.push(`当前指向：${(s.system && s.system.server) || '未设置'}`);
    lines.push(`本工具网关：127.0.0.1:${gw.port}（内核仍在运行）`);
    lines.push('点击重新接管系统代理');
  } else if (pstate === 'orphan') {
    lines.push('⚠️ 危险：系统代理仍指向本工具，但内核已退出');
    lines.push(`当前指向：${(s.system && s.system.server) || '—'}`);
    lines.push('此状态下可能无法上网，点击可关闭并还原');
  } else if (pstate === 'foreign') {
    lines.push('系统代理已开启，但指向的是其它地址（非本工具）');
    lines.push(`当前指向：${(s.system && s.system.server) || '—'}`);
    lines.push('开启本工具代理后会被接管');
  } else if (pstate === 'starting') {
    lines.push('内核正在启动或暂时无响应…');
  } else {
    lines.push('系统代理未开启');
    lines.push('点击把选中节点设为系统代理');
  }
  if (s.hint && pstate !== 'off' && pstate !== 'on') lines.push('— ' + s.hint);
  badge.title = lines.join('\n');

  // 分流方式菜单的选中态
  $$('#proxyMenu [data-route]').forEach((el) => {
    el.classList.toggle('active', el.dataset.route === routeMode);
  });

  // 只有「使用中的节点」变化时才重绘表格，避免每次状态推送都闪一下
  const sig = `${on}|${gw.port}|${node ? node.id : ''}`;
  if (state.__proxySig !== sig) {
    state.__proxySig = sig;
    if (state.nodes.length) renderTable();
  }
}

/** 秒 → 1h 02m / 3m 20s */
function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

/** 切换分流方式：已开启时立即生效（重启内核，端口与系统代理都不动） */
async function setRouteMode(mode) {
  if (!ROUTE_LABEL[mode]) return;
  if (state.proxyBusy) return;
  state.settings.routeMode = mode;
  await window.api.setStore('settings', state.settings);

  if (!(state.proxy && state.proxy.on)) {
    state.proxy = { ...(state.proxy || {}), routeMode: mode };
    renderProxyState();
    return toast(`分流方式：${ROUTE_LABEL[mode]}（开启系统代理后生效）`, 'ok');
  }

  state.proxyBusy = true;
  renderProxyState();
  setStatus(`正在切换分流方式：${ROUTE_LABEL[mode]}…`);
  try {
    const st = await window.api.proxyRoute(mode);
    if (st && st.error) {
      toast('切换失败：' + st.error, 'err');
      return;
    }
    renderProxyState(st);
    toast(`分流方式已切换：${ROUTE_LABEL[mode]}`, 'ok');
    setStatus(`系统代理 · ${ROUTE_LABEL[mode]}`);
    window.api.proxyProbe().then((r) => {
      if (r && r.ok) toast(`链路可用，出口 IP ${r.ip}`, 'ok');
      else if (r) toast('链路校验失败：' + (r.error || ''), 'err');
    });
  } finally {
    state.proxyBusy = false;
    renderProxyState();
  }
}

async function refreshProxyState() {
  const st = await window.api.proxyStatus();
  if (st && !st.error) renderProxyState(st);
  return st;
}

async function enableSystemProxyById(id, mode) {
  const n = state.nodes.find((x) => x.id === id);
  if (!n) return toast('找不到该节点', 'err');
  if (state.proxyBusy) return;
  state.proxyBusy = true;
  renderProxyState();
  const label = mode === 'tun' ? 'TUN 全局接管' : '系统代理';
  setStatus(`正在启动${label}：${n.name || n.server}…`);
  try {
    const st = await window.api.proxyEnable(id, mode || 'system');
    if (st && st.error) {
      toast('开启失败：' + st.error, 'err');
      setStatus('系统代理开启失败');
      return;
    }
    renderProxyState(st);
    toast(`系统代理已开启 → 127.0.0.1:${st.gateway.port}`, 'ok');
    setStatus(`系统代理已开启，出口节点：${n.name || n.server}`);
    // 机器上还开着别的代理软件时，系统代理可能被它们抢走或用 TUN 绕过 —— 直接说出来
    if (st.conflicts && st.conflicts.hasConflict) {
      toast('注意：' + st.conflicts.summary + '。它们可能抢走系统代理，建议先退出', 'warn', 8000);
    }
    // 后台校验真实出口 IP
    window.api.proxyProbe().then((r) => {
      if (r && r.ok) toast(`链路可用，出口 IP ${r.ip}`, 'ok');
      else if (r) toast('链路校验失败：' + (r.error || '未知原因'), 'err');
    });
  } finally {
    state.proxyBusy = false;
    renderProxyState();
  }
}

async function disableSystemProxy() {
  if (state.proxyBusy) return;
  state.proxyBusy = true;
  renderProxyState();
  setStatus('正在还原系统代理…');
  try {
    const st = await window.api.proxyDisable();
    if (st && st.error) return toast('关闭失败：' + st.error, 'err');
    renderProxyState(st);
    toast('系统代理已关闭，已还原原始设置', 'ok');
    setStatus('系统代理已关闭');
  } finally {
    state.proxyBusy = false;
    renderProxyState();
  }
}

/** 行内 / 抽屉里的「设为系统代理」：已开启时是切换节点（端口不变） */
async function useNodeAsProxy(id) {
  if (state.proxy && state.proxy.on) {
    if (proxyInUseId() === id) return toast('该节点已在系统代理中', '');
    state.proxyBusy = true;
    renderProxyState();
    try {
      const r = await window.api.proxySwitch(id);
      if (r && r.error) return toast('切换失败：' + r.error, 'err');
      renderProxyState(r);
      const n = state.nodes.find((x) => x.id === id);
      toast(`已切换系统代理出口：${(n && n.name) || id}`, 'ok');
      window.api.proxyProbe().then((p) => {
        if (p && p.ok) toast(`出口 IP ${p.ip}`, 'ok');
        else if (p) toast('链路校验失败：' + (p.error || ''), 'err');
      });
    } finally {
      state.proxyBusy = false;
      renderProxyState();
    }
    return;
  }
  return enableSystemProxyById(id);
}

async function toggleSystemProxy() {
  if (state.proxyBusy) return;
  const pstate = (state.proxy && state.proxy.state) || (state.proxy && state.proxy.on ? 'on' : 'off');

  // 失联态：内核已死但系统代理还指着它，优先抢救 —— 先还原系统代理
  if (pstate === 'orphan') {
    toast('检测到系统代理已失联，正在还原…', 'err');
    return disableSystemProxy();
  }
  // 被外部改动 / 指向别处：直接抢回来（重新 apply 会覆盖）
  if (pstate === 'hijacked' || pstate === 'foreign') {
    const id = pickProxyNode() || (state.proxy && state.proxy.gateway && state.proxy.gateway.node && state.proxy.gateway.node.id);
    if (!id) return toast('请先勾选一个节点，再接管系统代理', 'err');
    toast('正在重新接管系统代理…');
    return enableSystemProxyById(id);
  }
  if (state.proxy && state.proxy.on) return disableSystemProxy();

  const id = pickProxyNode();
  if (!id) return toast('请先勾选一个节点，或在行末点击「设为系统代理」', 'err');
  return enableSystemProxyById(id);
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

function fillSettings() {
  const s = state.settings;
  $('#setConcurrency').value = s.concurrency;
  $('#setLatencyTimeout').value = s.latencyTimeout;
  $('#setSpeedBytes').value = s.speedBytes;
  $('#setSpeedTimeout').value = s.speedTimeout;
  $('#setSpeedSource').value = s.speedSource;
  $('#setDeepHealth').checked = s.deepHealth !== false;
  $('#setLatencyUrls').value = (s.latencyUrls || []).join('\n');
  $('#setIpUrls').value = (s.ipUrls || []).join('\n');
  $('#setProxyPort').value = s.systemProxyPort || 7890;
  $('#setProxyBypass').value = s.systemProxyBypass || '';
  $('#setProxyWinhttp').checked = !!s.systemProxyWinhttp;
  $('#setSubProxy').value = s.subProxy || '';
  $('#setRouteMode').value = s.routeMode || 'global';
  $('#setProxyState').value =
    state.proxy && state.proxy.on ? `已开启 · 127.0.0.1:${state.proxy.gateway.port}` : '已关闭';
}

async function saveSettings() {
  const prevPort = state.settings.systemProxyPort;
  const prevRoute = state.settings.routeMode;
  state.settings = {
    ...state.settings,
    concurrency: Math.max(1, Math.min(32, parseInt($('#setConcurrency').value, 10) || 8)),
    latencyTimeout: Math.max(2000, parseInt($('#setLatencyTimeout').value, 10) || 8000),
    speedBytes: Math.max(1, Math.min(100, parseInt($('#setSpeedBytes').value, 10) || 10)),
    speedTimeout: Math.max(5000, parseInt($('#setSpeedTimeout').value, 10) || 20000),
    speedSource: $('#setSpeedSource').value,
    deepHealth: $('#setDeepHealth').checked,
    latencyUrls: $('#setLatencyUrls').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    ipUrls: $('#setIpUrls').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    systemProxyPort: Math.max(1024, Math.min(65535, parseInt($('#setProxyPort').value, 10) || 7890)),
    systemProxyBypass: $('#setProxyBypass').value.trim(),
    systemProxyWinhttp: $('#setProxyWinhttp').checked,
    subProxy: $('#setSubProxy').value.trim(),
    routeMode: $('#setRouteMode').value,
  };
  await window.api.setStore('settings', state.settings);
  applyTheme(state.settings.theme);
  closeModal('settingsModal');

  const on = state.proxy && state.proxy.on;
  if (on && prevRoute !== state.settings.routeMode) {
    await setRouteMode(state.settings.routeMode);
    return;
  }
  if (on && prevPort !== state.settings.systemProxyPort) {
    toast('端口已保存，重新开启系统代理后生效', 'ok');
  } else {
    toast('设置已保存', 'ok');
  }
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

async function init() {
  const info = await window.api.info();
  const badge = $('#coreBadge');
  if (info.coreFound) {
    badge.classList.add('ok');
    $('#coreText').textContent = info.coreVersion ? info.coreVersion.replace('mihomo ', '内核 ') : '内核就绪';
    $('#coreVersion').textContent = info.coreVersion || '内核就绪';
  } else {
    badge.classList.add('err');
    $('#coreText').textContent = '内核缺失';
    $('#coreVersion').textContent = '内核缺失';
  }

  // 窗口标题带版本号：任务栏悬停 / Alt+Tab 都能直接看到
  document.title = `V2PTools v${info.appVersion} · 代理体检与系统代理`;
  // 状态栏右下角也显示版本号（和 IPHealth 一致，方便确认装的是哪一版）
  const verEl = $('#appVersion');
  if (verEl) {
    verEl.textContent = 'v' + info.appVersion + (info.isPackaged ? '' : ' dev');
    verEl.title = `V2PTools ${info.appVersion} · Electron ${info.electron} · ${info.platform}/${info.arch}（点击打开设置）`;
    verEl.style.cursor = 'pointer';
    // 和 IPHealth 一样：点版本号直接进设置
    verEl.addEventListener('click', () => {
      fillSettings();
      openModal('settingsModal');
    });
  }

  $('#aboutBox').innerHTML = `
    <div><b>版本</b> ${info.appVersion} · Electron ${info.electron} · ${info.platform}/${info.arch}</div>
    <div><b>内核</b> <code>${esc(info.coreVersion || '未检测到')}</code></div>
    <div><b>内核路径</b> <code>${esc(info.corePath)}</code></div>
    <div><b>数据目录</b> <code>${esc(info.userData)}</code> <a href="#" id="openData" style="color:var(--accent)">打开</a></div>
  `;

  const settings = await window.api.getStore('settings');
  if (settings) state.settings = { ...state.settings, ...settings };
  fillSettings();
  $('#plainType').value = state.settings.plainType || 'socks5';

  applyTheme(state.settings.theme || 'dark');
  state.sidebarHidden = !!state.settings.sidebarHidden;
  applySidebarState();
  bindFilterUI();

  const nodes = await window.api.getStore('nodes');
  if (Array.isArray(nodes) && nodes.length) {
    state.nodes = nodes.map((n) => ({ ...n, status: n.status === 'testing' ? 'idle' : n.status }));
    renderTable();
  } else {
    renderTable();
  }

  const sources = await window.api.getStore('sources');
  if (Array.isArray(sources)) state.sources = sources;
  renderSources();

  window.api.onTestEvent(handleTestEvent);

  window.api.onProxyState((st) => renderProxyState(st));
  window.api.onProxyError((msg) => {
    toast(msg || '代理内核异常退出', 'err');
    refreshProxyState();
  });

  // 启动时主动告警：失联/被改动这类状态必须让用户第一眼就看到
  const st = await refreshProxyState();
  if (st && st.state === 'orphan') {
    toast('系统代理已失联（内核未运行），可能无法上网 —— 点击顶部徽标可还原', 'err', 12000);
  } else if (st && st.state === 'hijacked') {
    toast('系统代理被其它程序改动，本工具已不生效', 'err', 10000);
  } else if (st && st.state === 'foreign') {
    toast(`系统代理当前指向 ${st.system.server}，并非本工具`, 'warn', 8000);
  }
  // 别在上次异常退出后留下「失联」状态：直接帮忙还原
  if (st && st.state === 'orphan') {
    setTimeout(() => disableSystemProxy(), 800);
  }

  // 列宽拖拽：表头是静态的，绑定一次即可
  enableColumnResize();

  // 启动时自动更新订阅
  if (state.settings.autoSyncOnStart && state.sources.length) {
    setTimeout(() => syncSources(state.sources.slice()), 900);
  }
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

document.addEventListener('click', (e) => {
  const t = e.target;

  // 关闭弹窗
  const closer = t.closest('[data-close]');
  if (closer) closeModal(closer.dataset.close);
  if (t.classList && t.classList.contains('modal-mask')) t.classList.remove('open');

  // 菜单
  if (!t.closest('.btn-group')) $('#testMenu').classList.remove('open');
  if (!t.closest('.btn-group')) $('#syncMenu').classList.remove('open');
  if (!t.closest('#proxyMenu') && !t.closest('#btnProxyMenu')) $('#proxyMenu').classList.remove('open');

  // 筛选 / 分组弹层
  if (!t.closest('#filterPanel') && !t.closest('#btnFilter')) $('#filterPanel').classList.remove('open');
  if (!t.closest('#moveGroupPanel') && !t.closest('#btnMoveGroup')) $('#moveGroupPanel').classList.remove('open');
  if (!t.closest('#groupMenu') && !t.closest('#btnGroupMenu')) $('#groupMenu').classList.remove('open');
  if (!t.closest('.ctx-menu')) closeContextMenu();
});

$('#btnImport').addEventListener('click', () => {
  switchTab('batch');
  openModal('importModal');
  setTimeout(() => $('#batchInput').focus(), 60);
});
$('#btnEmptyImport').addEventListener('click', () => $('#btnImport').click());

$('#batchInput').addEventListener('input', updateBatchCount);

$$('#importTabs .tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

$('#btnDoImport').addEventListener('click', doImport);
$('#dropzone').addEventListener('click', async () => {
  const res = await window.api.importFile();
  if (!res) return;
  if (!res.nodes.length) {
    $('#fileResult').className = 'sub-result err';
    $('#fileResult').textContent = '文件中未找到可识别的节点';
    return;
  }
  const added = mergeNodes(res.nodes);
  $('#fileResult').className = 'sub-result ok';
  $('#fileResult').textContent = `识别 ${res.nodes.length} 个节点，新增 ${added} 个`;
  toast(`文件导入成功，新增 ${added} 个节点`, 'ok');
});

$('#btnSync').addEventListener('click', () => {
  if (!state.sources.length) {
    openSourcesModal();
    return toast('还没有订阅源，请先添加订阅链接', 'err');
  }
  syncSources(state.sources.slice());
});
$('#btnSyncMenu').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#testMenu').classList.remove('open');
  $('#syncMenu').classList.toggle('open');
});
$$('#syncMenu button').forEach((b) => {
  b.addEventListener('click', () => {
    $('#syncMenu').classList.remove('open');
    const act = b.dataset.sync;
    if (act === 'all') {
      if (!state.sources.length) {
        openSourcesModal();
        return toast('还没有订阅源，请先添加订阅链接', 'err');
      }
      syncSources(state.sources.slice());
    } else if (act === 'selected') {
      const urls = new Set();
      state.nodes.forEach((n) => {
        if (state.selected.has(n.id) && n.source) urls.add(n.source);
      });
      const list = state.sources.filter((src) => urls.has(src.url));
      if (!list.length) return toast('选中的节点不属于任何订阅源', 'err');
      syncSources(list);
    } else if (act === 'manage') {
      openSourcesModal();
    }
  });
});

$('#btnTestAll').addEventListener('click', () => runTest('full', false));
$('#btnTestMenu').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#syncMenu').classList.remove('open');
  $('#testMenu').classList.toggle('open');
});
$$('#testMenu button').forEach((b) => {
  b.addEventListener('click', () => {
    $('#testMenu').classList.remove('open');
    const mode = b.dataset.mode;
    const scope = b.dataset.scope;
    if (scope) runTest('full', false, scope);
    else if (mode === 'selected') runTest('full', true);
    else runTest(mode, false);
  });
});
$('#btnProxy').addEventListener('click', toggleSystemProxy);

$('#btnProxyMenu').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#proxyMenu').classList.toggle('open');
});

$('#btnTraffic').addEventListener('click', async () => {
  const on = await window.api.trafficToggle();
  toast(on ? '流量悬浮窗已打开' : '流量悬浮窗已关闭', 'ok', 2000);
});

$('#proxyMenu').addEventListener('click', (e) => {
  const modeBtn = e.target.closest('[data-proxymode]');
  if (modeBtn) {
    $('#proxyMenu').classList.remove('open');
    if (modeBtn.dataset.proxymode === 'tun') startTunMode();
    else {
      const id = pickProxyNode() || (state.proxy && state.proxy.gateway && state.proxy.gateway.node && state.proxy.gateway.node.id);
      if (!id) return toast('请先勾选一个节点', 'err');
      enableSystemProxyById(id, 'system');
    }
    return;
  }
  const item = e.target.closest('[data-route]');
  if (!item) return;
  $('#proxyMenu').classList.remove('open');
  setRouteMode(item.dataset.route);
});

/**
 * TUN 全局接管：先查 wintun / 管理员权限 / 是否已有其它虚拟网卡，
 * 任何一项不满足都不硬开 —— 建出第二张 TUN 会把用户的网络搞乱
 */
async function startTunMode() {
  const id = pickProxyNode() || (state.proxy && state.proxy.gateway && state.proxy.gateway.node && state.proxy.gateway.node.id);
  if (!id) return toast('请先勾选一个节点', 'err');

  setStatus('正在检查 TUN 环境…');
  let ready = null;
  try {
    ready = await window.api.tunCheck();
  } catch (e) {
    ready = { ok: false, reasons: [e.message] };
  }

  if (!ready || !ready.ok) {
    const reasons = (ready && ready.reasons) || ['未知原因'];
    if (ready && ready.hasWintun === false) {
      alert('无法开启 TUN：\n\n' + reasons.join('\n'));
    } else if (ready && !ready.admin) {
      const ok = confirm('TUN 模式需要管理员权限：\n\n' + reasons.join('\n') + '\n\n是否以管理员身份重启 V2PTools？');
      if (ok) {
        toast('正在以管理员身份重启…');
        await window.api.relaunchElevated();
      }
    } else {
      alert('无法开启 TUN 全局：\n\n' + reasons.join('\n'));
    }
    setStatus('');
    return;
  }

  return enableSystemProxyById(id, 'tun');
}

/** 链路自检：直连 IP vs 经代理 IP，一眼看出代理到底有没有生效 */
$('#menuProxyCheck').addEventListener('click', async (e) => {
  e.stopPropagation();
  $('#proxyMenu').classList.remove('open');
  $('#statusText').textContent = '正在做链路自检…';
  const r = await window.api.proxyCheck();
  const lines = [];
  lines.push(r.system.active ? `系统代理：${r.system.server || '已开启'}` : '系统代理：未开启');
  lines.push(r.gateway.running
    ? `内核：运行中，端口 ${r.gateway.port}（${r.gateway.routeLabel || '全局代理'}）`
    : '内核：未运行');
  lines.push(r.via && r.via.ok ? `经代理出口：${r.via.ip}` : `经代理出口：失败（${(r.via && r.via.error) || '未开启'}）`);
  lines.push(r.https && r.https.ok
    ? `HTTPS 经代理：通过（HTTP ${r.https.status}${r.https.ms ? ' · ' + r.https.ms + 'ms' : ''}）`
    : `HTTPS 经代理：失败（${(r.https && r.https.error) || '未开启'}）`);
  lines.push(r.direct && r.direct.ok ? `直连出口：${r.direct.ip}` : '直连出口：失败（可能本机无外网）');
  if (r.via && r.via.ok && r.direct && r.direct.ok) {
    lines.push('');
    lines.push(r.same ? '两个 IP 相同 → 流量没走代理，检查系统代理是否被其它软件改掉' : '两个 IP 不同 → 代理已生效');
  }
  if (r.via && r.via.ok && r.https && !r.https.ok) {
    lines.push('');
    lines.push('HTTP 通但 HTTPS 不通：多半是浏览器没走系统代理（扩展 / QUIC），或节点屏蔽了该站点');
  }
  if (r.conflicts && r.conflicts.hasConflict) {
    lines.push('');
    lines.push('⚠ 环境冲突：' + r.conflicts.summary);
    lines.push('这些软件会抢系统代理、或用 TUN 直接接管流量，建议先退出它们再试');
  }
  if (r.gateway.node) lines.push(`\n节点：${r.gateway.node.name}（${r.gateway.node.server}:${r.gateway.node.port}）`);
  alert(lines.join('\n'));
  $('#statusText').textContent = r.same ? '自检：代理未生效' : r.via && r.via.ok ? '自检：代理已生效' : '自检：代理链路异常';
});
$('#proxyBadge').addEventListener('click', toggleSystemProxy);

// 托盘菜单里的「开启 / 关闭系统代理」：复用同一套状态判断
if (window.api.onTrayToggleProxy) {
  window.api.onTrayToggleProxy(() => toggleSystemProxy());
}

$('#btnStop').addEventListener('click', async () => {
  await window.api.cancelTest();
  $('#statusText').textContent = '正在停止…';
});

function bindFilterUI() {
  bindSidebar();
  bindFilterPanel();
  syncFilterPanel();

  $('#btnFilter').addEventListener('click', (e) => {
    e.stopPropagation();
    syncFilterPanel();
    $('#moveGroupPanel').classList.remove('open');
    $('#filterPanel').classList.toggle('open');
  });

  $('#btnToggleSidebar').addEventListener('click', () => {
    state.sidebarHidden = !state.sidebarHidden;
    applySidebarState();
    state.settings.sidebarHidden = state.sidebarHidden;
    window.api.setStore('settings', state.settings);
  });

  $('#btnGroupMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#groupMenu').classList.toggle('open');
  });
  $$('#groupMenu button').forEach((b) => {
    b.addEventListener('click', () => {
      $('#groupMenu').classList.remove('open');
      const act = b.dataset.gact;
      if (act === 'new') newGroupFromSelection();
      else if (act === 'by-country') autoGroupBy('country');
      else if (act === 'by-type') autoGroupBy('type');
      else if (act === 'clear') clearGroups();
    });
  });

  $('#btnMoveGroup').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.selected.size) return toast('请先选择节点', 'err');
    renderMoveGroupPanel();
    $('#filterPanel').classList.remove('open');
    $('#moveGroupPanel').classList.toggle('open');
  });
  $('#moveGroupList').addEventListener('click', async (e) => {
    const ag = e.target.closest('[data-auto-group]');
    if (ag) {
      $('#moveGroupPanel').classList.remove('open');
      autoGroupBy(ag.dataset.autoGroup);
      return;
    }
    const b = e.target.closest('[data-move]');
    if (!b) return;
    const val = b.dataset.move;
    $('#moveGroupPanel').classList.remove('open');
    if (val === '__new__') {
      const name = await askText('新建分组', '', '输入分组名称');
      if (name) moveSelectedToGroup(name);
      return;
    }
    moveSelectedToGroup(val);
  });
}

function applySidebarState() {
  $('.main-row').classList.toggle('sidebar-hidden', !!state.sidebarHidden);
}

function openSourcesModal() {
  renderSources();
  $('#syncRemoveGone').checked = state.settings.syncRemoveGone !== false;
  $('#autoSyncOnStart').checked = !!state.settings.autoSyncOnStart;
  openModal('sourcesModal');
}

$('#btnSyncAllInModal').addEventListener('click', () => {
  if (!state.sources.length) return toast('还没有订阅源', 'err');
  syncSources(state.sources.slice());
});

$('#btnAddSource').addEventListener('click', async () => {
  const url = $('#srcNewUrl').value.trim();
  if (!url) return toast('请填写订阅链接', 'err');
  try {
    const res = await window.api.fetchSubscription(url);
    if (!res.nodes.length) return toast('订阅未解析到节点' + (res.errors.length ? '：' + res.errors[0].error : ''), 'err');
    const added = mergeNodes(res.nodes);
    registerSource(url, new URL(url).hostname, res.nodes.length, res.format);
    $('#srcNewUrl').value = '';
    renderTable();
    renderSources();
    toast(`订阅已添加：识别 ${res.nodes.length} 个节点，新增 ${added} 个`, 'ok');
  } catch (e) {
    toast('订阅添加失败：' + (e.message || e), 'err');
  }
});

$('#srcList').addEventListener('click', (e) => {
  const act = e.target.closest('[data-src-act]');
  if (!act) return;
  const src = state.sources.find((x) => x.id === act.dataset.srcId);
  if (!src) return;
  if (act.dataset.srcAct === 'sync') {
    syncSources([src]);
  } else if (act.dataset.srcAct === 'del') {
    state.sources = state.sources.filter((x) => x.id !== src.id);
    saveSources();
    renderSources();
    toast('已移除订阅源（节点仍保留在列表中）', 'ok');
  }
});

$('#syncRemoveGone').addEventListener('change', (e) => {
  state.settings.syncRemoveGone = e.target.checked;
  window.api.setStore('settings', state.settings);
});

$('#autoSyncOnStart').addEventListener('change', (e) => {
  state.settings.autoSyncOnStart = e.target.checked;
  window.api.setStore('settings', state.settings);
});

$('#btnSettings').addEventListener('click', () => {
  fillSettings();
  openModal('settingsModal');
});
$('#btnSaveSettings').addEventListener('click', saveSettings);

$('#btnTheme').addEventListener('click', async () => {
  applyTheme(state.settings.theme === 'light' ? 'dark' : 'light');
  await window.api.setStore('settings', state.settings);
});

$('#btnExport').addEventListener('click', async () => {
  const format = await chooseExportFormat();
  if (!format) return;

  // Clash 配置走独立通道：后端做格式转换 + 落盘
  if (format === 'clash') {
    // 与其它导出格式一致：优先已检测的节点，没有则用全部
    const tested = sortedNodes().filter((n) => n.status !== 'idle');
    const list = tested.length ? tested : sortedNodes();
    if (!list.length) return toast('当前没有可导出的节点', 'err');
    const r = await window.api.exportClash({
      nodes: list,
      defaultName: 'v2ptools-clash-' + new Date().toISOString().slice(0, 10),
      opts: {},
    });
    if (r && r.ok) toast(`已导出 ${r.count} 个节点 → ${r.path}`, 'ok');
    else if (r && !r.canceled) toast('导出失败：' + (r.error || '未知原因'), 'err');
    return;
  }

  const content = buildExport(format);
  const r = await window.api.exportFile({
    format,
    content,
    defaultName: 'v2ptools-' + new Date().toISOString().slice(0, 10),
  });
  if (r && r.ok) toast('已导出到 ' + r.path, 'ok');
});

function chooseExportFormat() {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask open';
    mask.style.zIndex = 150;
    mask.innerHTML = `
      <div class="modal" style="width:380px">
        <div class="modal-head"><div class="modal-title">导出检测结果</div></div>
        <div class="modal-body" style="gap:8px">
          <button class="btn" data-fmt="clash" style="justify-content:flex-start">Clash 配置（YAML，可直接给内核用）</button>
          <button class="btn" data-fmt="csv" style="justify-content:flex-start">CSV 表格（Excel 可直接打开）</button>
          <button class="btn" data-fmt="json" style="justify-content:flex-start">JSON（含完整字段）</button>
          <button class="btn" data-fmt="txt" style="justify-content:flex-start">原始链接（TXT）</button>
        </div>
      </div>`;
    mask.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fmt]');
      if (b) {
        mask.remove();
        resolve(b.dataset.fmt);
      } else if (e.target === mask) {
        mask.remove();
        resolve(null);
      }
    });
    document.body.appendChild(mask);
  });
}

$('#searchInput').addEventListener('input', (e) => {
  state.query = e.target.value.trim();
  applyFilters();
});

$$('#filterChips .chip').forEach((c) => {
  c.addEventListener('click', () => setStatusFilter(c.dataset.filter));
});

$$('.grid thead th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.sort.key === key) state.sort.dir *= -1;
    else state.sort = { key, dir: 1 };
    $$('.grid thead th').forEach((x) => x.classList.remove('sorted', 'asc'));
    th.classList.add('sorted');
    if (state.sort.dir === 1) th.classList.add('asc');
    renderTable();
  });
});

$('#checkAll').addEventListener('change', (e) => {
  if (e.target.checked) state.nodes.forEach((n) => state.selected.add(n.id));
  else state.selected.clear();
  renderTable();
});

$('#tbody').addEventListener('click', async (e) => {
  const check = e.target.closest('[data-check]');
  if (check) {
    const id = check.dataset.check;
    if (check.checked) state.selected.add(id);
    else state.selected.delete(id);
    const tr = check.closest('tr');
    tr.classList.toggle('selected', check.checked);
    updateSelInfo();
    return;
  }
  const act = e.target.closest('[data-act]');
  if (act) {
    const id = act.dataset.id;
    const n = state.nodes.find((x) => x.id === id);
    if (!n) return;
    if (act.dataset.act === 'del') {
      state.nodes = state.nodes.filter((x) => x.id !== id);
      state.selected.delete(id);
      saveNodes();
      renderTable();
    } else if (act.dataset.act === 'detail') {
      openDrawer(id);
    } else if (act.dataset.act === 'test') {
      if (state.running) return toast('已有检测任务在进行', 'err');
      state.selected.clear();
      state.selected.add(id);
      runTest('full', true);
    } else if (act.dataset.act === 'use') {
      useNodeAsProxy(id);
    }
    return;
  }
  const tr = e.target.closest('tr[data-id]');
  if (tr) openDrawer(tr.dataset.id);
});

$('#btnDeleteSel').addEventListener('click', () => {
  if (!state.selected.size) return;
  state.nodes = state.nodes.filter((n) => !state.selected.has(n.id));
  state.selected.clear();
  saveNodes();
  renderTable();
  toast('已删除选中节点', 'ok');
});

$('#btnClear').addEventListener('click', () => {
  if (!state.nodes.length) return;
  if (!confirm('确定要清空全部节点吗？此操作不可恢复。')) return;
  state.nodes = [];
  state.selected.clear();
  saveNodes();
  renderTable();
});

$('#drawerClose').addEventListener('click', closeDrawer);
$('#drawerMask').addEventListener('click', closeDrawer);

document.addEventListener('click', (e) => {
  if (e.target.id === 'openData') {
    e.preventDefault();
    window.api.openDataDir();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeDrawer();
    $$('.modal-mask.open').forEach((m) => m.classList.remove('open'));
    $('#testMenu').classList.remove('open');
    $('#syncMenu').classList.remove('open');
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
    e.preventDefault();
    $('#btnImport').click();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (state.importTab === 'batch') doImport();
  }
});

/* ------------------------------------------------------------------ */
/* 节点右键菜单                                                        */
/* ------------------------------------------------------------------ */

/** 复制分享链接：能生成就复制，不能生成时说明原因 */
async function copyShareLink(n) {
  const link = window.IPHShare ? window.IPHShare.toShareLink(n) : '';
  if (!link) {
    toast(`${TYPE_LABEL[n.type] || n.type} 暂不支持生成链接，可用「导出原始链接」`, 'err', 4000);
    return;
  }
  await window.api.copyText(link);
  toast('分享链接已复制', 'ok');
}

/** 分享节点：把链接摊开给人看（可全选复制），适合贴到聊天窗口 */
async function showShareLink(n) {
  const link = window.IPHShare ? window.IPHShare.toShareLink(n) : '';
  if (!link) {
    toast(`${TYPE_LABEL[n.type] || n.type} 暂不支持生成链接`, 'err', 4000);
    return;
  }
  await askText('分享节点链接（可全选复制）', link, '');
  await window.api.copyText(link);
  toast('已复制到剪贴板', 'ok');
}

function openNodeMenu(id, x, y) {
  const n = state.nodes.find((it) => it.id === id);
  if (!n) return;
  const link = window.IPHShare ? window.IPHShare.toShareLink(n) : '';
  showContextMenu(
    [
      { label: '节点详情', onClick: () => openDrawer(id) },
      { label: link ? '复制分享链接' : '复制分享链接（该协议暂不支持）', onClick: () => copyShareLink(n) },
      { label: '分享节点（查看链接）…', onClick: () => showShareLink(n) },
      { label: n.ip ? `复制出口 IP（${n.ip}）` : '复制出口 IP（未检测）', onClick: () => (n.ip ? window.api.copyText(n.ip).then(() => toast('已复制 ' + n.ip, 'ok')) : toast('还没有出口 IP，先检测一次', 'err')) },
      '-',
      {
        label: '仅检测此节点',
        onClick: () => {
          if (state.running) return toast('已有检测任务在进行', 'err');
          state.selected.clear();
          state.selected.add(id);
          runTest('full', true);
        },
      },
      {
        label: '重命名…',
        onClick: async () => {
          const name = await askText('重命名节点', n.name || '', '输入新的节点名');
          if (!name) return;
          n.name = name;
          saveNodes();
          renderTable();
          toast('已重命名', 'ok');
        },
      },
      {
        label: '移动到分组…',
        onClick: () => {
          state.selected.clear();
          state.selected.add(id);
          renderMoveGroupPanel();
          $('#filterPanel').classList.remove('open');
          $('#moveGroupPanel').classList.add('open');
        },
      },
      '-',
      {
        label: '删除节点',
        danger: true,
        onClick: () => {
          state.nodes = state.nodes.filter((it) => it.id !== id);
          state.selected.delete(id);
          saveNodes();
          renderTable();
          toast('已删除节点', 'ok');
        },
      },
    ],
    x,
    y
  );
}

$('#tbody').addEventListener('contextmenu', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  e.preventDefault();
  openNodeMenu(tr.dataset.id, e.clientX, e.clientY);
});

/* ------------------------------------------------------------------ */
/* 列宽拖拽                                                            */
/* ------------------------------------------------------------------ */

/**
 * 每个表头右侧一个手柄，拖动即可调列宽，结果存 localStorage。
 * 名称/服务器列内容长，默认宽度不够时用户能自己拉宽，不用改代码。
 */
function enableColumnResize() {
  const table = document.querySelector('table.grid');
  if (!table) return;
  const ths = [...table.querySelectorAll('thead th')];
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem('v2p.colwidths') || '{}');
  } catch (e) {
    saved = {};
  }

  ths.forEach((th, i) => {
    // 复选框、状态点、操作列不给拖
    if (th.classList.contains('col-check') || th.classList.contains('col-status') || th.classList.contains('col-act')) return;
    if (saved[i]) th.style.width = saved[i] + 'px';
    if (th.querySelector('.col-resizer')) return;

    const grip = document.createElement('span');
    grip.className = 'col-resizer';
    grip.title = '拖动调整列宽（双击恢复默认）';
    th.appendChild(grip);

    grip.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      th.style.width = '';
      const map = JSON.parse(localStorage.getItem('v2p.colwidths') || '{}');
      delete map[i];
      localStorage.setItem('v2p.colwidths', JSON.stringify(map));
    });

    grip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      grip.classList.add('dragging');
      const startX = e.clientX;
      const startW = th.getBoundingClientRect().width;

      const onMove = (ev) => {
        const w = Math.max(56, Math.round(startW + ev.clientX - startX));
        th.style.width = w + 'px';
      };
      const onUp = () => {
        grip.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const map = JSON.parse(localStorage.getItem('v2p.colwidths') || '{}');
        map[i] = Math.round(th.getBoundingClientRect().width);
        localStorage.setItem('v2p.colwidths', JSON.stringify(map));
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

init();
