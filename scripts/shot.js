'use strict';

/** 界面截图工具：npx electron scripts/shot.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const types = ['vmess', 'vless', 'trojan', 'ss', 'hysteria2', 'tuic', 'ssr', 'anytls', 'socks5', 'http'];
const countries = [
  ['中国香港', 'HK', '香港', 'HKT Limited', 'AS4760'],
  ['日本', 'JP', '东京', 'NTT Communications', 'AS4713'],
  ['美国', 'US', '洛杉矶', 'Cloudflare Inc', 'AS13335'],
  ['新加坡', 'SG', '新加坡', 'DigitalOcean', 'AS14061'],
  ['德国', 'DE', '法兰克福', 'Hetzner Online', 'AS24940'],
  ['韩国', 'KR', '首尔', 'Korea Telecom', 'AS4766'],
  ['中国台湾', 'TW', '台北', 'Chunghwa Telecom', 'AS3462'],
  ['英国', 'GB', '伦敦', 'OVH SAS', 'AS16276'],
];

const nodes = [];
for (let i = 0; i < 14; i += 1) {
  const t = types[i % types.length];
  const c = countries[i % countries.length];
  const ok = i !== 4 && i !== 11;
  nodes.push({
    id: 'n' + i,
    name: `${c[0]} ${['高速', '流媒体', '家宽', '中转'][i % 4]}-0${i + 1}`,
    type: t,
    server: `${['hk', 'jp', 'us', 'sg', 'de', 'kr', 'tw', 'uk'][i % 8]}${i}.example.com`,
    port: 443,
    conf: { uuid: 'b831381d', tls: true },
    raw: `${t}://example`,
    group: [c[0]][0],
    enabled: true,
    tcp: ok ? 40 + i * 7 : null,
    latency: ok ? 60 + i * 23 : null,
    jitter: ok ? 4 + i * 3 : null,
    speed: ok ? Math.round((18 - i * 1.1) * 10) / 10 : null,
    ip: ok ? `104.${18 + i}.${40 + i}.${100 + i}` : '',
    country: ok ? c[0] : '',
    countryCode: ok ? c[1] : '',
    region: ok ? c[2] : '',
    city: ok ? c[2] : '',
    isp: ok ? c[3] : '',
    asn: ok ? c[4] : '',
    ipType: ok ? (i % 3 === 0 ? '住宅宽带' : i % 3 === 1 ? '机房 IDC' : '代理/VPN') : '',
    proxyFlag: ok ? i % 3 === 2 : null,
    hostingFlag: ok ? i % 3 === 1 : null,
    mobileFlag: false,
    dnsbl: ok ? [] : null,
    health: ok ? 96 - i * 4 : null,
    status: ok ? 'ok' : 'fail',
    error: ok ? '' : 'TCP 连接失败: ETIMEDOUT',
    testedAt: Date.now(),
  });
}

ipcMain.handle('app:info', () => ({
  appVersion: '1.0.0',
  electron: process.versions.electron,
  node: process.versions.node,
  platform: 'win32',
  arch: 'x64',
  coreVersion: 'mihomo v1.19.33',
  corePath: 'C:\\Program Files\\IPHealth\\resources\\core\\mihomo.exe',
  coreFound: true,
  userData: 'C:\\Users\\User\\AppData\\Roaming\\IPHealth',
}));
const sources = [
  { id: 's1', url: 'https://sub.example.com/api/v1/client/subscribe?token=8f3ac1', group: 'sub.example.com', count: 12, format: 'Clash YAML', lastSync: Date.now() - 3600000 },
  { id: 's2', url: 'https://airport.example.net/api/v1/client/subscribe?token=xx91k2', group: 'airport.example.net', count: 9, format: 'Base64 订阅', lastSync: Date.now() - 86400000, error: '' },
];

ipcMain.handle('store:get', (e, key) => {
  if (key === 'nodes') return nodes;
  if (key === 'sources') return sources;
  if (key === 'settings') return { concurrency: 8, latencyTimeout: 8000, speedTimeout: 20000, speedBytes: 10, speedSource: 'cloudflare', deepHealth: true, latencyUrls: [], ipUrls: [], plainType: 'socks5' };
  return null;
});
ipcMain.handle('store:set', () => true);
ipcMain.handle('theme:set', () => true);
// 系统代理：截图里展示「已开启」的健康态，文案/徽标配色才看得出效果
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

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#0e1015',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e1015', symbolColor: '#9aa3b2', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1600));
  const img = await win.capturePage();
  const out = path.join(__dirname, '..', '.shots', 'main.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toPNG());
  console.log('saved', out);

  // 导入弹窗
  await win.webContents.executeJavaScript("document.querySelector('#btnImport').click()");
  await new Promise((r) => setTimeout(r, 700));
  fs.writeFileSync(path.join(__dirname, '..', '.shots', 'import.png'), (await win.capturePage()).toPNG());
  console.log('saved import.png');

  // 高级筛选面板
  await win.webContents.executeJavaScript("document.querySelector('#btnFilter').click()");
  await new Promise((r) => setTimeout(r, 500));
  fs.writeFileSync(path.join(__dirname, '..', '.shots', 'filter.png'), (await win.capturePage()).toPNG());
  console.log('saved filter.png');
  await win.webContents.executeJavaScript("document.querySelector('#btnFilter').click();");

  // 订阅源管理
  await win.webContents.executeJavaScript("document.querySelector('[data-close=importModal]').click(); openSourcesModal();");
  await new Promise((r) => setTimeout(r, 700));
  fs.writeFileSync(path.join(__dirname, '..', '.shots', 'sources.png'), (await win.capturePage()).toPNG());
  console.log('saved sources.png');
  await win.webContents.executeJavaScript("document.querySelector('[data-close=sourcesModal]').click();");

  // 关闭弹窗 + 详情抽屉
  await win.webContents.executeJavaScript("document.querySelector('[data-close=importModal]').click(); document.querySelector('#tbody tr').click();");
  await new Promise((r) => setTimeout(r, 800));
  fs.writeFileSync(path.join(__dirname, '..', '.shots', 'drawer.png'), (await win.capturePage()).toPNG());
  console.log('saved drawer.png');

  app.quit();
});
