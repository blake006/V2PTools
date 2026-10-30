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
  app.quit();
});
