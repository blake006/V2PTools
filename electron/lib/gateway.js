'use strict';

/**
 * 系统代理网关
 *
 * 与 IPHealth 的「每节点一个端口做检测」不同：系统代理只需要**一条**链路。
 * 这里用独立的 mihomo 进程 + 单个 mixed 端口（HTTP/SOCKS 同端口），
 * 把选中的节点作为唯一出口（MATCH,PROXY），然后把系统代理指向这个端口。
 *
 * 与检测内核完全隔离：检测任务会反复重启自己的内核，不会影响正在使用的系统代理。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const yaml = require('js-yaml');

const { isPortFree } = require('./core');
const { fetchExitIP } = require('./tester');

const DEFAULT_PORT = 7890;
const PORT_SCAN_MAX = 200;

function httpGet(port, urlPath, timeout = 1200) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function tcpAlive(port, timeout = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      try {
        sock.destroy();
      } catch (e) {}
      resolve(v);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** 优先使用期望端口，被占用则向后找可用端口 */
async function pickPort(preferred) {
  const start = Number(preferred) || DEFAULT_PORT;
  for (let p = start; p < start + PORT_SCAN_MAX && p < 65536; p += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p)) return p;
  }
  throw new Error(`端口 ${start} 起连续 ${PORT_SCAN_MAX} 个端口都被占用，请更换系统代理端口`);
}

class Gateway {
  constructor(opts = {}) {
    this.corePath = opts.corePath;
    this.dataDir = opts.dataDir || process.cwd();
    this.onLog = opts.onLog || (() => {});
    this.onExit = opts.onExit || (() => {});

    this.proc = null;
    this.port = 0;
    this.ctlPort = 0;
    this.node = null;
    this.running = false;
    this.startedAt = 0;
    this.lastError = '';
    this.configPath = path.join(this.dataDir, 'gateway.yaml');
    this.logPath = path.join(this.dataDir, 'gateway.log');
  }

  /* ---------------- 配置 ---------------- */

  buildConfig(node, port, ctlPort) {
    const conf = Object.assign({}, node.conf || {});
    // 关键字段以节点模型为准，避免 conf 里的残留字段覆盖
    delete conf.name;
    delete conf.type;
    delete conf.server;
    delete conf.port;

    return {
      'mixed-port': port,
      'allow-lan': false,
      mode: 'rule',
      'log-level': 'warning',
      ipv6: false,
      'external-controller': `127.0.0.1:${ctlPort}`,
      'unified-delay': true,
      'tcp-concurrent': true,
      'find-process-mode': 'off',
      'geo-auto-update': false,
      'geodata-mode': false,
      'global-client-fingerprint': conf['client-fingerprint'] || undefined,
      profile: { 'store-selected': false, 'store-fake-ip': false },
      tun: { enable: false },
      dns: {
        enable: true,
        ipv6: false,
        'enhanced-mode': 'redir-host',
        'default-nameserver': ['223.5.5.5', '119.29.29.29'],
        nameserver: ['223.5.5.5', '119.29.29.29', '8.8.8.8'],
      },
      proxies: [
        {
          ...conf,
          name: 'PROXY',
          type: node.type,
          server: node.server,
          port: Number(node.port),
        },
      ],
      rules: ['MATCH,PROXY'],
    };
  }

  readLog() {
    try {
      return fs.readFileSync(this.logPath, 'utf8');
    } catch (e) {
      return '';
    }
  }

  briefError(log) {
    const lines = String(log || '').split('\n').filter(Boolean);
    const errLine = lines.find((l) => /level=(error|fatal)/i.test(l));
    const pick = errLine || lines[lines.length - 1] || '未知错误';
    const m = /msg="?([^"]+)"?$/.exec(pick);
    return (m ? m[1] : pick).slice(0, 200);
  }

  /* ---------------- 生命周期 ---------------- */

  async start(node, opts = {}) {
    if (!node) throw new Error('未选择节点');
    if (!this.corePath || !fs.existsSync(this.corePath)) throw new Error('未找到内核文件 mihomo.exe，请先执行 npm run fetch-core');

    await this.stop({ silent: true });

    const port = await pickPort(opts.port || DEFAULT_PORT);
    const ctlPort = await pickPort(port + 1);

    this.node = node;
    this.port = port;
    this.ctlPort = ctlPort;
    this.lastError = '';

    const cfg = this.buildConfig(node, port, ctlPort);
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.configPath, yaml.dump(cfg, { lineWidth: 4096, noRefs: true }), 'utf8');

    const out = fs.openSync(this.logPath, 'w');
    this.proc = spawn(this.corePath, ['-d', this.dataDir, '-f', this.configPath], {
      cwd: this.dataDir,
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    // 子进程已持有句柄，父进程这份要关掉，否则日志文件一直被占用
    try {
      fs.closeSync(out);
    } catch (e) {}

    this.proc.on('exit', (code) => {
      const wasRunning = this.running;
      this.running = false;
      this.proc = null;
      if (wasRunning && code !== 0 && code !== null) {
        this.lastError = this.briefError(this.readLog());
        this.onLog('系统代理内核退出 code=' + code + ' ' + this.lastError);
      }
      if (wasRunning) this.onExit({ code, error: this.lastError });
    });

    const ready = await this.waitReady(15000);
    if (!ready) {
      const log = this.readLog();
      await this.stop({ silent: true });
      throw new Error('代理内核启动失败：' + this.briefError(log));
    }

    this.running = true;
    this.startedAt = Date.now();
    return { port: this.port, ctlPort: this.ctlPort };
  }

  async waitReady(timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!this.proc) return false;
      // eslint-disable-next-line no-await-in-loop
      const ctlOk = await httpGet(this.ctlPort, '/version', 900).then((r) => r.status === 200).catch(() => false);
      if (ctlOk) {
        // eslint-disable-next-line no-await-in-loop
        return await tcpAlive(this.port, 900);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }

  /** 换节点：保持端口不变（系统代理无需改动），重启内核即可 */
  async switchNode(node) {
    if (!this.running) throw new Error('系统代理未开启');
    const port = this.port;
    await this.stop({ silent: true });
    return this.start(node, { port });
  }

  async stop(opts = {}) {
    const proc = this.proc;
    this.proc = null;
    this.running = false;
    if (proc) {
      try {
        proc.removeAllListeners('exit');
        proc.kill();
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 150));
      if (proc.exitCode === null) {
        try {
          process.kill(proc.pid, 'SIGKILL');
        } catch (e) {}
      }
    }
    if (!opts.silent) {
      this.node = null;
      this.port = 0;
    }
    return true;
  }

  /* ---------------- 连通性 ---------------- */

  /** 通过本地网关端口取一次出口 IP，用于「已开启」后的真实校验 */
  async probe(opts = {}) {
    if (!this.running) return { ok: false, error: '系统代理未开启' };
    const r = await fetchExitIP(this.port, { urls: opts.urls, timeout: opts.timeout || 8000 });
    return r;
  }

  status() {
    return {
      running: this.running,
      port: this.port,
      node: this.node
        ? { id: this.node.id, name: this.node.name, type: this.node.type, server: this.node.server, port: this.node.port }
        : null,
      startedAt: this.startedAt,
      error: this.lastError,
    };
  }
}

module.exports = { Gateway, DEFAULT_PORT, pickPort };
