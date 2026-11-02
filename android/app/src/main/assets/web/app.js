/* V2PTools Android · 界面逻辑
 *
 * 分工：
 *   这里负责 解析 / 筛选 / 体检调度 / 配置生成 / 导出
 *   原生层负责 内核进程、VPN、真实网络请求（WebView 里做不了 SOCKS 与跨域）
 */
(function () {
  'use strict';

  /* ================= 原生桥 ================= */

  var seq = 0;
  var pending = {};

  window.__resolve = function (id, json) {
    var fn = pending[id];
    if (!fn) return;
    delete pending[id];
    var data;
    try {
      data = JSON.parse(json);
    } catch (e) {
      data = { ok: false, error: '返回值解析失败' };
    }
    fn(data);
  };

  window.__onStatus = function (json) {
    try {
      state.proxy = JSON.parse(json);
      renderProxyPill();
    } catch (e) {}
  };

  /**
   * 调原生；浏览器里（无 Native）退化为本地兜底，方便桌面调试 UI。
   * 必须带超时：原生线程池被长任务（测速 15s）占满时，回包可能永远不来，
   * 没有超时的话 Promise 会一直挂着，界面上就是「点了没反应、越用越卡」。
   */
  function call(method, args, timeoutMs) {
    return new Promise(function (resolve) {
      if (!window.Native || typeof window.Native.invoke !== 'function') {
        resolve(fallback(method, args));
        return;
      }
      var id = 'c' + (++seq);
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        delete pending[id];
        resolve({ ok: false, error: '原生调用超时（' + method + '）' });
      }, timeoutMs || 25000);

      pending[id] = function (data) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(data);
      };

      try {
        window.Native.invoke(method, JSON.stringify(args || {}), id);
      } catch (e) {
        settled = true;
        clearTimeout(timer);
        delete pending[id];
        resolve({ ok: false, error: e.message });
      }
    });
  }

  function fallback(method, args) {
    // 仅用于桌面预览：存储走 localStorage，其余返回不可用
    if (method === 'store.get') {
      var v = localStorage.getItem('v2p:' + args.key);
      return { ok: true, value: v == null ? null : v };
    }
    if (method === 'store.set') {
      localStorage.setItem('v2p:' + args.key, args.value);
      return { ok: true };
    }
    if (method === 'core.status') return { ok: true, running: false };
    if (method === 'app.info') return { ok: true, version: 'web', vpnAvailable: false };
    return { ok: false, error: '当前环境不支持该操作' };
  }

  /* ================= 状态 ================= */

  var DEFAULT_SETTINGS = {
    concurrency: 6,
    latencyTimeout: 6000,
    speedBytes: 5000000,
    routeMode: 'bypass-cn',
    mixedPort: 7890,
    ctlPort: 9090,
    listenerBase: 20000,
    latencyUrls: [
      'http://cp.cloudflare.com/generate_204',
      'http://www.gstatic.com/generate_204',
      'http://connectivitycheck.gstatic.com/generate_204'
    ],
    speedUrl: 'https://speed.cloudflare.com/__down?bytes=20000000'
  };

  var state = {
    nodes: [],
    sources: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    proxy: {},
    running: false,
    testing: false,
    aborted: false,
    filter: { status: 'all', dnsbl: false },
    query: '',
    sort: 'health',
    selected: {},
    coreSig: '',
    activeNodeId: '',
    // 列表分页：节点上千时一次性插几千个 DOM 会直接卡死/闪退
    renderLimit: 120
  };

  var PAGE_SIZE = 120;

  var ROUTE_LABEL = { global: '全局代理', 'bypass-cn': '绕过大陆', 'proxy-list': '仅名单代理' };
  var ROUTE_HINT = {
    global: '所有流量都走节点。',
    'bypass-cn': '国内直连、其余走节点，日常最实用。',
    'proxy-list': '只有被墙名单走节点，其余直连。'
  };

  /* ================= 工具 ================= */

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function toast(msg, type, ms) {
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    $('#toastWrap').appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 260);
    }, ms || 2600);
  }

  function uid() {
    return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ================= 健康度 ================= */

  function healthOf(n) {
    if (n.status !== 'ok') return 0;
    var s = 0;
    s += clamp((800 - (n.latency || 800)) / 700, 0, 1) * 40;
    s += clamp((300 - (n.jitter || 0)) / 280, 0, 1) * 20;
    s += clamp((n.speed || 0) / 20, 0, 1) * 25;
    s += n.dnsbl === 'listed' ? 0 : 15;
    return Math.round(s);
  }

  /* ================= 持久化 ================= */

  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      call('store.set', { key: 'nodes', value: JSON.stringify(state.nodes) });
      call('store.set', { key: 'settings', value: JSON.stringify(state.settings) });
      call('store.set', { key: 'sources', value: JSON.stringify(state.sources) });
    }, 300);
  }

  async function load() {
    var n = await call('store.get', { key: 'nodes' });
    if (n && n.ok && n.value) {
      try { state.nodes = JSON.parse(n.value) || []; } catch (e) { state.nodes = []; }
    }
    var s = await call('store.get', { key: 'settings' });
    if (s && s.ok && s.value) {
      try { state.settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(s.value)); } catch (e) {}
    }
    var src = await call('store.get', { key: 'sources' });
    if (src && src.ok && src.value) {
      try { state.sources = JSON.parse(src.value) || []; } catch (e) { state.sources = []; }
    }
  }

  /* ================= 渲染 ================= */

  function sortedNodes() {
    var list = state.nodes.slice();
    var q = state.query.trim().toLowerCase();
    var f = state.filter;

    list = list.filter(function (n) {
      if (f.status && f.status !== 'all' && n.status !== f.status) return false;
      if (f.dnsbl && n.dnsbl === 'listed') return false;
      if (!q) return true;
      var hay = [n.name, n.server, n.country, n.city, n.isp, n.type].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });

    if (state.sort === 'latency') {
      list.sort(function (a, b) {
        return (a.latency || 99999) - (b.latency || 99999);
      });
    } else {
      list.sort(function (a, b) {
        return (b.health || 0) - (a.health || 0);
      });
    }
    return list;
  }

  function renderStats() {
    var total = state.nodes.length;
    var ok = state.nodes.filter(function (n) { return n.status === 'ok'; }).length;
    var lat = state.nodes.filter(function (n) { return n.status === 'ok' && n.latency; });
    var avgLat = lat.length
      ? Math.round(lat.reduce(function (a, n) { return a + n.latency; }, 0) / lat.length) + ' ms'
      : '—';
    var hs = state.nodes.filter(function (n) { return n.health > 0; });
    var avgH = hs.length
      ? Math.round(hs.reduce(function (a, n) { return a + n.health; }, 0) / hs.length)
      : '—';

    $('#statTotal').textContent = total;
    $('#statOk').textContent = ok;
    $('#statLatency').textContent = avgLat;
    $('#statHealth').textContent = avgH;
  }

  function latencyClass(v) {
    if (!v) return '';
    if (v < 200) return 'good';
    if (v < 500) return 'mid';
    return 'bad';
  }

  /** 单个节点的卡片 HTML（列表与局部更新共用，保证两条路径渲染一致） */
  function cardHtml(n) {
    var sel = state.selected[n.id] ? ' on' : '';
    var inUse = n.id === state.activeNodeId ? ' in-use' : '';
    var fail = n.status === 'fail' ? ' fail' : '';
    var h = n.health || 0;
    var hCls = h >= 75 ? 'h-good' : h >= 45 ? 'h-mid' : 'h-bad';

    var meta = [];
    if (n.latency) meta.push('<span class="' + latencyClass(n.latency) + '">' + n.latency + ' ms</span>');
    if (n.jitter) meta.push('<span>抖动 ' + n.jitter + '</span>');
    if (n.speed) meta.push('<span>' + n.speed + ' Mbps</span>');
    if (n.country) meta.push('<span>' + esc(n.country) + (n.city ? '·' + esc(n.city) : '') + '</span>');
    if (n.ip) meta.push('<span>' + esc(n.ip) + '</span>');
    if (n.status === 'testing') meta.push('<span>检测中…</span>');
    else if (n.status === 'idle') meta.push('<span>未检测</span>');
    if (n.status === 'fail') meta.push('<span class="bad">' + esc(n.error || '失败') + '</span>');
    if (n.dnsbl === 'listed') meta.push('<span class="bad">DNSBL</span>');

    return '' +
      '<div class="card' + inUse + fail + '" data-id="' + n.id + '">' +
        '<div class="check' + sel + '" data-check="' + n.id + '">✓</div>' +
        '<div class="card-main">' +
          '<div class="card-top">' +
            '<div class="card-name">' + esc(n.name || n.server) + '</div>' +
            (inUse ? '<span class="tag use">使用中</span>' : '') +
            '<span class="tag">' + esc(n.type) + '</span>' +
          '</div>' +
          '<div class="card-meta">' + meta.join('') + '</div>' +
        '</div>' +
        '<div class="health ' + hCls + '"><b>' + (h || '—') + '</b><span>健康</span></div>' +
      '</div>';
  }

  /** 只重绘一个卡片；找不到（被分页截掉）时返回 false 由调用方兜底 */
  function updateCard(n) {
    var el = document.querySelector('.card[data-id="' + n.id + '"]');
    if (!el) return false;
    var tmp = document.createElement('div');
    tmp.innerHTML = cardHtml(n);
    var fresh = tmp.firstElementChild;
    if (!fresh || !el.parentNode) return false;
    el.parentNode.replaceChild(fresh, el);
    return true;
  }

  /**
   * 分页渲染：默认只插前 120 个，底部给「显示更多」。
   * 之前是一次性 innerHTML 全部节点，节点上千时字符串拼接 + 布局就够卡死一次，
   * 检测过程中还会每 3 个节点整体重建，内存直接被抬上去。
   */
  function renderList(keepLimit) {
    var list = sortedNodes();
    var box = $('#list');
    var empty = $('#empty');

    if (!list.length) {
      box.innerHTML = '';
      box.appendChild(empty);
      empty.hidden = false;
      empty.querySelector('p').textContent = state.nodes.length ? '没有匹配的节点' : '还没有节点';
      empty.querySelector('span').textContent = state.nodes.length
        ? '换个筛选条件试试'
        : '点下方「导入」添加代理';
      return;
    }
    empty.hidden = true;

    if (!keepLimit) state.renderLimit = PAGE_SIZE;
    var limit = Math.min(list.length, Math.max(PAGE_SIZE, state.renderLimit || PAGE_SIZE));
    state.listTotal = list.length;

    var parts = [];
    for (var i = 0; i < limit; i += 1) parts.push(cardHtml(list[i]));
    if (list.length > limit) {
      parts.push('<button class="btn btn-ghost" id="btnMoreNodes" style="margin:12px auto;display:block">显示更多（还有 ' + (list.length - limit) + ' 个）</button>');
    }
    box.innerHTML = parts.join('');

    var more = $('#btnMoreNodes');
    if (more) {
      more.addEventListener('click', function () {
        state.renderLimit = (state.renderLimit || PAGE_SIZE) + 200;
        renderList(true);
      });
    }
  }

  function renderProxyPill() {
    var p = state.proxy || {};
    var running = !!p.running || !!p.vpnRunning;
    var pill = $('#proxyPill');
    var text = $('#proxyPillText');

    if (p.vpnRunning) {
      pill.dataset.state = 'on';
      text.textContent = 'VPN 已开启';
    } else if (running) {
      pill.dataset.state = 'on';
      text.textContent = '代理 :' + p.mixedPort;
    } else if (p.error) {
      pill.dataset.state = 'bad';
      text.textContent = '代理异常';
    } else {
      pill.dataset.state = 'off';
      text.textContent = '代理未开启';
    }

    state.running = running;
    $('#btnStartProxy').textContent = running ? '关闭代理' : '开启代理';

    // 未确认可用时先禁用，避免用户点了才报错
    var vpnOk = p.vpnAvailable === true;
    $('#btnStartVpn').disabled = !vpnOk;
    var port = p.mixedPort || state.settings.mixedPort;
    if (vpnOk) {
      $('#vpnHint').textContent = 'VPN 会接管全机流量（需要系统授权）。';
    } else if (running) {
      // 已经开着代理就别再说「请先开启代理」，直接告诉下一步怎么做
      $('#vpnHint').textContent =
        '代理已开启（127.0.0.1:' + port + '）。未集成 libcore.aar，无法用 VPN 接管全机；要让所有 App 生效，到 Wi-Fi 设置里填这个代理。';
    } else {
      $('#vpnHint').textContent = '未集成 libcore.aar：先「开启代理」，再到 Wi-Fi 设置里填 HTTP 代理。';
    }
  }

  function renderRoute() {
    var mode = state.settings.routeMode;
    $$('#routeSeg button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.route === mode);
    });
    $('#routeHint').textContent = ROUTE_HINT[mode] || '';
  }

  function renderAll(keepLimit) {
    renderStats();
    renderList(keepLimit);
    renderProxyPill();
    renderRoute();
  }

  /* ================= 导入 ================= */

  function addNodes(incoming, sourceUrl) {
    var added = 0;
    var seen = {};
    state.nodes.forEach(function (n) {
      seen[n.type + '|' + n.server + '|' + n.port + '|' + ((n.conf && (n.conf.password || n.conf.uuid)) || '')] = true;
    });
    incoming.forEach(function (n) {
      var key = n.type + '|' + n.server + '|' + n.port + '|' + ((n.conf && (n.conf.password || n.conf.uuid)) || '');
      if (seen[key]) return;
      seen[key] = true;
      n.id = uid();
      n.status = 'idle';
      n.health = 0;
      if (sourceUrl) n.source = sourceUrl;
      state.nodes.push(n);
      added++;
    });
    return added;
  }

  function parseAndAdd(text, sourceUrl) {
    var r = V2P.parser.parseText(text, { plainType: 'socks5', source: sourceUrl });
    if (!r.nodes.length) {
      var msg = r.errors && r.errors.length ? r.errors[0].error : '没识别出代理';
      toast('解析失败：' + msg, 'err');
      return 0;
    }
    var added = addNodes(r.nodes, sourceUrl);
    save();
    renderAll();
    if (added) toast('已添加 ' + added + ' 个节点（格式：' + r.format + '）', 'ok');
    else toast('这些节点已经在列表里了', 'warn');
    return added;
  }

  async function importFile() {
    var r = await call('file.pick', {});
    if (!r || !r.ok) {
      if (r && r.canceled) return;
      toast('读取失败：' + ((r && r.error) || '未知'), 'err');
      return;
    }
    parseAndAdd(r.text, 'file:' + (r.name || 'import'));
    closeSheets();
  }

  async function importSubscription(url) {
    if (!/^https?:\/\//i.test(url)) return toast('请输入 http(s) 开头的订阅地址', 'err');
    toast('正在拉取订阅…');

    var text = '';
    var why = '';

    // 1) 原生拉取：内核在跑就走它的 mixed 端口。WebView 的 fetch 只能直连，
    //    而这类订阅站域名普遍被 DNS 污染，直连一定超时。
    try {
      var port = state.proxy && state.proxy.running
        ? (state.proxy.mixedPort || state.settings.mixedPort)
        : 0;
      var r = await call('sub.fetch', { url: url, port: port, timeout: 25000 });
      if (r && r.ok && r.text) text = r.text;
      else why = (r && r.error) || '原生拉取失败';
    } catch (e) {
      why = e.message || '原生拉取失败';
    }

    // 2) 回退 WebView fetch（桌面预览、或原生通道不可用时）
    if (!text) {
      try {
        var res = await fetch(url, { headers: { Accept: '*/*' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        text = await res.text();
      } catch (e) {
        toast('订阅拉取失败：' + (why || e.message), 'err', 6000);
        return;
      }
    }

    try {
      var added = parseAndAdd(text, url);
      if (added > 0) {
        var host = '';
        try { host = new URL(url).hostname; } catch (e) {}
        var exist = state.sources.filter(function (s) { return s.url === url; })[0];
        if (exist) {
          exist.count = added;
          exist.lastSync = Date.now();
        } else {
          state.sources.push({ id: uid(), url: url, group: host, count: added, lastSync: Date.now() });
        }
        save();
      }
      closeSheets();
    } catch (e) {
      toast('订阅解析失败：' + e.message, 'err', 5000);
    }
  }

  /* ================= 体检 ================= */

  function nodePort(index) {
    return (Number(state.settings.listenerBase) || 20000) + index;
  }

  function coreSignature() {
    // 节点集合变化才需要重启内核（与配置里的节点上限保持一致）
    var cap = (window.V2PConfigGen && V2PConfigGen.MAX_PROXIES) || 400;
    return state.nodes.slice(0, cap).map(function (n) {
      return n.type + ':' + n.server + ':' + n.port;
    }).join(',') + '|' + state.settings.routeMode + '|' + state.settings.mixedPort;
  }

  async function ensureCore() {
    var sig = coreSignature();
    var st = await call('core.status', {});
    if (st && st.running && state.coreSig === sig) return true;

    if (!state.nodes.length) {
      toast('没有节点可测', 'err');
      return false;
    }

    var built;
    try {
      built = V2PConfigGen.buildMihomoConfig({
        nodes: state.nodes,
        routeMode: state.settings.routeMode,
        mixedPort: state.settings.mixedPort,
        ctlPort: state.settings.ctlPort,
        listenerBase: state.settings.listenerBase
      });
    } catch (e) {
      toast('配置生成失败：' + e.message, 'err');
      return false;
    }

    var r = await call('core.start', {
      config: built.yaml,
      mixedPort: state.settings.mixedPort,
      ctlPort: state.settings.ctlPort,
      routeMode: state.settings.routeMode,
      nodeCount: built.used || state.nodes.length
    });
    if (!r || !r.ok) {
      toast('内核启动失败：' + ((r && r.error) || '未知'), 'err', 6000);
      return false;
    }
    // 节点超过配置上限时说明一次，避免用户以为「后面的节点也能用」
    if (built.truncated && !state.truncTipShown) {
      state.truncTipShown = true;
      toast('节点共 ' + built.total + ' 个，内核配置只取前 ' + built.used + ' 个（可「设为默认出口」把常用节点前移）', 'warn', 6000);
    }
    state.coreSig = sig;
    return true;
  }

  function setProgress(done, total, text) {
    var p = $('#progress');
    p.hidden = false;
    $('#progressBar').style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
    $('#progressText').textContent = text || (done + ' / ' + total);
  }

  async function testOne(n, index, deep) {
    var port = nodePort(index);

    var pr = await call('probe', {
      port: port,
      urls: state.settings.latencyUrls,
      timeout: state.settings.latencyTimeout,
      samples: 2
    });

    if (!pr || !pr.ok) {
      n.status = 'fail';
      n.error = (pr && pr.error) || '连接失败';
      n.latency = 0;
      n.jitter = 0;
      n.health = 0;
      return;
    }

    n.status = 'ok';
    n.error = '';
    n.latency = pr.ms;
    n.jitter = pr.jitter;

    if (!deep) {
      n.health = healthOf(n);
      return;
    }

    // 出口 IP + 归属地
    var ex = await call('exit', { port: port, timeout: 8000 });
    if (ex && ex.ok) {
      n.ip = ex.ip;
      n.country = ex.country;
      n.countryCode = ex.countryCode;
      n.city = ex.city;
      n.isp = ex.isp;
      n.asn = ex.asn;

      // DNSBL 只对拿到的 IP 查一次
      var d = await call('dnsbl', { ip: ex.ip, timeout: 5000 });
      if (d && d.ok) n.dnsbl = d.listed ? 'listed' : 'clean';
    }

    // 速度
    var sp = await call('speed', {
      port: port,
      url: state.settings.speedUrl,
      bytes: state.settings.speedBytes,
      timeout: 15000
    });
    if (sp && sp.ok) n.speed = sp.mbps;

    n.health = healthOf(n);
  }

  async function runTest(mode) {
    if (state.testing) return;
    if (!state.nodes.length) return toast('请先导入节点', 'err');

    var cap = (window.V2PConfigGen && V2PConfigGen.MAX_LISTENERS) || 200;
    var targets = state.nodes.slice(0, cap);
    if (mode === 'failed') {
      targets = state.nodes.filter(function (n) { return n.status === 'fail'; }).slice(0, cap);
      if (!targets.length) return toast('没有失败的节点', 'err');
    } else if (mode === 'latency') {
      targets = state.nodes.slice(0, cap);
    }

    state.testing = true;
    state.aborted = false;
    // 检测期间按钮变成「停止」：节点多、节点又不通时单轮可能要好几分钟，
    // 之前按钮直接 disabled，用户只能干等，体感就是「卡死」
    $('#btnTest').classList.add('testing');
    $('#btnTestText').textContent = '停止';
    setProgress(0, targets.length, '正在启动内核…');

    var ok = await ensureCore();
    if (!ok) {
      state.testing = false;
      $('#btnTest').classList.remove('testing');
      $('#btnTestText').textContent = '全面体检';
      $('#progress').hidden = true;
      return;
    }

    var deep = mode !== 'latency';
    var conc = clamp(Number(state.settings.concurrency) || 6, 1, 16);
    var cursor = 0;
    var done = 0;

    // 目标节点在完整列表里的下标决定端口
    var indexMap = {};
    state.nodes.forEach(function (n, i) { indexMap[n.id] = i; });

    async function worker() {
      while (!state.aborted) {
        var i = cursor++;
        if (i >= targets.length) return;
        var n = targets[i];
        n.status = 'testing';
        updateCard(n);
        try {
          await testOne(n, indexMap[n.id], deep);
        } catch (e) {
          n.status = 'fail';
          n.error = e.message;
          n.health = 0;
        }
        done++;
        // 只替换这一张卡片：整体重建在节点多时会把主线程按住不放
        updateCard(n);
        if (done % 3 === 0 || done === targets.length) {
          setProgress(done, targets.length, done + ' / ' + targets.length);
          renderStats();
        }
      }
    }

    var workers = [];
    for (var w = 0; w < conc; w++) workers.push(worker());
    await Promise.all(workers);

    state.testing = false;
    $('#btnTest').classList.remove('testing');
    $('#btnTestText').textContent = '全面体检';
    $('#progress').hidden = true;
    save();
    renderAll();

    var okCount = targets.filter(function (n) { return n.status === 'ok'; }).length;
    toast(state.aborted ? '已停止' : '体检完成：' + okCount + ' / ' + targets.length + ' 可用',
      okCount ? 'ok' : 'warn', 3500);
  }

  /* ================= 代理 ================= */

  async function startProxy(useVpn) {
    if (!state.nodes.length) return toast('请先导入节点', 'err');

    var built;
    try {
      built = V2PConfigGen.buildMihomoConfig({
        nodes: state.nodes,
        routeMode: state.settings.routeMode,
        mixedPort: state.settings.mixedPort,
        ctlPort: state.settings.ctlPort,
        listenerBase: state.settings.listenerBase
      });
    } catch (e) {
      return toast('配置生成失败：' + e.message, 'err');
    }

    var payload = {
      config: built.yaml,
      mixedPort: state.settings.mixedPort,
      ctlPort: state.settings.ctlPort,
      routeMode: state.settings.routeMode,
      nodeCount: state.nodes.length
    };

    var r = await call(useVpn ? 'vpn.start' : 'core.start', payload);
    if (!r || !r.ok) return toast('启动失败：' + ((r && r.error) || '未知'), 'err', 6000);

    state.coreSig = coreSignature();
    toast(useVpn ? 'VPN 已启动' : '代理已启动，端口 ' + state.settings.mixedPort, 'ok');

    if (!useVpn) {
      // 提示用户怎么让全机走代理
      setTimeout(function () {
        toast('如需全机生效：复制 127.0.0.1:' + state.settings.mixedPort + '，到 Wi-Fi 设置里填代理', 'warn', 6000);
      }, 1200);
    }
    setTimeout(refreshStatus, 800);
  }

  async function stopProxy() {
    var r = await call('core.stop', {});
    if (!r || !r.ok) toast('停止失败', 'err');
    else toast('代理已关闭', 'ok');
    setTimeout(refreshStatus, 600);
  }

  var statusBusy = false;

  async function refreshStatus() {
    // 上一次还没回包就跳过这一轮，避免原生线程池被长任务占满时任务越堆越多
    if (statusBusy) return;
    statusBusy = true;
    try {
      var st = await call('core.status', {}, 8000);
      if (st && st.ok !== false) {
        state.proxy = st;
        renderProxyPill();
      }
    } finally {
      statusBusy = false;
    }
  }

  /* ================= 导出 ================= */

  function buildExport(kind) {
    var list = sortedNodes();
    if (!list.length) list = state.nodes;
    if (!list.length) {
      toast('没有可导出的节点', 'err');
      return null;
    }

    if (kind === 'clash') {
      var built = V2P.clash.buildClashYaml(list, {});
      return { name: 'v2ptools-clash.yaml', content: built.text, count: built.count };
    }
    if (kind === 'json') {
      var arr = list.map(function (n) {
        return {
          name: n.name, type: n.type, server: n.server, port: n.port,
          status: n.status, latency: n.latency, jitter: n.jitter, speed: n.speed,
          ip: n.ip, country: n.country, city: n.city, isp: n.isp, asn: n.asn,
          health: n.health, dnsbl: n.dnsbl, raw: n.raw
        };
      });
      return { name: 'v2ptools-nodes.json', content: JSON.stringify(arr, null, 2), count: arr.length };
    }
    if (kind === 'txt') {
      var lines = list.map(function (n) {
        return n.raw || (n.type + '://' + n.server + ':' + n.port);
      });
      return { name: 'v2ptools-links.txt', content: lines.join('\n'), count: lines.length };
    }

    // CSV
    var head = ['名称', '协议', '服务器', '端口', '状态', '延迟(ms)', '抖动(ms)', '速度(Mbps)', '出口IP', '国家', '城市', 'ISP', 'ASN', '健康度', 'DNSBL'];
    var rows = list.map(function (n) {
      return [n.name, n.type, n.server, n.port, n.status, n.latency || '', n.jitter || '', n.speed || '',
        n.ip || '', n.country || '', n.city || '', n.isp || '', n.asn || '', n.health || '', n.dnsbl || ''];
    });
    var csv = [head].concat(rows).map(function (r) {
      return r.map(function (c) {
        var s = String(c == null ? '' : c);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\n');
    return { name: 'v2ptools-nodes.csv', content: '\ufeff' + csv, count: list.length };
  }

  async function exportAs(kind) {
    var e = buildExport(kind);
    if (!e) return;
    var r = await call('file.save', { name: e.name, content: e.content });
    if (r && r.ok) toast('已导出 ' + e.count + ' 个节点', 'ok');
    else if (r && !r.canceled) toast('导出失败：' + ((r && r.error) || ''), 'err');
  }

  /* ================= 交互 ================= */

  function openSheet(id) { $('#' + id).hidden = false; }
  function closeSheets() { $$('.sheet').forEach(function (s) { s.hidden = true; }); }

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-close]') || e.target.classList.contains('sheet-mask')) {
      closeSheets();
      return;
    }

    var check = e.target.closest('[data-check]');
    if (check) {
      e.stopPropagation();
      var id = check.dataset.check;
      if (state.selected[id]) delete state.selected[id];
      else state.selected[id] = true;
      renderList();
      return;
    }

    var card = e.target.closest('.card');
    if (card) {
      showNode(card.dataset.id);
      return;
    }
  });

  function showNode(id) {
    var n = state.nodes.filter(function (x) { return x.id === id; })[0];
    if (!n) return;
    state.activeNodeId = id;

    $('#nodeTitle').textContent = n.name || n.server;
    var kv = [
      ['协议', n.type],
      ['服务器', n.server + ':' + n.port],
      ['状态', n.status === 'ok' ? '可用' : n.status === 'fail' ? '失败：' + (n.error || '') : '未检测'],
      ['延迟', n.latency ? n.latency + ' ms' : '—'],
      ['抖动', n.jitter ? n.jitter + ' ms' : '—'],
      ['速度', n.speed ? n.speed + ' Mbps' : '—'],
      ['出口 IP', n.ip || '—'],
      ['归属地', [n.country, n.city].filter(Boolean).join(' ') || '—'],
      ['ISP', n.isp || '—'],
      ['ASN', n.asn || '—'],
      ['DNSBL', n.dnsbl === 'listed' ? '命中黑名单' : n.dnsbl === 'clean' ? '干净' : '未查'],
      ['健康度', n.health || '—']
    ];
    $('#nodeDetail').innerHTML = kv.map(function (p) {
      return '<div class="kv"><span>' + p[0] + '</span><b>' + esc(p[1]) + '</b></div>';
    }).join('');
    openSheet('sheetNode');
  }

  $('#btnImport').addEventListener('click', function () { openSheet('sheetImport'); });
  $('#btnMore').addEventListener('click', function () {
    fillSettings(); // 每次打开都按当前设置回填，避免显示上一次的旧值
    openSheet('sheetMore');
  });
  $('#btnTest').addEventListener('click', function () {
    // 检测中再点一次 = 停止
    if (state.testing) {
      state.aborted = true;
      setProgress(0, 0, '正在停止…');
      return;
    }
    runTest('full');
  });
  $('#btnStopTest').addEventListener('click', function () { state.aborted = true; });
  $('#proxyPill').addEventListener('click', function () {
    if (state.running) stopProxy(); else openSheet('sheetMore');
  });

  // 导入弹层 tab
  $$('#importTabs .tab').forEach(function (t) {
    t.addEventListener('click', function () {
      $$('#importTabs .tab').forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      $$('.tabpane').forEach(function (p) {
        p.hidden = p.dataset.pane !== t.dataset.tab;
      });
    });
  });

  $('#btnBulkAdd').addEventListener('click', function () {
    var text = $('#bulkText').value.trim();
    if (!text) return toast('先粘贴内容', 'err');
    if (parseAndAdd(text) > 0) { $('#bulkText').value = ''; closeSheets(); }
  });

  $('#btnSubAdd').addEventListener('click', function () {
    importSubscription($('#subUrl').value.trim());
  });

  $('#btnSingleAdd').addEventListener('click', function () {
    var text = $('#singleText').value.trim();
    if (!text) return toast('先填链接', 'err');
    if (parseAndAdd(text) > 0) { $('#singleText').value = ''; closeSheets(); }
  });

  $('#btnFilePick').addEventListener('click', importFile);

  // 筛选
  $('#search').addEventListener('input', function (e) {
    state.query = e.target.value;
    state.renderLimit = PAGE_SIZE; // 条件变了，从第一页重新看
    renderList();
  });

  $$('#chips .chip').forEach(function (c) {
    c.addEventListener('click', function () {
      var f = c.dataset.f;
      var v = c.dataset.v;
      if (f === 'status') {
        state.filter.status = v;
        $$('#chips .chip[data-f="status"]').forEach(function (x) { x.classList.remove('active'); });
        c.classList.add('active');
      } else if (f === 'dnsbl') {
        state.filter.dnsbl = !state.filter.dnsbl;
        c.classList.toggle('active', state.filter.dnsbl);
      } else if (f === 'sort') {
        state.sort = v;
        $$('#chips .chip[data-f="sort"]').forEach(function (x) { x.classList.remove('active'); });
        c.classList.add('active');
      }
      state.renderLimit = PAGE_SIZE;
      renderList();
    });
  });

  // 分流方式
  $$('#routeSeg button').forEach(function (b) {
    b.addEventListener('click', async function () {
      state.settings.routeMode = b.dataset.route;
      renderRoute();
      save();
      if (state.running) {
        toast('正在按新分流方式重启…');
        await startProxy(state.proxy.vpnRunning);
      } else {
        toast('分流方式：' + ROUTE_LABEL[b.dataset.route], 'ok');
      }
    });
  });

  $('#btnStartProxy').addEventListener('click', function () {
    if (state.running) stopProxy(); else startProxy(false);
  });
  $('#btnStartVpn').addEventListener('click', function () {
    if (state.running) stopProxy(); else startProxy(true);
  });

  /**
   * 代理自检：分别用「本机代理端口」和「直连」查一次出口 IP。
   * 两个 IP 不一样 = 代理链路本身没问题，问题在系统层（Android 不允许 App 改系统代理，
   * 必须去 Wi-Fi 高级设置里手填，或者用 VPN 模式）。
   */
  $('#btnProxyCheck').addEventListener('click', async function () {
    var port = state.settings.mixedPort;
    toast('正在检查代理链路…');
    var via = await call('exit', { port: port, timeout: 8000 });
    var direct = await call('exit', { port: 0, timeout: 8000 });

    var lines = [];
    lines.push(via && via.ok
      ? '经代理 ' + '127.0.0.1:' + port + ' 出口：' + via.ip + ' ' + (via.country || '')
      : '代理端口不通：' + ((via && via.error) || '未知'));
    lines.push(direct && direct.ok
      ? '直连出口：' + direct.ip + ' ' + (direct.country || '')
      : '直连探测失败（不影响判断）');

    if (via && via.ok && direct && direct.ok && via.ip === direct.ip) {
      lines.push('两个 IP 相同：节点可能没生效，换节点或检查订阅');
    } else if (via && via.ok) {
      lines.push('代理链路正常。要让浏览器等 App 也走它，需要在 Wi-Fi 高级设置里填 ' + '127.0.0.1:' + port);
    }
    alert(lines.join('\n'));
  });

  $$('[data-export]').forEach(function (b) {
    b.addEventListener('click', function () { exportAs(b.dataset.export); });
  });

  $('#btnNodeTest').addEventListener('click', async function () {
    var n = state.nodes.filter(function (x) { return x.id === state.activeNodeId; })[0];
    if (!n) return;
    var idx = state.nodes.indexOf(n);
    // 测速端口只给前 MAX_LISTENERS 个节点开，超出的节点没有 listener，测了也是白测
    var cap = (window.V2PConfigGen && V2PConfigGen.MAX_LISTENERS) || 200;
    if (idx >= cap) {
      return toast('该节点排在第 ' + (cap + 1) + ' 位之后，测速端口只开前 ' + cap + ' 个；请先精简列表，或把它「设为默认出口」后重开代理', 'err', 6000);
    }
    toast('正在检测…');
    var ok = await ensureCore();
    if (!ok) return;
    await testOne(n, idx, true);
    save();
    renderAll(true);
    showNode(n.id);
    toast(n.status === 'ok' ? '可用 · ' + n.latency + 'ms' : '失败：' + (n.error || ''), n.status === 'ok' ? 'ok' : 'err');
  });

  $('#btnNodeUse').addEventListener('click', function () {
    var n = state.nodes.filter(function (x) { return x.id === state.activeNodeId; })[0];
    if (!n) return;
    // 把该节点放到列表首位，让 PROXY 分组默认选它
    var idx = state.nodes.indexOf(n);
    if (idx > 0) {
      state.nodes.splice(idx, 1);
      state.nodes.unshift(n);
      save();
      renderAll();
    }
    toast('已设为默认出口，重新开启代理生效', 'ok');
    closeSheets();
  });

  /** 把当前设置回填到「更多」面板（存毫秒/字节，界面显示秒/MB） */  function fillSettings() {
    $('#setConcurrency').value = state.settings.concurrency;
    $('#setTimeout').value = Math.round((state.settings.latencyTimeout || 6000) / 100) / 10;
    $('#setSpeedBytes').value = Math.round((state.settings.speedBytes || 5000000) / 1000000);
  }

  $('#btnSaveSettings').addEventListener('click', function () {
    state.settings.concurrency = clamp(parseInt($('#setConcurrency').value, 10) || 6, 1, 16);
    // 界面按秒/MB 输入，存回毫秒/字节
    state.settings.latencyTimeout = clamp(Math.round((parseFloat($('#setTimeout').value) || 6) * 1000), 1000, 30000);
    state.settings.speedBytes = clamp(Math.round((parseFloat($('#setSpeedBytes').value) || 5) * 1000000), 1000000, 50000000);
    save();
    toast('设置已保存', 'ok');
    closeSheets();
  });

  $('#btnClearNodes').addEventListener('click', function () {
    if (!confirm('确定清空全部节点？')) return;
    state.nodes = [];
    state.selected = {};
    state.coreSig = '';
    save();
    renderAll();
    toast('已清空', 'ok');
    closeSheets();
  });

  /* ================= 启动 ================= */

  async function boot() {
    await load();
    renderAll();

    var info = await call('app.info', {});
    if (info && info.ok) {
      $('#appInfo').textContent = '版本 ' + info.version + ' · Android SDK ' + info.sdk + ' · ' + info.abi +
        (info.vpnAvailable ? ' · VPN 可用' : ' · VPN 不可用（未集成 libcore）');
    }
    fillSettings();

    await refreshStatus();
    setInterval(refreshStatus, 5000);

    // 滚到底部自动再加载一页（节流，避免滚动过程中反复重建）
    var loadMoreTimer = null;
    window.addEventListener('scroll', function () {
      if (loadMoreTimer) return;
      loadMoreTimer = setTimeout(function () { loadMoreTimer = null; }, 250);
      var total = state.listTotal || 0;
      if (total <= (state.renderLimit || PAGE_SIZE)) return;
      if (window.innerHeight + window.scrollY < document.body.scrollHeight - 500) return;
      state.renderLimit = (state.renderLimit || PAGE_SIZE) + 120;
      renderList(true);
    }, { passive: true });
  }

  boot();
})();
