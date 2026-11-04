'use strict';

/**
 * 代理环境冲突检测
 *
 * 为什么需要：Windows 上同时装几个代理软件很常见（Clash Verge / sing-box / v2rayN…）。
 * 它们会各自改系统代理、或直接开 TUN 网卡接管全部流量。
 * 一旦 TUN 在跑，系统代理指向哪里都没意义 —— 流量已经被 TUN 劫持走了，
 * 用户看到的就是「代理明明开着，网页却打不开」。
 *
 * 这里只做只读探测，不改任何东西。
 */

const { execFile } = require('child_process');
const os = require('os');

/** 常见代理客户端进程名（不含本工具自己的 mihomo，单独判断） */
const KNOWN_PROXIES = [
  { re: /^clash/i, name: 'Clash' },
  { re: /^verge|clash-verge/i, name: 'Clash Verge' },
  { re: /^sing-box/i, name: 'sing-box' },
  { re: /^v2ray/i, name: 'v2ray' },
  { re: /^xray/i, name: 'Xray' },
  { re: /^nekoray|^nekobox/i, name: 'NekoRay' },
  { re: /^hiddify/i, name: 'Hiddify' },
  { re: /^shadowsocks/i, name: 'Shadowsocks' },
  { re: /^ss-local|^sslocal/i, name: 'Shadowsocks' },
  { re: /^wireguard/i, name: 'WireGuard' },
  { re: /^tun2socks/i, name: 'tun2socks' },
];

function run(file, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

/**
 * 常见代理客户端会占用的端口。
 * 只看这些：浏览器内置的 xray 会绑随机高位端口（如 16752），
 * 那是它自己内部用的，不影响系统代理，不该算冲突。
 */
const COMMON_PROXY_PORTS = new Set([7890, 7891, 7892, 7897, 1080, 1081, 1087, 2080, 8080, 8889, 10808, 10809, 20171, 20172]);

/**
 * 正在运行的其他代理进程。
 * 判断它有没有占用「常见代理端口」：
 *  - 占了 = 真在提供服务，可能抢流量
 *  - 只绑随机端口 / 没监听 = 自己内部用（GeekEZ 这类浏览器内置的 xray），不该报警
 */
async function detectProxyProcesses() {
  const [taskOut, netOut] = await Promise.all([
    run('tasklist', ['/fo', 'csv', '/nh']),
    run('netstat', ['-ano', '-p', 'tcp']),
  ]);
  if (!taskOut) return [];

  const activePids = new Set();
  netOut.split(/\r?\n/).forEach((line) => {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
    if (m && COMMON_PROXY_PORTS.has(Number(m[1]))) activePids.add(Number(m[2]));
  });

  const found = new Map();
  taskOut.split(/\r?\n/).forEach((line) => {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (!m) return;
    const exe = m[1];
    const pid = Number(m[2]);
    const base = exe.replace(/\.exe$/i, '');
    // 本工具自己的内核叫 mihomo，不能算冲突
    if (/^mihomo$/i.test(base)) return;
    const hit = KNOWN_PROXIES.find((k) => k.re.test(base));
    if (!hit) return;
    if (!found.has(hit.name)) found.set(hit.name, { name: hit.name, pids: [], listening: false });
    const item = found.get(hit.name);
    item.pids.push(pid);
    if (activePids.has(pid)) item.listening = true;
  });
  return [...found.values()];
}

/** 虚拟网卡（TUN/TAP）—— 存在说明有软件在接管全部流量 */
function detectTunAdapters() {
  const names = Object.keys(os.networkInterfaces() || {});
  const hits = names.filter((n) =>
    /(^|[^a-z])(tun|tap|utun|wintun|singbox|sing-box|clash|mihomo|wg\d|wireguard)/i.test(n)
  );
  return hits;
}

/** 常见代理端口是否被别的程序监听 */
async function detectProxyPorts(ports = [7897, 1080, 10808, 10809, 2080, 8889]) {
  const out = await run('netstat', ['-ano', '-p', 'tcp']);
  if (!out) return [];
  const listening = new Set();
  out.split(/\r?\n/).forEach((line) => {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
    if (m) listening.add(Number(m[1]));
  });
  return ports.filter((p) => listening.has(p));
}

/**
 * @returns {{ processes: Array, tunAdapters: string[], proxyPorts: number[], hasConflict: boolean, summary: string }}
 */
async function detectConflicts() {
  const [processes, proxyPorts] = await Promise.all([detectProxyProcesses(), detectProxyPorts()]);
  const tunAdapters = detectTunAdapters();

  // 只把「真在监听端口」的进程算作冲突；被动待命的不报警
  const activeProcs = processes.filter((p) => p.listening);
  const passiveProcs = processes.filter((p) => !p.listening);

  const parts = [];
  if (tunAdapters.length) parts.push(`虚拟网卡 ${tunAdapters.join('/')}（有软件在用 TUN 接管流量）`);
  if (activeProcs.length) parts.push(`${activeProcs.map((p) => p.name).join('、')} 正在运行`);
  if (proxyPorts.length) parts.push(`端口 ${proxyPorts.join('/')} 被占用`);

  return {
    processes,
    passive: passiveProcs.map((p) => p.name),
    tunAdapters,
    proxyPorts,
    hasConflict: parts.length > 0,
    summary: parts.join('；'),
  };
}

module.exports = { detectConflicts, detectProxyProcesses, detectTunAdapters, detectProxyPorts };
