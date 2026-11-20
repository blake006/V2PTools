/**
 * 开机守护脚本测试：在临时注册表键 / 临时目录里真跑一遍 boot-guard.ps1 的逻辑。
 * 绝不碰真实 Internet Settings 与真实备份文件。
 *
 *   node scripts/test-boot-guard.js
 */
const { execFileSync, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { guardScriptText, parseRegQuery, powershellExe } = require('../electron/lib/sysproxy');

const ROOT = 'HKCU\\Software\\V2PTools\\TestGuard';
const IE_KEY = ROOT + '\\IE';
const OWNER_KEY = ROOT + '\\ProxyOwner';
// PowerShell 注册表 provider 路径必须带驱动器冒号
const IE_KEY_PS = 'HKCU:\\Software\\V2PTools\\TestGuard\\IE';
const OWNER_KEY_PS = 'HKCU:\\Software\\V2PTools\\TestGuard\\ProxyOwner';
const TMP_DIR = path.join(os.tmpdir(), 'v2p-guard-test-' + process.pid);

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name);
  }
}

const REG_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');

function reg(args) {
  try {
    return execFileSync(REG_EXE, args, { encoding: 'utf8', windowsHide: true });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

function keyExists(key) {
  try {
    execFileSync(REG_EXE, ['query', key], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch (e) {
    return false;
  }
}

function readKey(key) {
  const out = reg(['query', key]);
  if (!out.trim() || /错误|ERROR/.test(out)) return null;
  const vals = parseRegQuery(out);
  const pick = (n) => (vals[n] ? vals[n].value : null);
  return {
    proxyEnable: pick('ProxyEnable') ? 1 : 0,
    proxyServer: pick('ProxyServer') || '',
  };
}

function seed({ enable, server }) {
  reg(['delete', IE_KEY, '/f']);
  reg(['add', IE_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', String(enable), '/f']);
  if (server) reg(['add', IE_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', server, '/f']);
}

function seedOwner(target) {
  reg(['delete', OWNER_KEY, '/f']);
  if (target) reg(['add', OWNER_KEY, '/v', 'Target', '/t', 'REG_SZ', '/d', target, '/f']);
}

function seedBackup(values, target) {
  const p = path.join(TMP_DIR, 'sysproxy-backup.json');
  if (!values) {
    try {
      fs.unlinkSync(p);
    } catch (e) {}
    return;
  }
  fs.writeFileSync(
    p,
    JSON.stringify({ app: 'V2PTools', createdAt: new Date().toISOString(), target, values }, null, 2),
    'utf8'
  );
}

function scriptText() {
  return guardScriptText(TMP_DIR)
    .replace("$ie = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'", `$ie = '${IE_KEY_PS}'`)
    .replace("$ownerKey = 'HKCU:\\Software\\V2PTools\\ProxyOwner'", `$ownerKey = '${OWNER_KEY_PS}'`)
    // 测试里去掉进程检查与等待：本机正跑着 V2PTools，否则会被提前 exit
    .replace(/Start-Sleep -Seconds 4/g, 'Start-Sleep -Seconds 0')
    .replace(/if \(Get-Process[^\r\n]*/g, '');
}

function runGuard() {
  const p = path.join(TMP_DIR, 'guard-under-test.ps1');
  fs.writeFileSync(p, scriptText(), 'utf8');
  try {
    const out = execFileSync(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', p],
      { timeout: 30000, windowsHide: true, encoding: 'utf8' }
    );
    if (out && out.trim()) console.log('    PS 输出: ' + out.trim().slice(0, 400));
    return true;
  } catch (e) {
    console.log('    PS 执行失败: ' + String(e.stdout || '').slice(0, 400) + ' | ' + String(e.stderr || e.message).slice(0, 400));
    return false;
  }
}

function portAlive(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(1500);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.once('timeout', () => done(false));
  });
}

function cleanup() {
  reg(['delete', ROOT, '/f']);
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch (e) {}
}

(async function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  console.log('— 场景 1：关机遗留 + 有备份 → 按快照还原');
  seed({ enable: 1, server: '127.0.0.1:7931' });
  seedOwner('127.0.0.1:7931');
  seedBackup(
    { proxyEnable: 0, proxyServer: '127.0.0.1:45809', proxyOverride: '<local>', autoConfigUrl: '', autoDetect: 0 },
    '127.0.0.1:7931'
  );
  runGuard();
  const a = readKey(IE_KEY);
  check('ProxyEnable 回到 0', !!a && a.proxyEnable === 0);
  check('ProxyServer 回到原始 45809', !!a && a.proxyServer === '127.0.0.1:45809');
  check('归属标记被清除', !keyExists(OWNER_KEY));
  check('备份文件被删除', !fs.existsSync(path.join(TMP_DIR, 'sysproxy-backup.json')));
  check('写入守护日志', fs.existsSync(path.join(TMP_DIR, 'boot-guard.log')));

  console.log('— 场景 2：强杀遗留 + 无备份 → 只关开关 + 清死地址');
  seed({ enable: 1, server: '127.0.0.1:7931' });
  seedOwner('127.0.0.1:7931');
  seedBackup(null, '');
  runGuard();
  const b = readKey(IE_KEY);
  check('ProxyEnable 归零', !!b && b.proxyEnable === 0);
  check('ProxyServer 被清除', !!b && b.proxyServer === '');

  console.log('— 场景 3：端口还活着 → 不动');
  const alive = await portAlive(7890);
  seed({ enable: 1, server: '127.0.0.1:7890' });
  seedOwner('127.0.0.1:7890');
  seedBackup(null, '127.0.0.1:7890');
  runGuard();
  const c = readKey(IE_KEY);
  if (alive) {
    check('代理设置被保留', !!c && c.proxyEnable === 1 && c.proxyServer === '127.0.0.1:7890');
  } else {
    console.log('  skip 7890 未监听，跳过该用例');
  }

  console.log('— 场景 4：ProxyServer 不是我们的 → 不误伤');
  seed({ enable: 1, server: '10.0.0.9:8080' });
  seedOwner('127.0.0.1:7890');
  seedBackup(null, '127.0.0.1:7890');
  runGuard();
  const d = readKey(IE_KEY);
  check('用户自己的代理保持不变', !!d && d.proxyEnable === 1 && d.proxyServer === '10.0.0.9:8080');

  cleanup();
  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exitCode = fail ? 1 : 0;
})();
