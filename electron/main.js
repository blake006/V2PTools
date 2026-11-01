'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store, DEFAULT_SETTINGS } = require('./lib/store');
const parser = require('./lib/parser');
const { CoreManager } = require('./lib/core');
const { Runner } = require('./lib/runner');
const clash = require('./lib/clash');
const { SystemProxy, DEFAULT_BYPASS } = require('./lib/sysproxy');
const { Gateway, DEFAULT_PORT, ROUTE_MODES } = require('./lib/gateway');
const { deriveProxyState, pickRouteMode, STATE_TEXT } = require('./lib/proxyState');

const isDev = process.argv.includes('--dev');

let win = null;
let store = null;
let core = null;
let runner = null;
let gateway = null;
let sysproxy = null;
let quitting = false;

/** 启动阶段日志：仅 V2P_DEBUG 时写入 userData/boot.log（打包版没有控制台，靠它排错） */
function bootLog(msg) {
  if (!process.env.V2P_DEBUG) return;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'boot.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch (e) {}
}

process.on('uncaughtException', (err) => bootLog('uncaughtException: ' + (err && err.stack ? err.stack : err)));
process.on('unhandledRejection', (err) => bootLog('unhandledRejection: ' + (err && err.stack ? err.stack : err)));

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

/** 分流规则目录（随包分发的 assets/rules） */
function resolveRulesDir() {
  const candidates = [];
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'rules'));
  candidates.push(path.join(__dirname, '..', 'assets', 'rules'));
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
  bootLog('createWindow 开始');
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

  bootLog('BrowserWindow 已创建，加载页面');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('did-fail-load', (e, code, desc, url) => bootLog(`did-fail-load ${code} ${desc} ${url}`));
  win.webContents.on('render-process-gone', (e, d) => bootLog('render-process-gone ' + JSON.stringify(d)));
  win.once('ready-to-show', () => {
    bootLog('ready-to-show');
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  });

  // 调试用：V2P_DEBUG=1 时打印渲染层日志与关键节点自检结果
  // 打包版是无控制台的 GUI 程序，结果同时写到 userData/smoke.json 方便验证
  if (process.env.V2P_DEBUG) {
    const logs = [];
    const writeSmoke = (payload) => {
      try {
        fs.writeFileSync(path.join(app.getPath('userData'), 'smoke.json'), JSON.stringify(payload, null, 2), 'utf8');
      } catch (e) {}
    };
    win.webContents.on('console-message', (e, level, message) => {
      logs.push(message);
      console.log('[renderer]', message);
    });
    win.webContents.on('did-finish-load', async () => {
      try {
        const probe = await win.webContents.executeJavaScript(
          `({ title: document.title,
              apiKeys: Object.keys(window.api || {}).length,
              hasProxyBtn: !!document.querySelector('#btnProxy'),
              hasProxyBadge: !!document.querySelector('#proxyBadge'),
              hasPortInput: !!document.querySelector('#setProxyPort'),
              hasRouteMenu: !!document.querySelector('#proxyMenu [data-route="bypass-cn"]'),
              hasRouteSelect: !!document.querySelector('#setRouteMode'),
              brand: (document.querySelector('.brand-name') || {}).textContent,
              btnText: (document.querySelector('#btnProxyText') || {}).textContent,
              badgeText: (document.querySelector('#proxyBadgeText') || {}).textContent,
              state: typeof state !== 'undefined' ? { nodes: state.nodes.length, route: state.settings.routeMode, proxy: state.proxy } : null })`
        );
        writeSmoke({ ok: true, probe, logs, at: new Date().toISOString() });
        console.log('[smoke]', JSON.stringify(probe));
      } catch (err) {
        writeSmoke({ ok: false, error: err.message, logs, at: new Date().toISOString() });
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

/**
 * 代理状态：见 electron/lib/proxyState.js 的状态机说明。
 * 这里只负责组装 gateway / sysproxy / settings 三份数据。
 */
async function proxyStatus() {
  const gw = gateway ? gateway.status() : { running: false, port: 0, node: null };
  const sys = sysproxy ? await sysproxy.status() : { supported: false, active: false };
  const s = store ? currentSettings() : {};

  const state = deriveProxyState(gw, sys);

  // 分流方式以谁为准：内核在跑用内核的实际值，没跑用保存的设置。
  // 详见 proxyState.js 的 pickRouteMode 注释（这里曾出现「关掉代理后改模式不生效」）。
  const routeMode = pickRouteMode(gw, s);
  const routeLabel = (ROUTE_MODES[routeMode] || ROUTE_MODES.global).label;

  // 每种状态给一句人话，避免用户对着徽标猜
  const hint = {
    off: '',
    on: `已生效：系统流量 → ${sys.server}（${routeLabel}）`,
    starting: '内核正在启动，请稍候…',
    hijacked: `系统代理已被其它程序改为 ${sys.server || '未设置'}，本工具不再生效。重新开启即可抢回。`,
    orphan: `系统代理仍指向 ${sys.server}，但代理内核已退出 —— 可能无法上网。点击可关闭并还原。`,
    foreign: `系统代理当前指向 ${sys.server}（非本工具）。开启后会被接管。`,
  }[state];

  return {
    gateway: gw,
    system: sys,
    platform: process.platform,
    routeMode,
    routeLabel,
    routeModes: ROUTE_MODES,
    state,
    stateText: state === 'on' ? `${STATE_TEXT.on}· ${routeLabel}` : STATE_TEXT[state] || STATE_TEXT.off,
    hint,
    healthy: state === 'on',
    // 「真正生效」= 内核在跑 且 系统代理指向这个内核端口
    on: state === 'on',
    // 需要用户注意的异常态
    alert: state === 'hijacked' || state === 'orphan' || state === 'foreign',
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
  const routeMode = ROUTE_MODES[s.routeMode] ? s.routeMode : 'global';
  const bypass = s.systemProxyBypass && String(s.systemProxyBypass).trim() ? String(s.systemProxyBypass).trim() : DEFAULT_BYPASS;

  const sameNode = gateway.running && gateway.node && gateway.node.id === node.id;
  if (!sameNode || gateway.port !== wantPort || gateway.routeMode !== routeMode) {
    await gateway.start(node, { port: wantPort, routeMode });
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
/* 代理状态看守：把「已关闭」之外的异常态主动推给界面                     */
/* ------------------------------------------------------------------ */

let watchTimer = null;
let lastWatchSig = '';
let watchFails = 0;

/**
 * 定期自检：
 *  1. 内核是否还活着（external-controller + mixed 端口）
 *  2. 系统代理是否还指向本工具（防止被其它软件改掉）
 *  3. 每 30s 做一次真实出口探测，保证绿灯不是假的
 * 只有状态签名变化时才推送，避免界面频繁重绘。
 *
 * 空闲时（系统代理没开）自动放慢到 20s，别为了看一个「还是关着」白白跑 reg query。
 */
const WATCH_IDLE_MS = 20000;
const WATCH_ACTIVE_MS = 5000;
const WATCH_MAX_BACKOFF = 60000;

function startProxyWatch() {
  if (watchTimer) return;
  let tick = 0;

  const schedule = () => {
    const active = !!(gateway && gateway.running);
    // 连续失败时指数退避，避免在受限环境下疯狂刷日志
    const base = active ? WATCH_ACTIVE_MS : WATCH_IDLE_MS;
    const delay = watchFails ? Math.min(base * Math.pow(2, watchFails), WATCH_MAX_BACKOFF) : base;
    watchTimer = setTimeout(run, delay);
  };

  const run = async () => {
    watchTimer = null;
    if (!gateway || !win || win.isDestroyed()) return schedule();
    tick += 1;
    try {
      // 1. 内核存活自检（不依赖外部命令，先做）
      if (gateway.running) {
        const alive = await gateway.alive();
        gateway.aliveFlag = alive;
        if (!alive) bootLog('看守：网关内核无响应，标记为异常');
        // 3. 每 30s（约 6 个 tick）做一次真实出口探测
        if (alive && tick % 6 === 0) await gateway.probeWithCache({ timeout: 8000 });
      } else {
        gateway.aliveFlag = false;
      }

      // 2. 系统代理是否被外部改动（这一步要调 reg query）
      const st = await proxyStatus();
      watchFails = 0;
      const probe = st.gateway.lastProbe;
      const sig = `${st.state}|${st.gateway.port}|${st.gateway.node ? st.gateway.node.id : ''}|${st.system.server}|${probe ? probe.ok : ''}|${probe ? probe.ip : ''}`;
      if (sig !== lastWatchSig) {
        lastWatchSig = sig;
        win.webContents.send('proxy:state', st);
      }
    } catch (e) {
      // 权限受限（沙箱）或系统调用失败：计数退避，只在首次记录，别刷屏
      watchFails += 1;
      if (watchFails === 1) bootLog('看守循环异常（将自动退避重试）: ' + e.message);
    }
    schedule();
  };

  schedule();
}

function stopProxyWatch() {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = null;
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  bootLog('whenReady 触发');
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

  bootLog('Store/CoreManager 就绪');
  sysproxy = new SystemProxy({ dataDir: path.join(userData, 'sysproxy') });

  gateway = new Gateway({
    corePath: resolveCorePath(),
    rulesDir: resolveRulesDir(),
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

  bootLog('Gateway 就绪，检查遗留系统代理');
  // 上次异常退出可能残留系统代理设置，启动时先还原
  try {
    const rec = await sysproxy.recoverIfStale();
    if (rec.recovered) console.log('已还原上次遗留的系统代理设置:', rec.target);
  } catch (e) {
    console.error('检查遗留系统代理失败:', e.message);
  }

  bootLog('开始创建窗口');
  createWindow();
  bootLog('窗口创建完成');

  startProxyWatch();

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
  stopProxyWatch();
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

/** 导出为 Clash / mihomo 配置（YAML）—— 同步自 IPHealth 1.0.3 */
ipcMain.handle('export:clash', async (e, payload) => {
  const { nodes, defaultName, opts } = payload || {};
  let built;
  try {
    built = clash.buildClashYaml(nodes || [], opts || {});
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const r = await dialog.showSaveDialog(win, {
    title: '导出 Clash 配置',
    defaultPath: defaultName || 'v2ptools-clash',
    filters: [{ name: 'Clash 配置', extensions: ['yaml', 'yml'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, built.text, 'utf8');
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, path: r.filePath, count: built.count };
});

ipcMain.handle('clipboard:write', (e, text) => {
  clipboard.writeText(String(text == null ? '' : text));
  return true;
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

/** 切换路由模式：已开启时立即生效（端口不变，系统代理不动），未开启时只记设置 */
ipcMain.handle('proxy:route', async (e, mode) => {
  if (!ROUTE_MODES[mode]) return { error: '未知的路由模式：' + mode };
  const s = currentSettings();
  store.write('settings.json', { ...s, routeMode: mode });
  if (!gateway.running) return await proxyStatus();
  try {
    await gateway.setRouteMode(mode);
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
