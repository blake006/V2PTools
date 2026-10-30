'use strict';

const http = require('http');
const https = require('https');
const { agentFor } = require('./proxyAgent');

const DEFAULT_LATENCY_URLS = [
  'http://cp.cloudflare.com/generate_204',
  'http://connectivitycheck.platform.hicloud.com/generate_204',
  'http://www.baidu.com',
];

const DEFAULT_IP_URLS = [
  'http://ip.3322.net',
  'http://icanhazip.com',
  'https://ipinfo.io/ip',
  'http://ip-api.com/line/?fields=query',
];

const SPEED_SOURCES = [
  {
    id: 'cloudflare',
    name: 'Cloudflare (自动)',
    build: (bytes) => `https://speed.cloudflare.com/__down?bytes=${bytes}`,
  },
  {
    id: 'cachefly',
    name: 'Cachefly 10MB',
    build: () => 'http://cachefly.cachefly.net/10mb.test',
  },
  {
    id: 'ovh',
    name: 'OVH 10MB',
    build: () => 'https://proof.ovh.net/files/10Mb.dat',
  },
  {
    id: 'tele2',
    name: 'Tele2 10MB',
    build: () => 'http://speedtest.tele2.net/10MB.zip',
  },
];

/**
 * 通过本地代理端口发起 HTTP(S) 请求
 */
function requestThrough(proxyPort, url, opts = {}) {
  const {
    timeout = 8000,
    maxBytes = 0,
    method = 'GET',
    signal,
    wantBody = true,
  } = opts;

  return new Promise((resolve) => {
    let done = false;
    const started = Date.now();
    let firstByteAt = 0;
    let bytes = 0;
    const chunks = [];

    const finish = (payload) => {
      if (done) return;
      done = true;
      resolve(payload);
    };

    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return finish({ ok: false, error: 'URL 无效', ms: 0 });
    }

    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const agent = agentFor(proxyPort, isHttps);

    const req = lib.request(
      {
        host: u.hostname,
        port: Number(u.port) || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method,
        agent,
        headers: {
          Host: u.host,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) IPHealth/1.0',
          Accept: '*/*',
          Connection: 'close',
        },
      },
      (res) => {
        firstByteAt = Date.now();
        const status = res.statusCode;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (wantBody && chunks.length < 64) chunks.push(chunk);
          if (maxBytes && bytes >= maxBytes) {
            req.destroy();
            finish({
              ok: true,
              status,
              ttfb: firstByteAt - started,
              total: Date.now() - started,
              bytes,
              body: wantBody ? Buffer.concat(chunks).toString('utf8') : '',
              truncated: true,
            });
          }
        });
        res.on('end', () =>
          finish({
            ok: true,
            status,
            ttfb: firstByteAt - started,
            total: Date.now() - started,
            bytes,
            body: wantBody ? Buffer.concat(chunks).toString('utf8') : '',
          })
        );
        res.on('error', (e) => finish({ ok: false, error: e.message, ms: Date.now() - started }));
      }
    );

    const timer = setTimeout(() => {
      const partial = bytes > 0;
      req.destroy();
      if (partial) {
        finish({
          ok: true,
          status: 0,
          ttfb: firstByteAt ? firstByteAt - started : 0,
          total: Date.now() - started,
          bytes,
          body: wantBody ? Buffer.concat(chunks).toString('utf8') : '',
          timedOut: true,
        });
      } else {
        finish({ ok: false, error: '请求超时', ms: Date.now() - started, timeout: true });
      }
    }, timeout);

    if (signal) {
      const onAbort = () => {
        req.destroy();
        finish({ ok: false, error: '已取消', ms: Date.now() - started });
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    req.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: e.message || '连接失败', ms: Date.now() - started });
    });

    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

/** 直连请求（不走代理） */
function requestDirect(url, opts = {}) {
  return requestThrough(0, url, opts);
}

async function tryUrls(proxyPort, urls, opts) {
  let lastErr = '';
  for (const url of urls) {
    // eslint-disable-next-line no-await-in-loop
    const r = await requestThrough(proxyPort, url, opts);
    if (r.ok && r.status && r.status < 400) return { ...r, url };
    lastErr = r.error || `HTTP ${r.status}`;
  }
  return { ok: false, error: lastErr || '全部测速源不可用' };
}

/** 延迟测试：先预热一次（建立 DNS/连接），再多次采样，返回 min / avg / 抖动 */
async function testLatency(proxyPort, opts = {}) {
  const urls = opts.urls && opts.urls.length ? opts.urls : DEFAULT_LATENCY_URLS;
  const samples = [];
  const rounds = opts.rounds || 3;
  let usedUrl = '';
  let lastError = '';

  // 预热：结果不计入统计，避免首包 DNS 解析拖高延迟与抖动
  const warm = await tryUrls(proxyPort, urls, {
    timeout: opts.timeout || 8000,
    signal: opts.signal,
    wantBody: false,
  });
  if (!warm.ok) {
    if (opts.signal && opts.signal.aborted) return { ok: false, error: '已取消' };
    return { ok: false, error: warm.error || '代理不可用' };
  }
  usedUrl = warm.url;

  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await tryUrls(proxyPort, [usedUrl, ...urls.filter((u) => u !== usedUrl)], {
      timeout: opts.timeout || 8000,
      signal: opts.signal,
      wantBody: false,
    });
    if (r.ok && r.status && r.status < 400) {
      usedUrl = r.url;
      samples.push(r.ttfb);
    } else {
      lastError = r.error;
      if (opts.signal && opts.signal.aborted) break;
    }
  }

  if (!samples.length) return { ok: false, error: lastError || '代理不可用' };
  const min = Math.min(...samples);
  const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  const jitter = samples.length > 1 ? Math.max(...samples) - min : 0;
  return { ok: true, min, avg, jitter, samples };
}

/** 测速：返回 Mbps */
async function testSpeed(proxyPort, opts = {}) {
  const bytes = opts.bytes || 10 * 1024 * 1024;
  const source = SPEED_SOURCES.find((s) => s.id === opts.sourceId) || SPEED_SOURCES[0];
  const url = source.build(bytes);
  const timeout = opts.timeout || 20000;
  const started = Date.now();
  const r = await requestThrough(proxyPort, url, {
    timeout,
    maxBytes: bytes,
    wantBody: false,
    signal: opts.signal,
  });
  if (!r.ok || !r.bytes) {
    return { ok: false, error: r.error || '无数据返回' };
  }
  const elapsed = Math.max(r.total, 1);
  const mbps = (r.bytes * 8) / (elapsed / 1000) / 1e6;
  return {
    ok: true,
    mbps: Math.round(mbps * 100) / 100,
    bytes: r.bytes,
    ms: elapsed,
    partial: !!r.timedOut,
    source: source.id,
  };
}

/** 通过代理获取出口 IP */
async function fetchExitIP(proxyPort, opts = {}) {
  const urls = opts.urls && opts.urls.length ? opts.urls : DEFAULT_IP_URLS;
  const r = await tryUrls(proxyPort, urls, { timeout: opts.timeout || 8000, signal: opts.signal });
  if (!r.ok) return { ok: false, error: r.error };
  const text = String(r.body || '').trim();
  const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(text);
  if (!m) return { ok: false, error: '返回内容不是 IP' };
  return { ok: true, ip: m[1] };
}

/** TCP 直连延迟（UDP 类协议不适用） */
function testTcp(host, port, timeout = 4000) {
  const net = require('net');
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch (e) {}
      resolve(r);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish({ ok: true, ms: Date.now() - started }));
    sock.once('timeout', () => finish({ ok: false, error: 'TCP 超时' }));
    sock.once('error', (e) => finish({ ok: false, error: e.code || e.message }));
  });
}

module.exports = {
  requestThrough,
  requestDirect,
  testLatency,
  testSpeed,
  fetchExitIP,
  testTcp,
  DEFAULT_LATENCY_URLS,
  DEFAULT_IP_URLS,
  SPEED_SOURCES,
};
