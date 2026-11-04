'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, clipboard, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const http = require('http');

const { Store, DEFAULT_SETTINGS } = require('./lib/store');
const parser = require('./lib/parser');
const { CoreManager } = require('./lib/core');
const { Runner } = require('./lib/runner');
const clash = require('./lib/clash');
const { SystemProxy, DEFAULT_BYPASS } = require('./lib/sysproxy');
const { Gateway, DEFAULT_PORT, ROUTE_MODES } = require('./lib/gateway');
const { fetchExitIP, requestThrough } = require('./lib/tester');
const { detectConflicts } = require('./lib/netcheck');
const { buildSingBox } = require('./lib/exporters');
const QRCode = require('qrcode');
const { deriveProxyState, pickRouteMode, STATE_TEXT } = require('./lib/proxyState');

const isDev = process.argv.includes('--dev');

let win = null;
let store = null;
let core = null;
let runner = null;
let gateway = null;
let sysproxy = null;
let quitting = false;

/**
 * 单实例锁：多开会抢 7890 端口和系统代理，第二个实例开代理必然失败。
 * 第二次启动直接把已有窗口叫到前面（含「窗口在但没显示」的情况）。
 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    bootLog('second-instance');
    if (!win || win.isDestroyed()) {
      createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    try {
      win.setSkipTaskbar(false);
    } catch (e) {}
    win.focus();
    try {
      win.flashFrame(true);
      setTimeout(() => {
        if (win && !win.isDestroyed()) win.flashFrame(false);
      }, 2500);
    } catch (e) {}
  });
}

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

const { fetchSubscription, normalizeProxy, detectLocalProxy } = require('./lib/subscribe');

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

let tray = null;
let trayTipShown = false;

/** 托盘：关掉窗口后还能点回来，退出走菜单（会完整还原系统代理并杀内核） */
function createTray() {
  if (tray) return;

  let icon = null;
  try {
    const ico = path.join(__dirname, '..', 'build', 'icon.ico');
    if (fs.existsSync(ico)) icon = nativeImage.createFromPath(ico);
  } catch (e) {
    /* 图标读不到就用系统给的可执行文件图标兜底 */
  }

  tray = new Tray(icon && !icon.isEmpty() ? icon : nativeImage.createEmpty());
  tray.setToolTip('V2PTools');

  if (!icon || icon.isEmpty()) {
    app
      .getFileIcon(process.execPath, { size: 'normal' })
      .then((img) => {
        if (tray && img && !img.isEmpty()) tray.setImage(img);
      })
      .catch(() => {});
  }

  const showWindow = () => {
    if (!win) return createWindow();
    win.show();
    win.focus();
  };

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: showWindow },
      {
        label: '开启 / 关闭系统代理',
        click: () => {
          showWindow();
          if (win) win.webContents.send('tray:toggle-proxy');
        },
      },
      {
        label: '流量悬浮窗',
        click: () => {
          if (trafficWin && !trafficWin.isDestroyed()) trafficWin.close();
          else createTrafficWindow();
        },
      },
      { type: 'separator' },
      {
        label: '退出 V2PTools',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('double-click', showWindow);
  tray.on('click', showWindow);
}

/* ------------------------------------------------------------------ */
/* 流量悬浮窗                                                          */
/* ------------------------------------------------------------------ */

let trafficWin = null;
let trafficTimer = null;
let lastTraffic = null;
/** 最近 40 次下载速度，给悬浮窗画迷你波形 */
const trafficHistory = [];

/** 读 mihomo 的 /connections：里面有累计上下行字节数，两次采样相减就是实时速度 */
function fetchConnections() {
  if (!gateway || !gateway.running || !gateway.ctlPort) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: gateway.ctlPort, path: '/connections', timeout: 1500 },
      (res) => {
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          d += c;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function pushTraffic() {
  if (!trafficWin || trafficWin.isDestroyed()) return;
  // 悬浮窗被挡住/最小化时没人看，不必每秒拉一次
  if (!trafficWin.isVisible()) return;
  const running = !!(gateway && gateway.running);

  fetchConnections().then((data) => {
    if (!trafficWin || trafficWin.isDestroyed()) return;
    const now = Date.now();
    const down = data && typeof data.downloadTotal === 'number' ? data.downloadTotal : 0;
    const up = data && typeof data.uploadTotal === 'number' ? data.uploadTotal : 0;

    let spDown = 0;
    let spUp = 0;
    if (running && lastTraffic) {
      const dt = Math.max(0.2, (now - lastTraffic.t) / 1000);
      spDown = Math.max(0, (down - lastTraffic.down) / dt);
      spUp = Math.max(0, (up - lastTraffic.up) / dt);
    }
    lastTraffic = running ? { t: now, down, up } : null;

    if (running) {
      trafficHistory.push(spDown);
      if (trafficHistory.length > 40) trafficHistory.shift();
    } else {
      trafficHistory.length = 0;
    }

    trafficWin.webContents.send('traffic:data', {
      running,
      up: spUp,
      down: spDown,
      upTotal: up,
      downTotal: down,
      tunMode: !!(gateway && gateway.tunMode),
      // 顺带把「当前用哪个节点、什么分流」带过去，悬浮窗就不用再单独问一次
      nodeName: (gateway && gateway.node && (gateway.node.name || gateway.node.server)) || '',
      routeLabel: (ROUTE_MODES[gateway && gateway.routeMode] || ROUTE_MODES.global).label,
      port: (gateway && gateway.port) || 0,
      history: trafficHistory.slice(),
    });
  });
}

function startTrafficLoop() {
  if (trafficTimer) return;
  lastTraffic = null;
  trafficTimer = setInterval(pushTraffic, 1000);
  pushTraffic();
}

function stopTrafficLoop() {
  if (trafficTimer) clearInterval(trafficTimer);
  trafficTimer = null;
  lastTraffic = null;
}

function createTrafficWindow() {
  if (trafficWin && !trafficWin.isDestroyed()) {
    trafficWin.show();
    trafficWin.focus();
    return trafficWin;
  }

  const saved = store.read('trafficPos.json', null);
  const opts = {
    width: 240,
    height: 154,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-traffic.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    opts.x = saved.x;
    opts.y = saved.y;
  }

  trafficWin = new BrowserWindow(opts);
  trafficWin.loadFile(path.join(__dirname, '..', 'renderer', 'traffic.html'));
  trafficWin.once('ready-to-show', () => trafficWin.show());
  let snapGuard = false;
  trafficWin.on('moved', () => {
    if (!trafficWin || snapGuard) return;
    const [x, y] = trafficWin.getPosition();
    const [w, h] = trafficWin.getSize();

    // 拖到离屏幕边缘 18px 内就吸附上去，省得手动对齐
    const display = screen.getDisplayNearestPoint({ x: x + Math.round(w / 2), y: y + Math.round(h / 2) });
    const wa = display.workArea;
    const SNAP = 18;
    let nx = x;
    let ny = y;
    if (Math.abs(x - wa.x) <= SNAP) nx = wa.x;
    else if (Math.abs(wa.x + wa.width - (x + w)) <= SNAP) nx = wa.x + wa.width - w;
    if (Math.abs(y - wa.y) <= SNAP) ny = wa.y;
    else if (Math.abs(wa.y + wa.height - (y + h)) <= SNAP) ny = wa.y + wa.height - h;

    if (nx !== x || ny !== y) {
      snapGuard = true;
      trafficWin.setPosition(nx, ny);
      setTimeout(() => { snapGuard = false; }, 160);
    }
    store.write('trafficPos.json', { x: nx, y: ny });
  });
  trafficWin.on('closed', () => {
    trafficWin = null;
    stopTrafficLoop();
  });

  startTrafficLoop();
  return trafficWin;
}

ipcMain.handle('traffic:toggle', () => {
  if (trafficWin && !trafficWin.isDestroyed()) {
    trafficWin.close();
    return false;
  }
  createTrafficWindow();
  return true;
});

ipcMain.on('traffic:close', () => {
  if (trafficWin && !trafficWin.isDestroyed()) trafficWin.close();
});

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

  // 兜底：首帧迟迟不来（页面卡住 / GPU 异常）也要把窗口显示出来，
  // 否则进程活着但没窗口，用户只会看到「双击没反应」，而且它占着单实例锁。
  const showTimer = setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) {
      bootLog('ready-to-show 超时，强制显示窗口');
      try {
        win.show();
      } catch (e) {}
    }
  }, 8000);

  win.once('ready-to-show', () => {
    bootLog('ready-to-show');
    clearTimeout(showTimer);
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  });

  // 关闭窗口 = 收进托盘（代理还在跑，用户随时要点回来）；
  // 真正退出走托盘菜单或 before-quit，那里会还原系统代理并杀掉内核
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (process.platform === 'win32' && !trayTipShown) {
      trayTipShown = true;
      try {
        tray.displayBalloon({
          title: 'V2PTools 仍在后台运行',
          content: '窗口已收进托盘。要完全退出，右键托盘图标选「退出」。',
        });
      } catch (err) {
        // 系统通知不可用就算了，托盘图标本身已经说明状态
      }
    }
  });

  win.on('closed', () => {
    clearTimeout(showTimer);
    win = null;
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
async function enableSystemProxy(nodeId, mode = 'system') {
  if (process.platform !== 'win32') throw new Error('系统代理设置目前仅支持 Windows');
  const nodes = store.read('nodes.json', []);
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error('找不到该节点，请重新导入后再试');

  const wantTun = mode === 'tun';
  if (wantTun) {
    const ready = await checkTunReady();
    if (!ready.ok) throw new Error(ready.reasons.join('；'));
  }

  const s = currentSettings();
  const wantPort = Number(s.systemProxyPort) || DEFAULT_PORT;
  const routeMode = ROUTE_MODES[s.routeMode] ? s.routeMode : 'global';
  const bypass = s.systemProxyBypass && String(s.systemProxyBypass).trim() ? String(s.systemProxyBypass).trim() : DEFAULT_BYPASS;

  const sameNode = gateway.running && gateway.node && gateway.node.id === node.id;
  const sameMode = !!gateway.tunMode === wantTun;
  if (!sameNode || gateway.port !== wantPort || gateway.routeMode !== routeMode || !sameMode) {
    await gateway.start(node, { port: wantPort, routeMode, tun: wantTun });
  }

  if (wantTun) {
    // TUN 已经在网卡层接管全部流量，再挂系统代理就是双重代理，必须还原掉
    await sysproxy.restore().catch(() => {});
  } else {
    try {
      await sysproxy.apply({ port: gateway.port, bypass, winhttp: !!s.systemProxyWinhttp });
    } catch (err) {
      await gateway.stop().catch(() => {});
      throw err;
    }
  }

  sendProxyState();
  // 顺带报一下环境冲突：机器上还开着别的代理软件时，系统代理会被它们抢走或绕过
  const conflicts = await detectConflicts().catch(() => null);
  const st = await proxyStatus();
  return { ...st, conflicts };
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
const WATCH_IDLE_MS = 25000;
const WATCH_ACTIVE_MS = 8000;
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
        if (alive && tick % 8 === 0) await gateway.probeWithCache({ timeout: 8000 });
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
  if (!gotLock) return; // 第二个实例已经在 second-instance 里处理完，不再初始化内核
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
  createTray();
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

app.on('window-all-closed', () => {
  // 有托盘时窗口只是隐藏，进程继续跑（代理还在工作）；
  // 托盘创建失败才走传统退出，避免留下看不见的后台进程
  if (!tray && process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  stopProxyWatch();
  stopTrafficLoop();
  if (trafficWin && !trafficWin.isDestroyed()) {
    try {
      trafficWin.destroy();
    } catch (err) {
      /* 已销毁 */
    }
  }
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

/**
 * 订阅拉取走哪个代理：
 *   1) 设置里显式填的「订阅拉取代理」
 *   2) 本机代理内核正在跑 → 自动借用它的 mixed 端口
 *   3) 本机开着别的客户端（Clash Verge 7897 / v2rayN 10809 …）→ 探到哪个借哪个
 *   4) 都没有 → 直连（失败后还有「借道可用节点」兜底）
 * 被墙的订阅站只有 1)–3) 能通，这也是「订阅拉取超时」的根因。
 */
let localProxyCache = { at: 0, port: 0 };

async function resolveSubProxy() {
  const s = currentSettings();
  const explicit = normalizeProxy(s.subProxy);
  if (explicit) return { proxy: explicit, auto: false };

  const gw = gateway ? gateway.status() : null;
  if (gw && gw.running && gw.port) {
    return { proxy: `127.0.0.1:${gw.port}`, auto: true };
  }

  // 扫本机端口有成本（最坏 7×350ms），缓存 60 秒
  if (Date.now() - localProxyCache.at > 60000) {
    localProxyCache = { at: Date.now(), port: await detectLocalProxy() };
  }
  if (localProxyCache.port) {
    return { proxy: `127.0.0.1:${localProxyCache.port}`, auto: true };
  }
  return { proxy: '', auto: false };
}

/* ------------------------------------------------------------------ */
/* 借道「已检测可用的节点」拉订阅                                        */
/* ------------------------------------------------------------------ */

const NODE_PROXY_TTL = 60000;
let nodeProxy = { at: 0, nodeId: '' };

/** 检测通过、按延迟排序的节点（借道时优先用最快的） */
function usableNodes() {
  return store
    .read('nodes.json', [])
    .filter((n) => n && n.status === 'ok' && n.type && n.server && n.port)
    .sort((a, b) => (a.latency == null ? 1e9 : a.latency) - (b.latency == null ? 1e9 : b.latency));
}

async function ensureNodeProxy(nodes) {
  const fresh =
    nodeProxy.nodeId &&
    Date.now() - nodeProxy.at < NODE_PROXY_TTL &&
    core &&
    core.running &&
    nodes.some((n) => n.id === nodeProxy.nodeId);
  if (fresh) return;
  await core.start(nodes);
  nodeProxy = { at: Date.now(), nodeId: nodes[0].id };
}

/** 依次尝试前几个可用节点，谁先拉到内容用谁 */
async function fetchViaNodes(url) {
  const nodes = usableNodes().slice(0, 3);
  if (!nodes.length) return null;
  await ensureNodeProxy(nodes);

  const errors = [];
  for (const n of nodes) {
    const port = core.portOf(n.id);
    if (!port) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const text = await fetchSubscription(url, { proxy: `127.0.0.1:${port}`, timeout: 20000 });
      if (text && text.trim()) return { text, node: n };
    } catch (err) {
      errors.push(`${n.name || n.server}：${err.message}`);
    }
  }
  throw new Error(errors[0] || '通过节点拉取失败');
}

ipcMain.handle('import:fetch', async (e, url) => {
  const { proxy, auto } = await resolveSubProxy();
  let text = null;
  let viaNode = null;
  let directErr = null;

  try {
    text = await fetchSubscription(url, { proxy });
  } catch (err) {
    directErr = err;
  }

  // 直连/代理都失败 → 借道已检测可用的节点再试一次
  // （测速进行中不能抢内核，gateway 在跑时也不能动它）
  if (!text && !runner && !(gateway && gateway.status().running)) {
    try {
      const r = await fetchViaNodes(url);
      if (r) {
        text = r.text;
        viaNode = r.node;
      }
    } catch (err) {
      /* 节点也失败时，报直连的原因更有参考价值 */
    }
  }

  if (!text) {
    const hint = auto ? `；已自动借用本机代理 127.0.0.1:${proxy.split(':').pop()}` : '';
    throw new Error(`${(directErr && directErr.message) || '订阅拉取失败'}${hint}`);
  }

  const res = parser.parseText(text, { group: new URL(url).hostname, source: url });
  return {
    nodes: res.nodes,
    errors: res.errors,
    format: res.format,
    bytes: text.length,
    viaProxy: proxy || '',
    autoProxy: auto,
    viaNode: viaNode ? { id: viaNode.id, name: viaNode.name || viaNode.server, latency: viaNode.latency } : null,
  };
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

/** 导出为 sing-box 配置（JSON） */
ipcMain.handle('export:singbox', async (e, payload) => {
  const { nodes, defaultName } = payload || {};
  let built;
  try {
    built = buildSingBox(nodes || []);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!built.count) {
    return { ok: false, error: '所选节点类型暂不支持导出为 sing-box' };
  }
  const r = await dialog.showSaveDialog(win, {
    title: '导出 sing-box 配置',
    defaultPath: defaultName || 'v2ptools-singbox',
    filters: [{ name: 'sing-box 配置', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(r.filePath, JSON.stringify(built.config, null, 2), 'utf8');
  return { ok: true, path: r.filePath, count: built.count, skipped: built.skipped };
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

/* ------------------------------------------------------------------ */
/* TUN 模式（虚拟网卡全局接管）                                        */
/* ------------------------------------------------------------------ */

/** wintun.dll 必须和 mihomo.exe 同目录，Windows 才会加载 */
function wintunPath() {
  try {
    const beside = path.join(path.dirname(resolveCorePath()), 'wintun.dll');
    if (fs.existsSync(beside)) return beside;
  } catch (e) {
    /* 开发环境内核路径可能还没就绪 */
  }
  const dev = path.join(__dirname, '..', 'vendor', 'wintun.dll');
  return fs.existsSync(dev) ? dev : '';
}

/** 当前进程是否以管理员身份运行（TUN 建虚拟网卡必须） */
function isElevated() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
      ],
      { timeout: 6000, windowsHide: true },
      (err, out) => resolve(!err && /true/i.test(String(out)))
    );
  });
}

/**
 * 开启 TUN 前的环境检查。
 * 宁可多问一句，也不要建出第二张虚拟网卡把用户网络搞乱。
 */
async function checkTunReady() {
  const reasons = [];
  const dll = wintunPath();
  if (!dll) reasons.push('缺少 wintun.dll（虚拟网卡驱动），请使用完整压缩包');
  const admin = await isElevated();
  if (!admin) reasons.push('需要管理员权限才能创建虚拟网卡');
  const conflicts = await detectConflicts().catch(() => null);
  if (conflicts && conflicts.tunAdapters && conflicts.tunAdapters.length) {
    reasons.push(`已有虚拟网卡 ${conflicts.tunAdapters.join('/')}，可能被其它 VPN 占用，请先退出它们`);
  }
  return { ok: reasons.length === 0, reasons, admin, hasWintun: !!dll, dll };
}

ipcMain.handle('proxy:tun-check', () => checkTunReady());

/** 节点二维码：把分享链接画成图，手机扫码直接导入 */
ipcMain.handle('qr:make', async (e, text) => {
  try {
    const dataUrl = await QRCode.toDataURL(String(text || ''), { margin: 1, width: 320, errorCorrectionLevel: 'M' });
    return { ok: true, dataUrl };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** 以管理员身份重启（TUN 需要提权，普通权限下引导用户重开） */
ipcMain.handle('app:relaunch-elevated', async () => {
  if (process.platform !== 'win32') return { ok: false, error: '仅支持 Windows' };
  const exe = process.execPath;
  const args = process.argv.slice(1).filter((a) => a && !a.startsWith('--'));
  const argStr = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(' ');
  const cmd = args.length
    ? `Start-Process -FilePath '${exe}' -ArgumentList ${argStr} -Verb RunAs`
    : `Start-Process -FilePath '${exe}' -Verb RunAs`;
  await new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', cmd], { timeout: 12000, windowsHide: true }, () => resolve());
  });
  quitting = true;
  app.quit();
  return { ok: true };
});

ipcMain.handle('proxy:enable', async (e, nodeId, mode) => {
  // 检测用的是独立的 CoreManager 实例与端口，和 gateway 不冲突，可以同时开。
  // （以前这里直接拒绝，用户体检到一半想开代理只能干等）
  try {
    const st = await enableSystemProxy(nodeId, mode === 'tun' ? 'tun' : 'system');
    return st;
  } catch (err) {
    return { error: err.message };
  }
});

/**
 * 链路自检：分别用「本机代理端口」和「直连」查一次出口 IP。
 * 两个 IP 不同 = 代理真的生效；相同 = 流量没走代理（或节点本身是国内出口）。
 */
ipcMain.handle('proxy:check', async () => {
  const gw = gateway ? gateway.status() : { running: false, port: 0, node: null };
  const sys = sysproxy ? await sysproxy.status() : { supported: false, active: false };

  const [direct, via, https, conflicts] = await Promise.all([
    fetchExitIP(0, { timeout: 8000 }).catch((e) => ({ ok: false, error: e.message })),
    gw.running
      ? fetchExitIP(gw.port, { timeout: 12000 }).catch((e) => ({ ok: false, error: e.message }))
      : Promise.resolve({ ok: false, error: '内核未运行' }),
    // 只测 HTTP 会误判：代理能过 HTTP 但 HTTPS（CONNECT）不通的情况真实存在，
    // 浏览器打不开网页恰恰是后者
    gw.running
      ? requestThrough(gw.port, 'https://www.gstatic.com/generate_204', { timeout: 12000, wantBody: false })
          .then((r) => ({ ok: r.ok && r.status < 400, status: r.status, ms: r.ms, error: r.error }))
          .catch((e) => ({ ok: false, error: e.message }))
      : Promise.resolve({ ok: false, error: '内核未运行' }),
    detectConflicts().catch(() => null),
  ]);

  return {
    gateway: gw,
    system: sys,
    direct,
    via,
    https,
    conflicts,
    same: !!(via && via.ok && direct && direct.ok && via.ip === direct.ip),
  };
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
