'use strict';

/** 界面布局自检：npx electron scripts/check-ui.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const shot = fs.readFileSync(path.join(__dirname, 'shot.js'), 'utf8');
// 复用 shot.js 的 mock 数据
const mockSrc = shot.slice(shot.indexOf('const types ='), shot.indexOf("ipcMain.handle('app:info'"));
const mock = eval(mockSrc + ';({nodes})');
const nodes = mock.nodes;

ipcMain.handle('app:info', () => ({
  appVersion: '1.0.0', electron: process.versions.electron, node: process.versions.node,
  platform: 'win32', arch: 'x64', coreVersion: 'mihomo v1.19.33',
  corePath: 'C:\\Program Files\\IPHealth\\resources\\core\\mihomo.exe', coreFound: true,
  userData: 'C:\\Users\\User\\AppData\\Roaming\\IPHealth',
}));
ipcMain.handle('store:get', (e, key) => {
  if (key === 'nodes') return nodes;
  if (key === 'settings') return {};
  if (key === 'sources') return [{ id: 's1', url: 'https://sub.example.com/x?token=1', group: 'sub.example.com', count: 12, lastSync: Date.now() }];
  return null;
});
ipcMain.handle('store:set', () => true);
ipcMain.handle('theme:set', () => true);
// 系统代理：界面自检里给一个「已开启」状态，验证徽标与工具栏文案
ipcMain.handle('proxy:status', () => ({
  gateway: {
    running: true, port: 7890, ctlPort: 7891, pid: 1234,
    routeMode: 'bypass-cn', routeLabel: '绕过大陆',
    node: { id: 'n1', name: 'HK-01 香港 IEPL', type: 'ss', server: '1.2.3.4', port: 443 },
    startedAt: Date.now() - 754000, uptime: 754,
    lastProbe: { ok: true, ip: '203.0.113.45', ms: 87, at: Date.now() - 12000, error: '' },
    error: '',
  },
  system: { supported: true, active: true, server: '127.0.0.1:7890', bypass: 'localhost;127.*;<local>', proxyEnable: 1, lastError: '' },
  platform: 'win32', routeMode: 'bypass-cn', routeLabel: '绕过大陆',
  state: 'on', stateText: '系统代理 · 绕过大陆', hint: '', healthy: true, on: true, alert: false,
}));
ipcMain.handle('proxy:probe', () => ({ ok: true, ip: '203.0.113.45', ms: 87 }));

const checks = `(() => {
  const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const out = {
    win: { w: innerWidth, h: innerHeight },
    bodyScroll: { w: document.body.scrollWidth, h: document.body.scrollHeight },
    titlebar: r('.titlebar'),
    toolbar: r('.toolbar'),
    stats: r('.stats'),
    statCards: [...document.querySelectorAll('.stat')].map(e => Math.round(e.getBoundingClientRect().width)),
    tableWrap: r('.table-wrap'),
    tableScroll: r('.table-scroll'),
    statusbar: r('.statusbar'),
    rows: document.querySelectorAll('#tbody tr').length,
    visibleRows: [...document.querySelectorAll('#tbody tr')].filter(t => t.style.display !== 'none').length,
    firstRowCells: [...document.querySelectorAll('#tbody tr:first-child td')].map(td => td.innerText.trim().slice(0, 18)),
    headerCells: [...document.querySelectorAll('.grid thead th')].map(th => th.innerText.trim()),
    tableWidth: Math.round(document.querySelector('.grid').getBoundingClientRect().width),
    scrollWidth: document.querySelector('.table-scroll').scrollWidth,
    statValues: [...document.querySelectorAll('.stat-value')].map(e => e.innerText.trim()),
    healthBars: document.querySelectorAll('.health-bar i').length,
    overflowX: document.documentElement.scrollWidth > innerWidth,
    toolbarBtnCount: document.querySelectorAll('.toolbar .btn').length,
    coreText: document.querySelector('#coreText').textContent,
    emptyShown: document.querySelector('#emptyState').classList.contains('show'),
    syncBtn: !!document.querySelector('#btnSync'),
    toolbarBtns: [...document.querySelectorAll('.toolbar .btn')].map(b => b.innerText.trim()).filter(Boolean),
  };
  return JSON.stringify(out, null, 1);
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (e, level, msg) => {
    if (level >= 2) errors.push(msg);
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));
  const res = await win.webContents.executeJavaScript(checks);
  console.log(res);
  console.log('console errors:', errors.length ? errors : 'none');

  // 小窗口自适应
  win.setSize(1080, 660);
  await new Promise((r) => setTimeout(r, 400));
  const res2 = await win.webContents.executeJavaScript(checks);
  console.log('--- 1080x660 ---');
  console.log(res2);

  // 设置弹窗：确认「订阅拉取代理」字段存在且能回填（1.0.6 新增）
  const settingsCheck = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#btnSettings').click();
    const el = document.querySelector('#setSubProxy');
    return JSON.stringify({
      modalOpen: document.querySelector('#settingsModal').classList.contains('open'),
      hasSubProxy: !!el,
      subProxyValue: el ? el.value : null,
      subProxyVisible: el ? el.getBoundingClientRect().height > 0 : false,
    });
  })()`);
  console.log('--- 设置弹窗 ---');
  console.log(settingsCheck);
  console.log('console errors:', errors.length ? errors : 'none');
  app.quit();
});
