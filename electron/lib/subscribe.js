'use strict';

/** 订阅拉取（多 UA 重试、跟随重定向、大小限制） */

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

const SUB_UA = [
  'clash-verge/v2.4.2',
  'ClashforWindows/0.20.39',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
];

const MAX_BYTES = 12 * 1024 * 1024;
const TIMEOUT = 15000;

function fetchUrl(url, uaIndex = 0, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向次数过多'));
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error('订阅链接格式无效'));
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        host: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        timeout: TIMEOUT,
        headers: {
          'User-Agent': SUB_UA[uaIndex] || SUB_UA[0],
          Accept: '*/*',
          'Accept-Encoding': 'identity',
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return resolve(fetchUrl(next, uaIndex, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        let size = 0;
        const chunks = [];
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy();
            reject(new Error('订阅内容超过 12MB'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(decodeBuffer(Buffer.concat(chunks))));
      }
    );
    req.on('timeout', () => req.destroy(new Error('订阅拉取超时')));
    req.on('error', (e) => reject(e));
    req.end();
  });
}

/**
 * 按 UTF-8 解码；出现替换字符时回退到 GBK
 * （国内不少订阅/配置文件是 GBK/ANSI 编码）
 */
function decodeBuffer(buf) {
  if (!buf) return '';
  let text = buf.toString('utf8');
  if (text.includes('\uFFFD')) {
    try {
      const gbk = new TextDecoder('gbk', { fatal: false }).decode(buf);
      // 只有 GBK 结果明显更"干净"时才采用
      const bad = (t) => (t.match(/\uFFFD/g) || []).length;
      if (gbk && bad(gbk) < bad(text)) text = gbk;
    } catch (e) {
      /* 环境不支持 gbk 时忽略 */
    }
  }
  return text;
}

/** 已知的 DNS 污染 / 黑洞地址（GFW 常用注入 IP） */
const POISON_IPS = new Set([
  // GFW 常见的 DNS 注入 / 黑洞地址
  '93.46.8.90', '46.82.174.69', '59.24.3.174', '159.24.3.173', '159.24.3.174',
  '8.7.198.45', '37.61.54.158', '78.16.49.15', '4.36.66.178', '203.98.7.65',
  '207.123.56.89', '243.185.187.39', '10.10.34.34', '10.10.34.35', '10.10.34.36',
  '127.0.0.1', '0.0.0.0',
]);

/** 代理地址规范化：支持 "7890" / "http://127.0.0.1:7890" / "127.0.0.1:7890" */
function normalizeProxy(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  s = s.replace(/^[a-zA-Z]+:\/\//, '').replace(/\/+$/, '');
  if (/^\d+$/.test(s)) return `127.0.0.1:${s}`;
  return s;
}

/** 端口是否有人在监听（本机代理探测用） */
function probeTcp(host, port, timeout = 900) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/** 常见本地代理端口：CFW/mihomo 7890、Clash Verge 7897、v2rayN 10808/10809、通用 1080 */
const COMMON_PROXY_PORTS = [7890, 7897, 7891, 10808, 10809, 1080, 2080];

/** 扫一遍本机常见端口，返回第一个在监听的端口号（没有则 0） */
async function detectLocalProxy(ports = COMMON_PROXY_PORTS) {
  for (const port of ports) {
    // eslint-disable-next-line no-await-in-loop
    if (await probeTcp('127.0.0.1', port, 350)) return port;
  }
  return 0;
}

/** 4xx/5xx 不是网络问题，直接说清楚，省得用户反复重试 */
function httpHint(text) {
  const m = /HTTP (\d{3})/.exec(String(text || ''));
  if (!m) return '';
  const code = Number(m[1]);
  if (code === 401 || code === 403 || code === 404) return '；订阅链接无效或已过期，请重新复制（不是网络问题）';
  if (code >= 500) return '；订阅服务端异常，稍后重试或联系服务商';
  return '';
}

/**
 * 用 Electron 的 net 模块拉取（走 Chromium 网络栈）
 * 好处：自动使用系统代理、支持 HTTP/2、TLS 指纹与浏览器一致
 */
async function fetchWithNet(url, timeout = 20000, proxy = '') {
  let subSession = null;
  if (proxy) {
    try {
      const { session } = require('electron');
      subSession = session.fromPartition('v2ptools-subfetch');
      await subSession.setProxy({
        mode: 'fixed_servers',
        proxyRules: `http=${proxy};https=${proxy}`,
        proxyBypassRules: '<local>',
      });
    } catch (e) {
      subSession = null;
    }
  }
  return new Promise((resolve, reject) => {
    let net;
    try {
      net = require('electron').net;
    } catch (e) {
      return reject(new Error('NET_UNAVAILABLE'));
    }
    if (!net || typeof net.request !== 'function') return reject(new Error('NET_UNAVAILABLE'));

    let settled = false;
    let timer = null;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(val);
    };

    let request;
    try {
      request = net.request({ url, method: 'GET', redirect: 'follow', ...(subSession ? { session: subSession } : {}) });
    } catch (e) {
      return reject(e);
    }
    request.setHeader('User-Agent', SUB_UA[0]);
    request.setHeader('Accept', '*/*');

    timer = setTimeout(() => {
      try {
        request.abort();
      } catch (e) {}
      finish(reject, new Error(`订阅拉取超时（${Math.round(timeout / 1000)}s）`));
    }, timeout);

    request.on('response', (res) => {
      if (res.statusCode >= 400) {
        finish(reject, new Error('HTTP ' + res.statusCode));
        try {
          res.resume();
        } catch (e) {}
        return;
      }
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) {
          try {
            request.abort();
          } catch (e) {}
          finish(reject, new Error('订阅内容超过 12MB'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => finish(resolve, decodeBuffer(Buffer.concat(chunks))));
      res.on('error', (e) => finish(reject, e));
    });

    request.on('error', (e) => finish(reject, e));
    request.end();
  });
}

/** 失败时给出可操作的诊断信息 */
async function diagnose(url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch (e) {
    return '订阅链接格式无效。';
  }
  let ips = [];
  try {
    ips = await dns.promises.resolve4(host);
  } catch (e) {
    const code = e.code || '';
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return `域名 ${host} 解析不到记录，请检查链接或 DNS。`;
    }
    return `域名 ${host} 解析失败（${code || e.message}）。`;
  }
  if (!ips.length) return `域名 ${host} 解析不到 A 记录。`;
  if (ips.some((ip) => POISON_IPS.has(ip))) {
    return `域名 ${host} 被解析到 ${ips[0]}（典型的 DNS 污染地址）。请先开启系统代理/VPN，或在「设置 → 订阅拉取代理」里填本机代理端口（如 127.0.0.1:7890）后重试。`;
  }
  return `域名 ${host} 解析到 ${ips[0]}，但连接失败（可能被墙或服务端不可达）。`;
}

/**
 * 拉取订阅。
 *
 * 被墙的订阅站只有「走代理」能通，所以有代理时**代理与直连并发竞速**：
 * 谁先拿到内容就用谁，避免先干等 30s 代理超时再等直连超时（那种体验就是「卡住」）。
 *   1) 代理（若配置/自动借用）+ 直连 并发，先成功者胜
 *   2) 都失败 → Node https 多 UA 兜底（老订阅站 / 证书链异常）
 *   3) 全失败 → 拼一句能指导操作的话
 */
async function fetchSubscription(url, opts = {}) {
  const proxy = normalizeProxy(opts.proxy);
  const timeout = Math.max(8000, Number(opts.timeout) || 25000);
  const errors = [];

  const attempt = (label, proxyAddr, ms) =>
    new Promise((resolve) => {
      fetchWithNet(url, ms, proxyAddr)
        .then((text) => {
          if (text && text.trim()) return resolve(text);
          errors.push(`${label}：内容为空`);
          resolve(null);
        })
        .catch((e) => {
          // 非 Electron 环境（单测 / CLI）没有 net 模块，静默跳过
          if (!e || e.message !== 'NET_UNAVAILABLE') errors.push(`${label}：${e && e.message}`);
          resolve(null);
        });
    });

  const tasks = [];
  if (proxy) tasks.push(attempt(`代理 ${proxy}`, proxy, Math.max(timeout, 30000)));
  tasks.push(attempt('直连', '', timeout));

  // 竞速：第一个成功即返回，其余请求留在后台自然结束
  const winner = await new Promise((resolve) => {
    let pending = tasks.length;
    tasks.forEach((p) =>
      p.then((text) => {
        if (text) return resolve(text);
        pending -= 1;
        if (pending === 0) resolve(null);
      })
    );
  });
  if (winner) return winner;

  // Node https 兜底：超时说明网络根本不通，没必要把 3 个 UA 都跑一遍
  for (let i = 0; i < SUB_UA.length; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const text = await fetchUrl(url, i);
      if (text && text.trim()) return text;
      errors.push('直连（Node）：内容为空');
    } catch (e) {
      errors.push(`直连（Node）：${e.message}`);
      if (/超时/.test(e.message)) break;
    }
  }

  const detail = await diagnose(url);
  const timedOut = errors.some((m) => /超时/.test(m));
  const head = timedOut ? '订阅拉取超时' : '订阅拉取失败';
  const tried = proxy ? `已尝试代理 ${proxy} 与直连` : '未配置拉取代理，仅尝试直连';
  const hint = httpHint(errors.join('；')) || (proxy ? '' : await proxyHint(opts.proxyCandidates));
  throw new Error(`${head}。${detail}${hint}（${tried}）`);
}

/**
 * 直连失败且没配代理时，扫一下本机常见端口：
 * 有代理在跑就直接告诉用户填哪个端口，没有就提醒先启动客户端——
 * 比「可能被墙」这种只能干瞪眼的提示有用。
 */
async function proxyHint(candidates) {
  const port = await detectLocalProxy(candidates);
  if (port) return `；检测到本机 127.0.0.1:${port} 有代理在监听，可在「设置 → 订阅拉取代理」填该端口后重试`;
  return '；本机未检测到常见代理端口（7890 / 7897 / 10809），如需经代理拉取请先启动代理客户端';
}

module.exports = {
  fetchSubscription,
  fetchUrl,
  fetchWithNet,
  diagnose,
  normalizeProxy,
  decodeBuffer,
  probeTcp,
  detectLocalProxy,
  proxyHint,
  COMMON_PROXY_PORTS,
  SUB_UA,
  POISON_IPS,
};
