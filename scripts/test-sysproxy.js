'use strict';

/**
 * 系统代理模块测试
 *
 * 两种模式，自动选择：
 *  1) 真实注册表模式：操作临时键 HKCU\Software\V2PToolsTest\Internet Settings，跑完即删除，
 *     **不会碰真实的系统代理设置**。
 *  2) 内存注册表模式：当环境禁止启动 reg.exe（企业安全策略 / 沙箱）时，
 *     注入假的命令执行器，验证备份、还原、PAC 处理、崩溃恢复等全部逻辑。
 *
 * 用法: npm run test-sysproxy
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { SystemProxy, DEFAULT_BYPASS, parseRegQuery } = require('../electron/lib/sysproxy');

const TEST_KEY = 'HKCU\\Software\\V2PToolsTest\\Internet Settings';
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v2p-sysproxy-'));

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    failed += 1;
    console.log('  FAIL ' + name + '\n       ' + err.message);
  }
}

/* ------------------------------------------------------------------ */
/* 环境：真实注册表 / 内存注册表                                        */
/* ------------------------------------------------------------------ */

function regWorks() {
  try {
    execFileSync('reg', ['query', 'HKCU'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch (e) {
    return false;
  }
}

const REAL = process.platform === 'win32' && regWorks();

const memStore = new Map(); // name -> { type, value }

const ok = () => ({ ok: true, code: 0, stdout: '', stderr: '', error: '' });
const fail = (msg) => ({ ok: false, code: 1, stdout: '', stderr: msg, error: msg });

/** 模拟 reg.exe / netsh / powershell 的行为 */
function fakeRunner(file, args) {
  if (file !== 'reg') return Promise.resolve(ok());
  const [op, key, ...rest] = args;
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i === -1 ? null : rest[i + 1];
  };
  if (op === 'query') {
    if (!memStore.size) return Promise.resolve(fail('系统找不到指定的注册表项或值。'));
    let out = key + '\r\n';
    for (const [name, item] of memStore) {
      const shown = item.type === 'REG_DWORD' ? '0x' + Number(item.value).toString(16) : item.value;
      out += `    ${name}    ${item.type}    ${shown}\r\n`;
    }
    return Promise.resolve({ ok: true, code: 0, stdout: out, stderr: '', error: '' });
  }
  if (op === 'add') {
    const name = flag('/v');
    if (!name) return Promise.resolve(ok());
    memStore.set(name, { type: flag('/t') || 'REG_SZ', value: flag('/d') || '' });
    return Promise.resolve(ok());
  }
  if (op === 'delete') {
    const name = flag('/v');
    if (name) memStore.delete(name);
    else memStore.clear();
    return Promise.resolve(ok());
  }
  return Promise.resolve(ok());
}

function reg(args) {
  execFileSync('reg', args, { encoding: 'utf8', windowsHide: true });
}

/** 写入初始状态 */
function seed(values) {
  memStore.clear();
  if (REAL) {
    try {
      reg(['delete', TEST_KEY, '/f']);
    } catch (e) {}
  }
  for (const [name, type, value] of values) {
    if (REAL) reg(['add', TEST_KEY, '/v', name, '/t', type, '/d', String(value), '/f']);
    else memStore.set(name, { type, value: String(value) });
  }
}

function setRaw(name, type, value) {
  if (REAL) reg(['add', TEST_KEY, '/v', name, '/t', type, '/d', String(value), '/f']);
  else memStore.set(name, { type, value: String(value) });
}

function makeProxy() {
  return new SystemProxy({
    dataDir: TMP_DIR,
    regRoot: REAL ? TEST_KEY : 'HKCU\\Software\\V2PToolsTest\\Internet Settings',
    refresh: false,
    runner: REAL ? undefined : fakeRunner,
  });
}

function cleanup() {
  if (REAL) {
    try {
      reg(['delete', 'HKCU\\Software\\V2PToolsTest', '/f']);
    } catch (e) {}
  }
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

(async () => {
  console.log(
    REAL
      ? '模式：真实注册表（临时键 HKCU\\Software\\V2PToolsTest，不触碰真实系统代理）\n'
      : '模式：内存注册表（当前环境禁止 reg.exe，逻辑等价模拟）\n'
  );

  /* ---------------- 0. 解析 ---------------- */
  await check('解析 reg query 输出', () => {
    const parsed = parseRegQuery(
      'HKEY_CURRENT_USER\\Software\\X\r\n    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n'
    );
    assert.strictEqual(parsed.ProxyEnable.value, 1);
    assert.strictEqual(parsed.ProxyServer.value, '127.0.0.1:7890');
  });

  /* ---------------- 1. 读取 ---------------- */
  seed([
    ['ProxyEnable', 'REG_DWORD', 1],
    ['ProxyServer', 'REG_SZ', '10.0.0.9:8080'],
    ['ProxyOverride', 'REG_SZ', 'intranet.local'],
    ['AutoConfigURL', 'REG_SZ', 'http://pac.example.com/proxy.pac'],
  ]);

  const sp = makeProxy();
  const before = await sp.read();

  await check('读取 ProxyEnable', () => assert.strictEqual(before.proxyEnable, 1));
  await check('读取 ProxyServer', () => assert.strictEqual(before.proxyServer, '10.0.0.9:8080'));
  await check('读取 ProxyOverride', () => assert.strictEqual(before.proxyOverride, 'intranet.local'));
  await check('读取 AutoConfigURL', () => assert.strictEqual(before.autoConfigUrl, 'http://pac.example.com/proxy.pac'));

  /* ---------------- 2. 开启 ---------------- */
  const st = await sp.apply({ port: 7890 });

  await check('开启后状态为已启用', () => assert.strictEqual(st.active, true));
  await check('代理地址为 127.0.0.1:7890', () => assert.strictEqual(st.server, '127.0.0.1:7890'));
  await check('写入默认绕过列表', () => assert.ok(st.bypass.includes('localhost') && st.bypass.includes('<local>')));

  const after = await sp.read();
  await check('ProxyEnable 置为 1', () => assert.strictEqual(after.proxyEnable, 1));
  await check('PAC 脚本被移除（固定代理优先）', () => assert.strictEqual(after.autoConfigUrl, ''));

  const bk = sp.readBackup();
  await check('生成备份文件', () => assert.ok(bk && bk.values));
  await check('备份保留原始代理地址', () => assert.strictEqual(bk.values.proxyServer, '10.0.0.9:8080'));
  await check('备份保留原始 PAC', () => assert.strictEqual(bk.values.autoConfigUrl, 'http://pac.example.com/proxy.pac'));

  /* ---------------- 3. 重复开启不覆盖备份 ---------------- */
  await sp.apply({ port: 7891 });
  const bk2 = sp.readBackup();
  await check('再次开启仍保留最初备份', () => assert.strictEqual(bk2.values.proxyServer, '10.0.0.9:8080'));
  await check('备份目标地址已更新', () => assert.strictEqual(bk2.target, '127.0.0.1:7891'));

  /* ---------------- 4. 关闭并还原 ---------------- */
  await sp.restore();
  const restored = await sp.read();

  await check('ProxyEnable 还原', () => assert.strictEqual(restored.proxyEnable, before.proxyEnable));
  await check('ProxyServer 还原', () => assert.strictEqual(restored.proxyServer, before.proxyServer));
  await check('ProxyOverride 还原', () => assert.strictEqual(restored.proxyOverride, before.proxyOverride));
  await check('AutoConfigURL 还原', () => assert.strictEqual(restored.autoConfigUrl, before.autoConfigUrl));
  await check('备份文件已清理', () => assert.strictEqual(fs.existsSync(sp.backupPath), false));

  const stOff = await sp.status();
  await check('关闭后 active = false', () => assert.strictEqual(stOff.active, false));

  /* ---------------- 5. 崩溃残留自动还原 ---------------- */
  const sp2 = makeProxy();
  await sp2.apply({ port: 7890 });
  const crashed = makeProxy(); // 模拟重启：新实例 + 磁盘上的备份
  const rec = await crashed.recoverIfStale();

  await check('检测到遗留设置并还原', () => assert.strictEqual(rec.recovered, true));
  await check('还原为原始代理地址', async () => {
    const cur = await crashed.read();
    assert.strictEqual(cur.proxyServer, '10.0.0.9:8080');
  });
  await check('还原后清理备份', () => assert.strictEqual(fs.existsSync(crashed.backupPath), false));

  /* ---------------- 6. 用户已手动改过代理 → 不误还原 ---------------- */
  const sp3 = makeProxy();
  await sp3.apply({ port: 7890 });
  setRaw('ProxyServer', 'REG_SZ', '192.168.1.1:3128');
  const rec2 = await sp3.recoverIfStale();
  const afterRec2 = await sp3.read();

  await check('不覆盖用户手动设置的代理', () => assert.strictEqual(rec2.recovered, false));
  await check('用户设置的代理被保留', () => assert.strictEqual(afterRec2.proxyServer, '192.168.1.1:3128'));
  await check('失效备份被丢弃', () => assert.strictEqual(fs.existsSync(sp3.backupPath), false));

  /* ---------------- 7. 无备份时关闭：只关开关 ---------------- */
  seed([
    ['ProxyEnable', 'REG_DWORD', 0],
    ['ProxyServer', 'REG_SZ', '10.1.1.1:8888'],
  ]);
  const sp4 = makeProxy();
  await sp4.restore();
  const afterNoBk = await sp4.read();

  await check('无备份时只关闭开关', () => assert.strictEqual(afterNoBk.proxyEnable, 0));
  await check('无备份时保留原 ProxyServer', () => assert.strictEqual(afterNoBk.proxyServer, '10.1.1.1:8888'));

  /* ---------------- 8. 默认绕过列表 ---------------- */
  await check('默认绕过列表包含内网段', () => {
    assert.ok(DEFAULT_BYPASS.includes('127.*'));
    assert.ok(DEFAULT_BYPASS.includes('192.168.*'));
    assert.ok(DEFAULT_BYPASS.includes('172.16.*'));
    assert.ok(DEFAULT_BYPASS.includes('<local>'));
  });

  /* ---------------- 9. 自定义绕过列表 ---------------- */
  seed([['ProxyEnable', 'REG_DWORD', 0]]);
  const sp5 = makeProxy();
  await sp5.apply({ port: 7892, bypass: 'localhost;*.corp.example' });
  const st5 = await sp5.status();
  await check('自定义绕过列表生效', () => assert.strictEqual(st5.bypass, 'localhost;*.corp.example'));
  await sp5.restore();

  cleanup();

  console.log(`\n通过 ${passed}，失败 ${failed}`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('测试异常:', err);
  cleanup();
  process.exit(1);
});
