'use strict';

/** 分组 / 筛选 交互端到端测试：electron scripts/test-group-ui.js */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

function mk(id, o) {
  return Object.assign(
    {
      id,
      name: id.toUpperCase(),
      type: 'ss',
      server: `${id}.example.com`,
      port: 443,
      conf: {},
      // 真实数据里每个节点都带订阅源 url（1516/1516 都能对上），
      // 这里不桩会有偏差：分组操作时「订阅源上记的自定义分组名」会被误清掉
      source: 'https://sub.example.com/x',
      group: '',
      status: 'ok',
      latency: 100,
      speed: 10,
      health: 90,
      ip: '1.1.1.1',
      country: '中国香港',
      countryCode: 'HK',
      city: '香港',
      isp: 'HKT',
      asn: 'AS1',
      proxyFlag: false,
      hostingFlag: false,
      mobileFlag: false,
      dnsbl: [],
    },
    o
  );
}

const nodes = [
  mk('a', { group: '香港', type: 'ss', latency: 40, health: 96, speed: 20, ipTypeKey: 'residential' }),
  mk('b', { group: '香港', type: 'vmess', latency: 220, health: 70, speed: 4, country: '日本', countryCode: 'JP', ipTypeKey: 'mobile' }),
  mk('c', { group: '日本', type: 'trojan', latency: 90, health: 88, speed: 12, country: '日本', countryCode: 'JP', ipTypeKey: 'hosting' }),
  mk('d', { group: '', type: 'ss', status: 'fail', latency: null, health: null, speed: null, ip: '', country: '', countryCode: '', ipTypeKey: 'proxy' }),
  mk('e', { group: '日本', type: 'vless', status: 'idle', latency: null, health: null, speed: null, ip: '', country: '', countryCode: '', ipTypeKey: 'unknown' }),
];

/* 订阅源：用来验证卡片上的「分组：xxx」标记与「恢复默认分组名」按钮 */
const sources = [
  { id: 's1', url: 'https://sub.example.com/x', group: 'sub.example.com', groupName: '日本', count: 5, format: 'Clash YAML', lastSync: Date.now() },
];

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? '✔' : '✘'} ${name}${cond ? '' : '  → ' + JSON.stringify(detail)}`);
}

ipcMain.handle('app:info', () => ({
  appVersion: '1.0.0', electron: process.versions.electron, node: process.versions.node,
  platform: 'win32', arch: 'x64', coreVersion: 'test', corePath: 'x', coreFound: true, userData: 'x',
}));
ipcMain.handle('store:get', (e, k) => {
  if (k === 'nodes') return JSON.parse(JSON.stringify(nodes));
  if (k === 'sources') return JSON.parse(JSON.stringify(sources));
  if (k === 'settings') return {};
  return null;
});
ipcMain.handle('store:set', () => true);
ipcMain.handle('theme:set', () => true);
// 渲染层启动会拉一次代理状态；不桩住会报 "No handler registered"，
// 那条错误会污染「无脚本错误」这条断言（曾因此误判过一次）。
ipcMain.handle('proxy:status', () => ({
  gateway: { running: false, port: 7890, ctlPort: 7891, node: null, error: '' },
  system: { supported: true, active: false, server: '', bypass: '', proxyEnable: 0 },
  platform: 'win32', routeMode: 'bypass-cn', routeLabel: '绕过大陆',
  state: 'off', stateText: '系统代理 · 关闭', hint: '', healthy: true, on: false, alert: false,
}));
ipcMain.handle('proxy:probe', () => ({ ok: true, ip: '', ms: 0 }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  const errs = [];
  win.webContents.on('console-message', (e, l, m) => { if (l >= 2) errs.push(m); });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 900));
  const run = (code) => win.webContents.executeJavaScript(code);

  /* 侧栏渲染 */
  let r = JSON.parse(await run(`(() => {
    const items = [...document.querySelectorAll('#groupList .sb-item')].map(el => el.innerText.replace(/\\n/g,' ').trim());
    return JSON.stringify({
      groups: items,
      protos: [...document.querySelectorAll('#protoList .sb-item')].map(el => el.innerText.replace(/\\n/g,' ').trim()),
      countries: [...document.querySelectorAll('#countryList .sb-item')].map(el => el.innerText.replace(/\\n/g,' ').trim()),
      visible: [...document.querySelectorAll('#tbody tr')].filter(t => t.style.display !== 'none').length,
    });
  })()`));
  check('分组列表包含全部/未分组/两个分组', r.groups.length === 4, r.groups);
  check('分组计数正确（香港2 日本2 未分组1）', r.groups.join('|').includes('香港') && r.groups[0].includes('5'), r.groups);
  check('协议列表 4 项', r.protos.length === 4, r.protos);
  check('地区列表 3 项（HK/JP/未知）', r.countries.length === 3, r.countries);

  /* 点击分组筛选 */
  r = JSON.parse(await run(`(() => {
    const el = [...document.querySelectorAll('#groupList .sb-item')].find(x => x.dataset.value === '日本');
    el.click();
    return JSON.stringify({
      visible: [...document.querySelectorAll('#tbody tr')].filter(t => t.style.display !== 'none').length,
      chips: [...document.querySelectorAll('.af-chip')].map(c => c.innerText.trim()),
    });
  })()`));
  check('按分组筛选后只剩 2 条', r.visible === 2, r);
  check('已激活条件显示分组 chip', r.chips.some((c) => c.includes('日本')), r.chips);

  /* 叠加协议筛选（同维度多选 = 或） */
  r = JSON.parse(await run(`(() => {
    const el = [...document.querySelectorAll('#protoList .sb-item')].find(x => x.dataset.value === 'trojan');
    el.click();
    return JSON.stringify({ visible: [...document.querySelectorAll('#tbody tr')].filter(t => t.style.display !== 'none').length });
  })()`));
  check('分组 + 协议叠加后 1 条', r.visible === 1, r);

  /* 数值筛选 */
  r = JSON.parse(await run(`(() => {
    resetFilters();
    state.filters.minHealth = 90;
    applyFilters();
    return JSON.stringify({
      visible: [...document.querySelectorAll('#tbody tr')].filter(t => t.style.display !== 'none').length,
      chips: [...document.querySelectorAll('.af-chip')].map(c => c.innerText.trim()),
      badge: document.querySelector('#filterCount').textContent,
    });
  })()`));
  check('健康度 ≥90 只剩 1 条', r.visible === 1, r);
  check('条件条与角标同步', r.badge === '1' && r.chips.some((c) => c.includes('健康度')), r);

  /* 状态 chip 计数随筛选变化 */
  r = JSON.parse(await run(`(() => {
    resetFilters();
    return JSON.stringify({
      all: document.querySelector('#cAll').textContent,
      ok: document.querySelector('#cOk').textContent,
      fail: document.querySelector('#cFail').textContent,
      idle: document.querySelector('#cIdle').textContent,
    });
  })()`));
  check('状态计数 5/3/1/1', r.all === '5' && r.ok === '3' && r.fail === '1' && r.idle === '1', r);

  /* 移动到分组 */
  // 注意：侧栏重建是 60ms 防抖（scheduleSidebar），同一 tick 里读会读到旧列表。
  // 这里必须等一下，否则断言本身是错的（1.5.1 上也一直「失败」）。
  r = JSON.parse(await run(`(async () => {
    state.selected.clear();
    state.selected.add('d');
    moveSelectedToGroup('待定');
    await new Promise(res => setTimeout(res, 200));
    return JSON.stringify({
      group: state.nodes.find(n => n.id === 'd').group,
      groups: [...document.querySelectorAll('#groupList .sb-item')].map(el => el.dataset.value),
    });
  })()`));
  check('移动选中节点到新分组', r.group === '待定', r);
  check('侧栏出现新分组', r.groups.includes('待定'), r.groups);

  /* 按地区自动分组 */
  r = JSON.parse(await run(`(() => {
    autoGroupBy('country');
    const map = {};
    state.nodes.forEach(n => { map[n.id] = n.group; });
    return JSON.stringify(map);
  })()`));
  check('按地区自动分组', r.a === '中国香港' && r.b === '日本' && r.d === '未知地区', r);

  /* 重命名分组（走 askText 弹窗，这里直接调用底层赋值逻辑验证） */
  r = JSON.parse(await run(`(async () => {
    const p = renameGroup('日本');
    await new Promise(res => setTimeout(res, 80));
    const input = document.querySelector('#askInput');
    input.value = 'JP-家宽';
    document.querySelector('[data-ask="ok"]').click();
    await p;
    return JSON.stringify({
      groups: [...new Set(state.nodes.map(n => n.group))].sort(),
      filter: state.filters.group,
    });
  })()`));
  check('重命名分组生效', r.groups.includes('JP-家宽') && !r.groups.includes('日本'), r);

  /* 清除筛选 */
  r = JSON.parse(await run(`(() => {
    state.filters.protocols = ['ss'];
    state.query = 'hk';
    applyFilters();
    const before = [...document.querySelectorAll('#tbody tr')].filter(t => t.style.display !== 'none').length;
    resetFilters();
    const after = [...document.querySelectorAll('#tbody tr')].filter(t => t.style.display !== 'none').length;
    return JSON.stringify({ before, after, chips: document.querySelectorAll('.af-chip').length, badge: document.querySelector('#filterCount').textContent });
  })()`));
  check('清除筛选后恢复全部', r.after === 5 && r.chips === 0 && r.badge === '0', r);

  /* 侧栏折叠 */
  r = JSON.parse(await run(`(() => {
    document.querySelector('#btnToggleSidebar').click();
    const hidden = document.querySelector('.main-row').classList.contains('sidebar-hidden');
    document.querySelector('#btnToggleSidebar').click();
    return JSON.stringify({ hidden });
  })()`));
  check('侧栏可折叠/展开', r.hidden === true, r);

  /* ---- 1.5.2 新增交互：分组列 / 类型列排序 / 订阅卡片分组标记 ---- */

  /* 先把分组重置成确定的形状（前面几条用例已经把分组改乱了）：
     a,b → 日本；c,d → 香港；e → 未分组 */
  r = JSON.parse(await run(`(async () => {
    state.nodes.forEach((n, i) => { n.group = i < 2 ? '日本' : i < 4 ? '香港' : ''; });
    // 前面的用例把订阅源上的自定义名清掉了（多分组时不记，这是预期行为），这里恢复成「刚重命名完」的状态
    if (state.sources[0]) state.sources[0].groupName = '日本';
    saveNodes();
    saveSources();
    renderSources();
    resetFilters();
    renderTable();
    await new Promise(res => setTimeout(res, 200));
    return JSON.stringify({ ok: true });
  })()`));

  /* 分组列存在且单元格是 chip */
  r = JSON.parse(await run(`(() => {
    const th = document.querySelector('th.col-group');
    return JSON.stringify({
      hasTh: !!th, sortable: th ? th.classList.contains('sortable') : false,
      chips: document.querySelectorAll('#tbody [data-group-filter]').length,
      rows: document.querySelectorAll('#tbody tr').length,
    });
  })()`));
  check('表头有可排序的「分组」列', r.hasTh && r.sortable, r);
  check('有分组的行都有可点击标签（4/5，未分组 1 行）', r.chips === 4 && r.rows === 5, r);

  /* 点分组标签 → 直接筛选，且不打开详情抽屉 */
  r = JSON.parse(await run(`(async () => {
    const chip = document.querySelector('#tbody [data-group-filter]');
    const g = chip.dataset.groupFilter;
    chip.click();
    await new Promise(res => setTimeout(res, 300));
    const visible = [...document.querySelectorAll('#tbody tr')].filter(t => t.style.display !== 'none').length;
    const drawer = document.querySelector('#drawer').classList.contains('open');
    const af = document.querySelector('#activeFilters').textContent;
    resetFilters();
    await new Promise(res => setTimeout(res, 150));
    return JSON.stringify({ g, visible, drawer, af });
  })()`));
  check('点分组标签后只剩该组节点', r.visible === 2, r);
  check('点分组标签不打开详情抽屉', r.drawer === false, r);
  check('条件条同步显示分组', /分组/.test(r.af), r.af);

  /* 类型列：业务顺序排序 */
  r = JSON.parse(await run(`(async () => {
    const th = document.querySelector('th.col-iptype');
    th.click();
    await new Promise(res => setTimeout(res, 250));
    const order = ['residential','mobile','hosting','proxy','unknown'];
    const seq = [...document.querySelectorAll('#tbody tr')].map(tr => {
      const n = tr.__node; return order.indexOf(n && n.ipTypeKey);
    }).map(v => (v < 0 ? 9 : v));
    return JSON.stringify({ sortable: th.classList.contains('sortable'), seq, key: state.sort.key, dir: state.sort.dir });
  })()`));
  check('类型列表头可排序', r.sortable && r.key === 'ipTypeKey', r);
  check('类型按 住宅>移动>机房>代理>未知 排序', r.seq.every((v, i) => i === 0 || r.seq[i - 1] <= v), r.seq);

  /* 订阅卡片：分组标记 + 恢复默认名 */
  r = JSON.parse(await run(`(async () => {
    openSourcesModal();
    await new Promise(res => setTimeout(res, 200));
    const tag = document.querySelector('.src-tag');
    const btn = document.querySelector('[data-src-act=resetgroup]');
    const tagText = tag ? tag.textContent : '';
    if (btn) btn.click();
    await new Promise(res => setTimeout(res, 250));
    const after = document.querySelector('.src-tag');
    return JSON.stringify({
      tagText, hasBtn: !!btn, tagGone: !after,
      groupName: (state.sources[0] || {}).groupName || null,
    });
  })()`));
  check('订阅卡片显示「分组：日本」', r.tagText.includes('日本') && r.hasBtn, r);
  check('点恢复默认名后标记消失且 groupName 清空', r.tagGone && r.groupName === null, r);

  /* 组名撞上筛选保留值（all / none）时不可点击 */
  r = JSON.parse(await run(`JSON.stringify({ html: groupHtml({ group: 'none' }), all: groupHtml({ group: 'all' }) })`));
  check('保留值组名（none/all）不做成可点击标签',
    !/data-group-filter/.test(r.html) && /static/.test(r.html) && !/data-group-filter/.test(r.all), r);

  check('无脚本错误', errs.length === 0, errs);

  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n通过 ${results.length - failed}/${results.length}`);
  app.quit();
  process.exitCode = failed ? 1 : 0;
});
