'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store, DEFAULT_SETTINGS } = require('./lib/store');
const parser = require('./lib/parser');
const { CoreManager } = require('./lib/core');
const { Runner } = require('./lib/runner');
const { SystemProxy, DEFAULT_BYPASS } = require('./lib/sysproxy');
const { Gateway, DEFAULT_PORT } = require('./lib/gateway');

const isDev = process.argv.includes('--dev');

let win = null;
let store = null;
let core = null;
let runner = null;
let gateway = null;
let sysproxy = null;
let quitting = false;

/* ------------------------------------------------------------------ */
/* 路径                                                                */
/* ------------------------------------------------------------------ */

function resolveCorePath() {
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'core', 'mihomo.exe'));
  }
  candidates.push(path.join(__dirname, '..', 'vendor', 'mihomo.exe'));
  candidates.push(path.join(app.getPath('userData'), 'core', 'mihomo.exe'));
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[candidates.length - 1];
}

/* ------------------------------------------------------------------ */
/* 订阅拉取                                                            */
/* ------------------------------------------------------------------ */

const { fetchSubscription } = require('./lib/subscribe');

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 660,
    show: false,
    backgroundColor: '#0e1015',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0e1015',
      symbolColor: '#9aa3b2',
      height: 44,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  });

  // 调试用：V2P_DEBUG=1 时打印渲染层日志与关键节点自检结果
  if (process.env.V2P_DEBUG) {
    win.webContents.on('console-message', (e, level, message) => {
      console.log('[renderer]', message);
    });
    win.webContents.on('did-finish-load', async () => {
      try {
        const probe = await win.webContents.executeJavaScript(
          `({ apiKeys: Object.keys(window.api || {}).length,
              hasProxyBtn: !!document.querySelector('#btnProxy'),
              hasProxyBadge: !!document.querySelector('#proxyBadge'),
              hasPortInput: !!document.querySelector('#setProxyPort'),
              state: typeof state !== 'undefined' ? { nodes: state.nodes.length, proxy: state.proxy } : null })`
        );
        console.log('[smoke]', JSON.stringify(probe));
      } catch (err) {
        console.log('[smoke] 失败:', err.message);
      }
    });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ------------------------------------------------------------------ */
/* 系统代理                                                            */
/* ------------------------------------------------------------------ */

function currentSettings() {
  return { ...DEFAULT_SETTINGS, ...store.read('settings.json', {}) };
}

function sendProxyState() {
  if (!win || win.isDestroyed()) return;
  proxyStatus()
    .then((st) => win.webContents.send('proxy:state', st))
    .catch(() => {});
}

async function proxyStatus() {
  const gw = gateway ? gateway.status() : { running: false, port: 0, node: null };
  const sys = sysproxy ? await sysproxy.status() : { supported: false, active: false };
  return {
    gateway: gw,
    system: sys,
    platform: process.platform,
    // 「真正生效」= 内核在跑 且 系统代理指向这个内核端口
    on: !!(gw.running && sys.active && sys.server === `127.0.0.1:${gw.port}`),
  };
}

/**
 * 开启系统代理：启动/切换到目标节点 → 把 Windows 系统代理指向本地 mixed 端口
 * @param {string} nodeId 节点 id
 */
async function enableSystemProxy(nodeId) {
  if (process.platform !== 'win32') throw new Error('系统代理设置目前仅支持 Windows');
  const nodes = store.read('nodes.json', []);
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error('找不到该节点，请重新导入后再试');

  const s = currentSettings();
  const wantPort = Number(s.systemProxyPort) || DEFAULT_PORT;
  const bypass = s.systemProxyBypass && String(s.systemProxyBypass).trim() ? String(s.systemProxyBypass).trim() : DEFAULT_BYPASS;

  const sameNode = gateway.running && gateway.node && gateway.node.id === node.id;
  if (!sameNode || gateway.port !== wantPort) {
    await gateway.start(node, { port: wantPort });
  }

  try {
    await sysproxy.apply({ port: gateway.port, bypass, winhttp: !!s.systemProxyWinhttp });
  } catch (err) {
    await gateway.stop().catch(() => {});
    throw err;
  }

  sendProxyState();
  return proxyStatus();
}

/** 关闭系统代理：先还原系统设置，再停内核（避免流量打到已关闭的端口） */
async function disableSystemProxy() {
  let restoreErr = null;
  if (sysproxy) {
    try {
      await sysproxy.restore();
    } catch (err) {
      restoreErr = err;
    }
  }
  // 还原失败就保留内核，否则用户会处于「代理指向死端口」的状态
  if (!restoreErr && gateway) await gateway.stop();
  sendProxyState();
  if (restoreErr) throw new Error('还原系统代理失败：' + restoreErr.message);
  return proxyStatus();
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  store = new Store(userData);
  nativeTheme.themeSource = 'dark';

  core = new CoreManager({
    corePath: resolveCorePath(),
    dataDir: path.join(userData, 'core-data'),
    onLog: (msg) => {
      if (win && !win.isDestroyed()) win.webContents.send('core:log', msg);
    },
  });

  sysproxy = new SystemProxy({ dataDir: path.join(userData, 'sysproxy') });

  gateway = new Gateway({
    corePath: resolveCorePath(),
    dataDir: path.join(userData, 'gateway'),
    onLog: (msg) => {
      if (win && !win.isDestroyed()) win.webContents.send('core:log', msg);
    },
    onExit: async ({ error }) => {
      // 内核意外退出：立刻还原系统代理，否则整台电脑会断网
      try {
        const sys = await sysproxy.status();
        if (sys.active) await sysproxy.restore();
      } catch (e) {}
      sendProxyState();
      if (win && !win.isDestroyed()) {
        win.webContents.send('proxy:error', error || '代理内核已退出，系统代理已自动还原');
      }
    },
  });

  // 上次异常退出可能残留系统代理设置，启动时先还原
  try {
    const rec = await sysproxy.recoverIfStale();
    if (rec.recovered) console.log('已还原上次遗留的系统代理设置:', rec.target);
  } catch (e) {
    console.error('检查遗留系统代理失败:', e.message);
  }

  createWindow();

  // 自动化冒烟测试用：启动后自动退出（会走完整的还原 + 退出流程）
  if (process.env.V2P_EXIT_AFTER) {
    setTimeout(() => app.quit(), Number(process.env.V2P_EXIT_AFTER) || 5000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (core) await core.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  try {
    // 退出前必须还原系统代理，否则用户会「上不了网」
    if (sysproxy) await sysproxy.restore().catch(() => {});
    if (gateway) await gateway.stop();
    if (core) await core.stop();
  } finally {
    app.exit(0);
  }
});

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

ipcMain.handle('app:info', async () => {
  const coreVersion = await core.version();
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    coreVersion,
    corePath: core.corePath,
    coreFound: fs.existsSync(core.corePath),
    userData: app.getPath('userData'),
  };
});

ipcMain.handle('store:get', (e, key) => {
  if (key === 'nodes') return store.read('nodes.json', []);
  if (key === 'settings') return { ...DEFAULT_SETTINGS, ...store.read('settings.json', {}) };
  if (key === 'sources') return store.read('sources.json', []);
  return null;
});

ipcMain.handle('store:set', (e, key, value) => {
  if (key === 'nodes') return store.write('nodes.json', value);
  if (key === 'settings') return store.write('settings.json', value);
  if (key === 'sources') return store.write('sources.json', value);
  return false;
});

ipcMain.handle('import:parse', (e, payload) => {
  const { text, opts } = payload || {};
  const res = parser.parseText(text, opts || {});
  return res;
});

ipcMain.handle('import:fetch', async (e, url) => {
  const text = await fetchSubscription(url);
  const res = parser.parseText(text, { group: new URL(url).hostname, source: url });
  return { nodes: res.nodes, errors: res.errors, format: res.format, bytes: text.length };
});

ipcMain.handle('import:file', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择代理配置文件',
    properties: ['openFile'],
    filters: [
      { name: '代理配置', extensions: ['txt', 'yaml', 'yml', 'json', 'conf', 'list'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const file = r.filePaths[0];
  const text = fs.readFileSync(file, 'utf8');
  const res = parser.parseText(text, { group: path.basename(file), source: file });
  return { file, text, ...res };
});

ipcMain.handle('test:run', async (e, payload) => {
  if (runner) return { error: '已有测试任务在运行' };
  const { nodes, mode, settings } = payload || {};
  if (!nodes || !nodes.length) return { error: '没有可测试的节点' };

  runner = new Runner({
    core,
    settings: settings || {},
    emit: (ev) => {
      if (win && !win.isDestroyed()) win.webContents.send('test:event', ev);
    },
  });

  try {
    const r = await runner.run(nodes, mode || 'full');
    return r;
  } catch (err) {
    return { error: err.message };
  } finally {
    runner = null;
    await core.stop();
  }
});

ipcMain.handle('test:cancel', async () => {
  if (runner) runner.cancel();
  return true;
});

ipcMain.handle('core:restart', async (e, nodes) => {
  await core.start(nodes || []);
  return { ok: true, ports: core.portMap.size };
});

ipcMain.handle('export:save', async (e, payload) => {
  const { format, content, defaultName } = payload || {};
  const filters =
    format === 'json'
      ? [{ name: 'JSON', extensions: ['json'] }]
      : format === 'csv'
        ? [{ name: 'CSV', extensions: ['csv'] }]
        : [{ name: '文本', extensions: ['txt'] }];
  const r = await dialog.showSaveDialog(win, {
    title: '导出结果',
    defaultPath: defaultName || 'iphealth-export',
    filters,
  });
  if (r.canceled || !r.filePath) return { ok: false };
  fs.writeFileSync(r.filePath, content, 'utf8');
  return { ok: true, path: r.filePath };
});

ipcMain.handle('theme:set', (e, theme) => {
  const light = theme === 'light';
  nativeTheme.themeSource = light ? 'light' : 'dark';
  if (win && !win.isDestroyed()) {
    try {
      win.setTitleBarOverlay({
        color: light ? '#f5f7fb' : '#0e1015',
        symbolColor: light ? '#5c6579' : '#9aa3b2',
        height: 44,
      });
    } catch (err) {}
    win.setBackgroundColor(light ? '#f5f7fb' : '#0e1015');
  }
  return true;
});

ipcMain.handle('shell:open', (e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

ipcMain.handle('app:openDataDir', () => {
  shell.openPath(app.getPath('userData'));
});

/* ------------------------------------------------------------------ */
/* 系统代理 IPC                                                        */
/* ------------------------------------------------------------------ */

ipcMain.handle('proxy:status', async () => {
  try {
    return await proxyStatus();
  } catch (err) {
    return { error: err.message, on: false };
  }
});

ipcMain.handle('proxy:enable', async (e, nodeId) => {
  if (runner) return { error: '检测进行中，请等待检测结束后再开启系统代理' };
  try {
    const st = await enableSystemProxy(nodeId);
    return st;
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('proxy:disable', async () => {
  try {
    return await disableSystemProxy();
  } catch (err) {
    return { error: err.message };
  }
});

/** 已开启时换节点：端口不变，系统代理无需改动 */
ipcMain.handle('proxy:switch', async (e, nodeId) => {
  if (!gateway.running) return { error: '系统代理未开启' };
  const nodes = store.read('nodes.json', []);
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return { error: '找不到该节点' };
  try {
    await gateway.switchNode(node);
    sendProxyState();
    return await proxyStatus();
  } catch (err) {
    return { error: err.message };
  }
});

/** 通过本地网关取一次出口 IP，校验代理真的通了 */
ipcMain.handle('proxy:probe', async () => {
  try {
    const r = await gateway.probe({ timeout: 9000 });
    return r;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('proxy:bypassDefault', () => DEFAULT_BYPASS);
