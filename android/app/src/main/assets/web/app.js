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

  /** 调原生；浏览器里（无 Native）退化为本地兜底，方便桌面调试 UI */
  function call(method, args) {
    return new Promise(function (resolve) {
      if (!window.Native || typeof window.Native.invoke !== 'function') {
        resolve(fallback(method, args));
        return;
      }
      var id = 'c' + (++seq);
      pending[id] = resolve;
      try {
        window.Native.invoke(method, JSON.stringify(args || {}), id);
      } catch (e) {
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
    activeNodeId: ''
  };

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

  function renderList() {
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

    var html = list.map(function (n) {
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
      if (n.status === 'idle') meta.push('<span>未检测</span>');
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
    }).join('');

    box.innerHTML = html;
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
    $('#vpnHint').textContent = vpnOk
      ? 'VPN 会接管全机流量（需要系统授权）。'
      : '未集成 libcore.aar：请用「开启代理」，再到 Wi-Fi 设置里填 HTTP 代理。';
  }

  function renderRoute() {
    var mode = state.settings.routeMode;
    $$('#routeSeg button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.route === mode);
    });
    $('#routeHint').textContent = ROUTE_HINT[mode] || '';
  }

  function renderAll() {
    renderStats();
    renderList();
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
    // 节点集合变化才需要重启内核
    return state.nodes.slice(0, 200).map(function (n) {
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
      nodeCount: state.nodes.length
    });
    if (!r || !r.ok) {
      toast('内核启动失败：' + ((r && r.error) || '未知'), 'err', 6000);
      return false;
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

    var targets = state.nodes.slice(0, 200);
    if (mode === 'failed') {
      targets = state.nodes.filter(function (n) { return n.status === 'fail'; }).slice(0, 200);
      if (!targets.length) return toast('没有失败的节点', 'err');
    } else if (mode === 'latency') {
      targets = state.nodes.slice(0, 200);
    }

    state.testing = true;
    state.aborted = false;
    $('#btnTest').disabled = true;
    setProgress(0, targets.length, '正在启动内核…');

    var ok = await ensureCore();
    if (!ok) {
      state.testing = false;
      $('#btnTest').disabled = false;
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
        try {
          await testOne(n, indexMap[n.id], deep);
        } catch (e) {
          n.status = 'fail';
          n.error = e.message;
          n.health = 0;
        }
        done++;
        if (done % 3 === 0 || done === targets.length) {
          setProgress(done, targets.length, done + ' / ' + targets.length);
          renderStats();
          renderList();
        }
      }
    }

    var workers = [];
    for (var w = 0; w < conc; w++) workers.push(worker());
    await Promise.all(workers);

    state.testing = false;
    $('#btnTest').disabled = false;
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

  async function refreshStatus() {
    var st = await call('core.status', {});
    if (st) {
      state.proxy = st;
      renderProxyPill();
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
  $('#btnMore').addEventListener('click', function () { openSheet('sheetMore'); });
  $('#btnTest').addEventListener('click', function () { runTest('full'); });
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

  $$('[data-export]').forEach(function (b) {
    b.addEventListener('click', function () { exportAs(b.dataset.export); });
  });

  $('#btnNodeTest').addEventListener('click', async function () {
    var n = state.nodes.filter(function (x) { return x.id === state.activeNodeId; })[0];
    if (!n) return;
    var idx = state.nodes.indexOf(n);
    toast('正在检测…');
    var ok = await ensureCore();
    if (!ok) return;
    await testOne(n, idx, true);
    save();
    renderAll();
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

  $('#btnSaveSettings').addEventListener('click', function () {
    state.settings.concurrency = clamp(parseInt($('#setConcurrency').value, 10) || 6, 1, 16);
    state.settings.latencyTimeout = clamp(parseInt($('#setTimeout').value, 10) || 6000, 1000, 30000);
    state.settings.speedBytes = clamp(parseInt($('#setSpeedBytes').value, 10) || 5000000, 500000, 50000000);
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
    $('#setConcurrency').value = state.settings.concurrency;
    $('#setTimeout').value = state.settings.latencyTimeout;
    $('#setSpeedBytes').value = state.settings.speedBytes;

    await refreshStatus();
    setInterval(refreshStatus, 5000);
  }

  boot();
})();
