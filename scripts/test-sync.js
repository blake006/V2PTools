'use strict';

/**
 * 端到端同步测试：本地起一个订阅服务，驱动界面完成「导入订阅 → 更新订阅」
 * 运行: electron scripts/test-sync.js
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const { fetchSubscription } = require('../electron/lib/subscribe');
const parser = require('../electron/lib/parser');

let payload = '';
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/sub')) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(payload);
  } else {
    res.writeHead(404);
    res.end('nope');
  }
});

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

function links(list) {
  return list
    .map(
      (n) =>
        `ss://${b64(`aes-128-gcm:${n.pw || 'pw'}`)}@${n.server}:${n.port}#${encodeURIComponent(n.name)}`
    )
    .join('\n');
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? '✔' : '✘'} ${name}${cond ? '' : '  → ' + JSON.stringify(detail)}`);
}

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const subUrl = `http://127.0.0.1:${port}/sub`;

  ipcMain.handle('app:info', () => ({
    appVersion: '1.0.0',
    electron: process.versions.electron,
    node: process.versions.node,
    platform: 'win32',
    arch: 'x64',
    coreVersion: 'test',
    corePath: 'x',
    coreFound: true,
    userData: 'x',
  }));
  ipcMain.handle('store:get', (e, k) => (k === 'nodes' ? [] : k === 'sources' ? [] : k === 'settings' ? {} : null));
  ipcMain.handle('store:set', () => true);
  ipcMain.handle('theme:set', () => true);
  ipcMain.handle('import:fetch', async (e, url) => {
    const text = await fetchSubscription(url);
    const res = parser.parseText(text, { group: new URL(url).hostname, source: url });
    return { nodes: res.nodes, errors: res.errors, format: res.format, bytes: text.length };
  });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const errs = [];
  win.webContents.on('console-message', (e, l, m) => {
    if (l >= 2) errs.push(m);
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 900));

  const run = (code) => win.webContents.executeJavaScript(code);

  /* ---------- 第一轮：首次导入 3 个节点 ---------- */
  payload = b64(
    links([
      { name: 'HK-01', server: '1.1.1.1', port: 443, pw: 'a' },
      { name: 'JP-01', server: '2.2.2.2', port: 443, pw: 'b' },
      { name: 'US-01', server: '3.3.3.3', port: 443, pw: 'c' },
    ])
  );

  let r = JSON.parse(
    await run(`(async () => {
      const res = await window.api.fetchSubscription(${JSON.stringify(subUrl)});
      mergeNodes(res.nodes);
      registerSource(${JSON.stringify(subUrl)}, 'local-sub', res.nodes.length, res.format);
      renderTable();
      return JSON.stringify({ nodes: state.nodes.length, sources: state.sources.length, format: res.format });
    })()`)
  );
  check('首次导入 3 个节点', r.nodes === 3, r);
  check('订阅源已登记', r.sources === 1, r);
  check('识别为 Base64 订阅', r.format === 'Base64 订阅', r);

  /* ---------- 第二轮：模拟检测结果后同步（删 1 增 1 改 1） ---------- */
  await run(`(() => {
    state.nodes[0].status = 'ok'; state.nodes[0].latency = 88; state.nodes[0].health = 95;
    state.selected.add(state.nodes[2].id);
  })()`);

  payload = b64(
    links([
      { name: 'HK-01-改名', server: '1.1.1.1', port: 443, pw: 'a2' }, // 保留（配置变化）
      { name: 'JP-01', server: '2.2.2.2', port: 443, pw: 'b' }, // 不变
      { name: 'SG-01', server: '4.4.4.4', port: 443, pw: 'd' }, // 新增
    ])
  ); // US-01 消失

  r = JSON.parse(
    await run(`(async () => {
      const res = await syncSources(state.sources.slice());
      const hk = state.nodes.find(n => n.server === '1.1.1.1');
      return JSON.stringify({
        added: res.added, updated: res.updated, removed: res.removed,
        nodes: state.nodes.length,
        hkName: hk && hk.name,
        hkLatency: hk && hk.latency,
        hkHealth: hk && hk.health,
        hkPw: hk && hk.conf.password,
        hasUS: state.nodes.some(n => n.server === '3.3.3.3'),
        hasSG: state.nodes.some(n => n.server === '4.4.4.4'),
        srcCount: state.sources[0].count,
        selected: state.selected.size,
      });
    })()`)
  );
  check('同步统计 新增1/更新2/移除1', r.added === 1 && r.updated === 2 && r.removed === 1, r);
  check('节点总数 3', r.nodes === 3, r);
  check('已失效节点被移除', r.hasUS === false, r);
  check('新节点已加入', r.hasSG === true, r);
  check('保留节点的检测结果未被清空', r.hkLatency === 88 && r.hkHealth === 95, r);
  check('保留节点的配置已更新', r.hkPw === 'a2' && r.hkName === 'HK-01-改名', r);
  check('订阅源节点数刷新', r.srcCount === 3, r);
  check('被移除节点的选中状态已清理', r.selected === 0, r);

  /* ---------- 第三轮：订阅源 404 ---------- */
  payload = 'not a subscription';
  r = JSON.parse(
    await run(`(async () => {
      const res = await syncSources(state.sources.slice());
      return JSON.stringify({ failures: res.failures.length, nodes: state.nodes.length, err: state.sources[0].error });
    })()`)
  );
  check('解析失败时记录错误且不清空节点', r.failures === 1 && r.nodes === 3 && !!r.err, r);

  check('渲染过程无脚本错误', errs.length === 0, errs);

  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n通过 ${results.length - failed}/${results.length}`);
  server.close();
  app.quit();
  process.exitCode = failed ? 1 : 0;
});
