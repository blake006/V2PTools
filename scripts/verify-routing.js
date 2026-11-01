'use strict';

/**
 * 分流规则端到端验证
 *
 * 为什么不用「HTTP GET 走代理」来测：Node 的 http 模块在发代理请求前会先做本地
 * DNS 解析，请求落到 IP 上，域名规则根本不会被触发 —— 这是上次验证失真的原因。
 * 改用 CONNECT（HTTPS 代理标准形态），Host 原样带给内核，域名规则才能生效。
 *
 * 判定依据：内核 /connections 里每条连接的 `rule` 与 `chains` 字段，
 * 这是 mihomo 自己算出来的决策，比任何外部推测都可靠。
 *
 * 用法: node scripts/verify-routing.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const yaml = require('js-yaml');
const { spawn } = require('child_process');

const CORE = path.join(__dirname, '..', 'vendor', 'mihomo.exe');
const RULES = path.join(__dirname, '..', 'assets', 'rules');

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, detail) {
  pass += 1;
  console.log(`  ✔ ${label}${detail ? '  ' + detail : ''}`);
}
function bad(label, detail) {
  fail += 1;
  failures.push(label);
  console.log(`  ✘ ${label}${detail ? '  ' + detail : ''}`);
}
function expect(label, actual, wanted) {
  if (actual === wanted) ok(label, `${actual}`);
  else bad(label, `期望 ${wanted}，实际 ${actual}`);
}

function freePort() {
  return new Promise((r) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
}

function httpGet(port, p, timeout = 4000) {
  return new Promise((res) => {
    const q = http.get({ host: '127.0.0.1', port, path: p, timeout }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => res(b));
    });
    q.on('timeout', () => { q.destroy(); res(''); });
    q.on('error', () => res(''));
  });
}

/**
 * 通过 mixed 端口发 CONNECT，域名原样传给内核。
 * 返回内核日志里该域名对应的决策行（形如 match RuleSet(cn-domain) using DIRECT）。
 */
function connectThrough(port, host, timeout = 5000) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `${host}:443`, timeout });
    req.on('connect', (res, sock) => {
      try { sock.destroy(); } catch (e) {}
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
  });
}

/**
 * 从内核日志里取某个域名的最新决策行。
 *
 * 为什么不用 /connections：它只保留**活跃**连接，DIRECT 通常毫秒级结束，
 * 等查询时记录已经没了 —— 会误判成「规则没命中」。日志是持久的事实来源。
 */
function decisionFromLog(logPath, host, fromByte) {
  let text = '';
  try {
    const buf = fs.readFileSync(logPath);
    text = buf.slice(fromByte).toString('utf8');
  } catch (e) {
    return null;
  }
  const lines = text.split('\n').filter((l) => l.includes(host));
  // 从后往前找，取最新一条带决策信息的
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i];

    // 形态 A（成功直连）：[TCP] ... --> host:443 match RuleSet(cn-domain) using DIRECT
    const a = /match\s+(\S+)\s+using\s+([A-Za-z0-9_\-→]+)/.exec(l);
    if (a) return { rule: a[1], out: a[2], line: l.trim() };

    // 形态 B（走代理后失败）：dial PROXY (match RuleSet(gfw-domain)/) ... error: ...
    // 出口在 dial 后面，规则在括号里且带一个尾斜杠
    const b = /dial\s+([A-Za-z0-9_\-→]+)\s+\(match\s+(.+?)\/?\)/.exec(l);
    if (b) return { rule: b[2], out: b[1], line: l.trim() };
  }
  return null;
}

function logSize(p) {
  try { return fs.statSync(p).size; } catch (e) { return 0; }
}

const MODES = {
  global: {
    rules: ['MATCH,PROXY'],
    providers: [],
    cases: [
      ['www.baidu.com', 'PROXY'],
      ['www.google.com', 'PROXY'],
    ],
  },
  'bypass-cn': {
    rules: ['RULE-SET,cn-domain,DIRECT', 'RULE-SET,cn-cidr,DIRECT', 'MATCH,PROXY'],
    providers: ['cn-domain', 'cn-cidr'],
    cases: [
      ['www.baidu.com', 'DIRECT'],
      ['www.qq.com', 'DIRECT'],
      ['www.taobao.com', 'DIRECT'],
      ['www.bilibili.com', 'DIRECT'],
      ['www.google.com', 'PROXY'],
      ['www.youtube.com', 'PROXY'],
      ['github.com', 'PROXY'],
      // 子域必须跟着父域走（+.baidu.com 要能覆盖 tieba）
      ['tieba.baidu.com', 'DIRECT'],
      ['pan.baidu.com', 'DIRECT'],
      // 后缀陷阱：域名里含 baidu.com 但不是它的子域，不能被误判为直连
      ['baidu.com.evil.example', 'PROXY'],
      ['example.com', 'PROXY'],
    ],
  },
  'proxy-list': {
    rules: ['RULE-SET,gfw-domain,PROXY', 'MATCH,DIRECT'],
    providers: ['gfw-domain'],
    cases: [
      ['www.google.com', 'PROXY'],
      ['www.youtube.com', 'PROXY'],
      ['www.baidu.com', 'DIRECT'],
      ['www.qq.com', 'DIRECT'],
      // 子域跟随
      ['mail.google.com', 'PROXY'],
      ['r1---sn.googlevideo.com', 'PROXY'],
      // 后缀陷阱：不是 google.com 的子域，不能走代理
      ['google.com.evil.example', 'DIRECT'],
      ['example.com', 'DIRECT'],
    ],
  },
};

async function runMode(mode, spec) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `v2p-rt-${mode}-`));
  const rd = path.join(tmp, 'rules');
  fs.mkdirSync(rd, { recursive: true });
  for (const f of ['cn-domain.yaml', 'cn-cidr.yaml', 'gfw-domain.yaml']) {
    fs.copyFileSync(path.join(RULES, f), path.join(rd, f));
  }

  const port = await freePort();
  const ctl = await freePort();
  const proxyPort = await freePort();

  // 假代理：只记录命中，立刻断开。命中它 = 走了 PROXY
  const proxyHits = [];
  const fake = net.createServer((s) => {
    proxyHits.push(Date.now());
    s.destroy();
  });
  await new Promise((r) => fake.listen(proxyPort, '127.0.0.1', r));

  const providers = {};
  for (const k of spec.providers) {
    const meta = { 'cn-domain': 'domain', 'cn-cidr': 'ipcidr', 'gfw-domain': 'domain' }[k];
    providers[k] = { type: 'file', behavior: meta, format: 'yaml', path: `./rules/${k}.yaml` };
  }

  const cfg = {
    'mixed-port': port,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'info',
    ipv6: false,
    'external-controller': `127.0.0.1:${ctl}`,
    'unified-delay': true,
    'tcp-concurrent': true,
    'find-process-mode': 'off',
    'geodata-mode': false,
    profile: { 'store-selected': false, 'store-fake-ip': false },
    tun: { enable: false },
    dns: {
      enable: true, ipv6: false, 'enhanced-mode': 'redir-host',
      'default-nameserver': ['223.5.5.5', '119.29.29.29'],
      nameserver: ['223.5.5.5', '119.29.29.29', '8.8.8.8'],
    },
    proxies: [{ name: 'PROXY', type: 'http', server: '127.0.0.1', port: proxyPort }],
    rules: spec.rules,
  };
  if (Object.keys(providers).length) cfg['rule-providers'] = providers;

  fs.writeFileSync(path.join(tmp, 'cfg.yaml'), yaml.dump(cfg, { lineWidth: 4096, noRefs: true }), 'utf8');
  const out = fs.openSync(path.join(tmp, 'out.log'), 'w');
  const proc = spawn(CORE, ['-d', tmp, '-f', path.join(tmp, 'cfg.yaml')], { stdio: ['ignore', out, out] });
  fs.closeSync(out);

  console.log(`\n【${mode}】`);

  // 等 provider 加载完成（最多 20s）
  let ready = spec.providers.length === 0;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const raw = await httpGet(ctl, '/providers/rules', 2000);
    try {
      const p = JSON.parse(raw).providers || {};
      if (spec.providers.every((k) => p[k] && Number(p[k].ruleCount) > 0)) {
        ready = true;
        const counts = spec.providers.map((k) => `${k}=${p[k].ruleCount}`).join(' ');
        ok('rule-provider 全部加载', counts);
        break;
      }
    } catch (e) {}
  }
  if (!ready && spec.providers.length) bad('rule-provider 加载超时');

  // 逐个域名验证（用内核日志判定，见 decisionFromLog 注释）
  const logPath = path.join(tmp, 'out.log');
  for (const [host, want] of spec.cases) {
    const mark = logSize(logPath);
    // eslint-disable-next-line no-await-in-loop
    await connectThrough(port, host);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 300));

    const d = decisionFromLog(logPath, host, mark);
    if (!d) {
      bad(`${host.padEnd(20)} → 无日志记录`, `期望 ${want}`);
      continue;
    }
    if (d.out === want) ok(`${host.padEnd(20)} → ${d.out}`, `[${d.rule}]`);
    else bad(`${host.padEnd(20)} → ${d.out}`, `期望 ${want}（rule=${d.rule}）`);
  }

  proc.kill();
  await new Promise((r) => setTimeout(r, 400));
  try { fake.close(); } catch (e) {}
  fs.rmSync(tmp, { recursive: true, force: true });
}

(async () => {
  if (!fs.existsSync(CORE)) {
    console.error('缺少内核 vendor/mihomo.exe，请先 npm run fetch-core');
    process.exit(1);
  }

  console.log('分流规则端到端验证（真实内核 + 真实规则文件）');
  console.log('判定依据：内核日志里的实际决策（match X using Y / dial Y (match X)）');

  for (const [mode, spec] of Object.entries(MODES)) {
    // eslint-disable-next-line no-await-in-loop
    await runMode(mode, spec);
  }

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    console.log('失败项: ' + failures.join(' / '));
  }
  process.exit(fail ? 1 : 0);
})();
