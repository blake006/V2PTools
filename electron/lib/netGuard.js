'use strict';

/**
 * 网络安全护栏（1.5.0）
 *
 * 起因：用户重新开机后出现「V2PTools 开不了代理，其它代理工具也连不上网络」。
 * 系统代理是**整机级**设置：一旦 ProxyEnable=1 但 ProxyServer 指向的本地端口已经死了，
 * 所有跟随系统代理的程序（浏览器、其它代理工具的 UI / API、Windows 更新…）都会把流量
 * 打进黑洞。而旧版只能靠 userData 里的备份文件还原 —— 用户把旧便携版一删，备份就没了，
 * 于是开机直接整机断网，连别的代理工具都救不回来。
 *
 * 这个模块按 7 个面统一做「只读体检 + 定点修复」，绝不整体重置用户的网络：
 *   ① 联网逻辑   本机直连是否可用、DNS 是否要刷新
 *   ② 代理逻辑   WinINET / PAC / WinHTTP / bypass 是否自洽、有没有指向死端口
 *   ③ 关闭逻辑   退出、内核意外退出、切换节点时的还原顺序
 *   ④ 恢复逻辑   备份文件 + 注册表归属标记双保险，配置被删也能自愈
 *   ⑤ 兼容情况   内核字段、wintun.dll、IPv6 回环、其它代理软件共存
 *   ⑥ 断网机制   只修「确定是本工具留下的、且端口已死」的项，绝不碰别人正在用的代理
 *   ⑦ 自检机制   启动时自动体检 + 界面「一键修复网络」+ 结构化报告
 *
 * 所有外部命令都通过可注入的 runner 执行，方便离线单测（见 scripts/test-netguard.js）。
 */

const { execFile } = require('child_process');
const os = require('os');
const net = require('net');
const https = require('https');

const { sanitizeBypass } = require('./sysproxy');

const DIRECT_PROBE_URL = 'https://www.baidu.com';

function defaultRunner(file, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err ? err.message : '',
      });
    });
  });
}

/**
 * 只认「确定属于本工具」的 PAC：指向我们的端口，或文件路径里带 V2PTools。
 * 用户自己的本地 PAC / 公司内网 PAC 一律不碰。
 */
function isOurPac(url, ourPorts = new Set()) {
  const s = String(url || '');
  if (/v2ptools/i.test(s)) return true;
  const pm = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d{2,5})/i.exec(s);
  return !!(pm && ourPorts.has(Number(pm[1])));
}

/** 解析 "host:port" / "http=host:port" 形式的代理地址 */
function parseServer(raw) {
  const s = String(raw || '').trim().replace(/^[a-z]+=/i, '');
  const m = /^(.+):(\d{2,5})$/.exec(s);
  if (!m) return { host: '', port: 0, raw: s, local: false };
  const host = m[1].replace(/^\[|\]$/g, '');
  const port = Number(m[2]);
  const local = /^(127\.|localhost$|\[?::1\]?$|0\.0\.0\.0$)/i.test(host);
  return { host, port, raw: s, local };
}

/** netsh winhttp show proxy 的输出：可能是中文或英文，统一取地址 */
function parseWinhttp(out) {
  const text = String(out || '');
  if (/直接访问|Direct access|no proxy server/i.test(text)) return { enabled: false, server: '' };
  const m = /(?:Proxy Server\(s\)|代理服务器)\s*:\s*([^\r\n]+)/i.exec(text);
  const server = m ? m[1].trim() : '';
  return { enabled: !!server && !/^\s*(none|无)\s*$/i.test(server), server };
}

/** 当前正在 LISTENING 的本地 TCP 端口集合 */
async function listeningPorts(run) {
  const r = await run('netstat', ['-ano', '-p', 'tcp'], 8000);
  const set = new Set();
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
    if (m) set.add(Number(m[1]));
  }
  return set;
}

/** 本工具建的 TUN 网卡（名字带 V2PTools），其它软件的虚拟网卡一律不碰 */
function ourTunAdapters() {
  const names = Object.keys(os.networkInterfaces() || {});
  return names.filter((n) => /v2ptools/i.test(n));
}

/** 回环是否可用：开一个临时端口自连，失败说明本机环回被安全软件/残留 TUN 拦截 */
function probeLoopback(timeout = 1200) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const srv = net.createServer();
    srv.once('error', () => finish(false));
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      const cli = net.connect({ host: '127.0.0.1', port });
      const timer = setTimeout(() => finish(false), timeout);
      cli.once('connect', () => {
        clearTimeout(timer);
        cli.destroy();
        srv.close(() => finish(true));
      });
      cli.once('error', () => {
        clearTimeout(timer);
        srv.close(() => finish(false));
      });
      cli.setTimeout(timeout, () => {
        cli.destroy();
        clearTimeout(timer);
        srv.close(() => finish(false));
      });
    });
    setTimeout(() => finish(false), timeout + 600).unref?.();
  });
}

/** ① 联网逻辑：Node 直连（不受 WinINET 影响），用来区分「本机断网」和「只是代理坏了」 */
function probeDirect(timeout = 3000) {
  return new Promise((resolve) => {
    const req = https.get(DIRECT_PROBE_URL, { timeout, family: 4 }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode < 500, status: res.statusCode, error: '' });
    });
    req.on('timeout', () => req.destroy(new Error('直连超时')));
    req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
  });
}

/**
 * 只读体检。
 * @param {SystemProxy} sysproxy
 * @param {object} opts { preferredPort, gatewayPort, gatewayRunning, run, probe }
 */
async function inspect(sysproxy, opts = {}) {
  const run = opts.run || defaultRunner;
  const cur = (await sysproxy.read()) || {};
  const bk = sysproxy.readBackup();
  const owner = await sysproxy.readOwner();
  const st = await sysproxy.status();
  const target = (bk && bk.target) || (owner && owner.target) || '';

  const [winhttpRaw, ports, tun, loopback, direct] = await Promise.all([
    run('netsh', ['winhttp', 'show', 'proxy'], 8000),
    listeningPorts(run),
    Promise.resolve(ourTunAdapters()),
    opts.probe === false ? Promise.resolve(true) : probeLoopback(),
    opts.probe === false ? Promise.resolve({ ok: true, status: 200, error: '' }) : probeDirect(),
  ]);
  const winhttp = parseWinhttp(winhttpRaw.stdout);

  const preferred = Number(opts.preferredPort) || 7890;
  const ourPorts = new Set([preferred, preferred + 1, 7890, 7891]);
  if (target) ourPorts.add(parseServer(target).port);
  if (st.backup && st.backup.target) ourPorts.add(parseServer(st.backup.target).port);
  if (opts.gatewayPort) ourPorts.add(Number(opts.gatewayPort));

  const sys = parseServer(cur.proxyServer);
  const isOurs = (server) => {
    const p = parseServer(server);
    if (!p.local || !p.port) return false;
    return p.raw === target || ourPorts.has(p.port);
  };
  const portAlive = (server) => ports.has(parseServer(server).port);
  const gatewayRunning = !!opts.gatewayRunning;

  const findings = [];
  const add = (id, level, title, detail, extra = {}) =>
    findings.push({ id, level, title, detail, fixable: true, auto: true, needsAdmin: false, ...extra });

  /* ② 代理逻辑 / ⑥ 断网机制：孤儿系统代理 —— 本次事故的直接原因 */
  if (cur.proxyEnable === 1 && sys.local && !portAlive(cur.proxyServer) && isOurs(cur.proxyServer) && !gatewayRunning) {
    add(
      'orphan-wininet',
      'critical',
      '系统代理指向已失效的本地端口',
      `ProxyEnable=1，ProxyServer=${cur.proxyServer}，但该端口没有任何程序监听。所有跟随系统代理的软件都会因此断网。`,
      { target: cur.proxyServer }
    );
  }

  /* ⑤ 兼容情况：<-loopback> 会让 127.0.0.1 也走代理，连自己内核的控制器都连不上 */
  if (cur.proxyOverride && /<-loopback>/i.test(cur.proxyOverride)) {
    add(
      'loopback-hijack',
      'critical',
      '绕过列表含 <-loopback>，本机回环被劫持',
      '本机 127.0.0.1 的请求也会被送进代理，导致本工具控制器、其它代理工具本地 API、IDE 本地服务全部连不上。'
    );
  }

  /* ② 代理逻辑：PAC 优先级高于固定代理，残留的本工具 PAC 会盖掉一切 */
  if (cur.autoConfigUrl && isOurPac(cur.autoConfigUrl, ourPorts)) {
    const pm = /:(\d{2,5})/.exec(cur.autoConfigUrl);
    const dead = !pm || !ports.has(Number(pm[1]));
    if (dead) {
      add('stale-pac', 'critical', '残留的本地 PAC 自动配置脚本', `AutoConfigURL=${cur.autoConfigUrl}，来源已失效，Windows 会优先采用它。`);
    }
  }

  /* ② 代理逻辑：WinHTTP 是机器级设置，重启后依然生效，影响系统服务与其它代理工具 */
  const wh = parseServer(winhttp.server);
  if (winhttp.enabled && wh.local && !portAlive(winhttp.server) && isOurs(winhttp.server) && !gatewayRunning) {
    add(
      'orphan-winhttp',
      'critical',
      'WinHTTP 代理指向已失效的本地端口',
      `netsh winhttp 仍指向 ${winhttp.server}，它作用于系统服务且重启不会自动清除。`,
      { needsAdmin: true }
    );
  }

  /* ⑥ 断网机制：上次强杀留下的本工具虚拟网卡 */
  if (tun.length && !gatewayRunning) {
    add(
      'stale-tun',
      'warn',
      '残留的 V2PTools 虚拟网卡',
      `检测到 ${tun.join('、')}，但代理内核没在跑；残留路由可能把全部流量导进死网卡。`,
      { needsAdmin: true, adapters: tun }
    );
  }

  /* ④ 恢复逻辑：标记与现状不一致，留着会污染下次判断 */
  if (owner && (cur.proxyEnable !== 1 || cur.proxyServer !== owner.target)) {
    add('stale-owner', 'info', '残留的代理归属标记', `标记指向 ${owner.target}，但系统代理已不是它。`, { auto: true });
  }

  /* ① 联网逻辑：本机自身断网 */
  if (!direct.ok) {
    add('direct-network', 'warn', '本机直连不通', `直连探测失败（${direct.error || '超时'}）；这与代理无关，请检查网卡/DNS/网线。`, { fixable: false, auto: false });
  }
  if (!loopback) {
    add('loopback-blocked', 'warn', '本机回环 127.0.0.1 自连失败', '多半是安全软件、残留 TUN 路由或防火墙拦截了环回。', { fixable: false, auto: false });
  }

  return {
    ok: !findings.some((f) => f.level === 'critical'),
    findings,
    wininet: cur,
    winhttp,
    listening: [...ports].sort((a, b) => a - b),
    tunAdapters: tun,
    loopbackOk: loopback,
    direct,
    backup: bk ? { target: bk.target, createdAt: bk.createdAt } : null,
    owner,
    oursPorts: [...ourPorts],
    summary: findings.length
      ? findings.map((f) => `${f.level === 'critical' ? '✗' : '⚠'} ${f.title}`).join('\n')
      : '网络设置正常：没有发现会导致断网的残留',
  };
}

/**
 * 定点修复。只处理「确定是本工具留下的、且已失效」的项；
 * 用户/其它代理软件正在使用的设置一律不动。
 */
async function repair(sysproxy, opts = {}) {
  const run = opts.run || defaultRunner;
  const before = await inspect(sysproxy, { ...opts, run });
  const actions = [];

  const doAction = async (id, label, fn) => {
    try {
      const msg = await fn();
      actions.push({ id, label, ok: true, message: msg || '' });
      return true;
    } catch (err) {
      actions.push({ id, label, ok: false, message: err.message });
      return false;
    }
  };

  for (const f of before.findings) {
    if (!f.fixable || (!f.auto && !opts.force)) continue;
    // eslint-disable-next-line no-await-in-loop
    switch (f.id) {
      case 'orphan-wininet': {
        // 有备份就完整还原用户的原始设置；没有备份（旧便携版被删）就强制直连
        await doAction(f.id, f.title, async () => {
          const bk = sysproxy.readBackup();
          if (bk && bk.values) await sysproxy.restore();
          else await sysproxy.forceDirect(f.target);
          return bk && bk.values ? '已还原为开启代理前的原始设置' : '备份已丢失，已强制恢复直连并清除失效地址';
        });
        break;
      }
      case 'loopback-hijack': {
        await doAction(f.id, f.title, async () => {
          const cur = await sysproxy.read();
          await sysproxy.setValue('ProxyOverride', 'REG_SZ', sanitizeBypass(cur.proxyOverride));
          await sysproxy.refresh();
          return '已移除 <-loopback> 并补齐 IPv6 回环绕过';
        });
        break;
      }
      case 'stale-pac': {
        await doAction(f.id, f.title, async () => {
          await sysproxy.deleteValue('AutoConfigURL');
          await sysproxy.refresh();
          return '已清除失效的本地 PAC 自动配置';
        });
        break;
      }
      case 'orphan-winhttp': {
        await doAction(f.id, f.title, async () => {
          const r = await run('netsh', ['winhttp', 'reset', 'proxy'], 8000);
          if (!r.ok) throw new Error('重置 WinHTTP 失败（通常需要管理员权限）：' + (r.stderr || r.error || '').trim());
          return '已重置 WinHTTP 为直接访问';
        });
        break;
      }
      case 'stale-tun': {
        await doAction(f.id, f.title, async () => {
          const errs = [];
          for (const name of f.adapters || []) {
            const safe = String(name).replace(/"/g, '');
            // eslint-disable-next-line no-await-in-loop
            const r = await run('netsh', ['interface', 'set', 'interface', `name="${safe}"`, 'admin=disabled'], 8000);
            if (!r.ok) errs.push(`${safe}: ${(r.stderr || r.error || '').trim()}`);
          }
          if (errs.length) throw new Error('禁用残留网卡失败（需要管理员权限）：' + errs.join('；'));
          return '已禁用残留的虚拟网卡';
        });
        break;
      }
      case 'stale-owner': {
        await doAction(f.id, f.title, async () => {
          await sysproxy.clearOwner();
          return '已清除失效的归属标记';
        });
        break;
      }
      default:
        break;
    }
  }

  // DNS 缓存里可能还留着 TUN/fake-ip 时期的假地址
  if (actions.length) {
    const r = await run('ipconfig', ['/flushdns'], 8000);
    actions.push({ id: 'flush-dns', label: '刷新 DNS 缓存', ok: r.ok, message: r.ok ? '' : (r.stderr || r.error || '').trim() });
    await sysproxy.refresh().catch(() => {});
  }

  const after = await inspect(sysproxy, { ...opts, run });
  const failed = actions.filter((a) => !a.ok);
  return {
    ok: !after.findings.some((f) => f.level === 'critical') && failed.length === 0,
    before,
    after,
    actions,
    summary:
      `修复 ${actions.filter((a) => a.ok).length} 项` +
      (failed.length ? `，失败 ${failed.length} 项：${failed.map((a) => a.message).join('；')}` : '') +
      (after.findings.some((f) => f.level === 'critical') ? '；仍有严重残留，建议以管理员身份重试' : '；网络已恢复直接访问'),
  };
}

module.exports = {
  inspect,
  repair,
  isOurPac,
  parseServer,
  parseWinhttp,
  listeningPorts,
  ourTunAdapters,
  probeLoopback,
  probeDirect,
  defaultRunner,
  DIRECT_PROBE_URL,
};
