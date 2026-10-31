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

/**
 * 路由模式
 *  global      全局：所有流量走节点
 *  bypass-cn   绕过大陆：CN 域名 / CN IP 段直连，其余走节点（最实用）
 *  proxy-list  仅名单：只有名单内的站点走节点，其余直连
 */
const ROUTE_MODES = {
  global: { label: '全局代理', desc: '所有流量都走节点' },
  'bypass-cn': { label: '绕过大陆', desc: '国内域名/IP 直连，其余走节点' },
  'proxy-list': { label: '仅名单代理', desc: '只有名单内的站点走节点' },
};

const RULE_FILES = {
  'cn-domain': { file: 'cn-domain.yaml', behavior: 'domain' },
  'cn-cidr': { file: 'cn-cidr.yaml', behavior: 'ipcidr' },
  'gfw-domain': { file: 'gfw-domain.yaml', behavior: 'domain' },
};

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
    this.rulesDir = opts.rulesDir || '';
    this.onLog = opts.onLog || (() => {});
    this.onExit = opts.onExit || (() => {});

    this.proc = null;
    this.port = 0;
    this.ctlPort = 0;
    this.node = null;
    this.routeMode = 'global';
    this.running = false;
    this.startedAt = 0;
    this.lastError = '';
    this.configPath = path.join(this.dataDir, 'gateway.yaml');
    this.logPath = path.join(this.dataDir, 'gateway.log');
  }

  /* ---------------- 配置 ---------------- */

  /**
   * mihomo 只允许 rule-provider 指向「数据目录内的子路径」，
   * 所以启动前把随包分发的规则复制到 <dataDir>/rules，配置里用相对路径引用。
   */
  ensureLocalRules() {
    if (!this.rulesDir || !fs.existsSync(this.rulesDir)) return '';
    const localDir = path.join(this.dataDir, 'rules');
    fs.mkdirSync(localDir, { recursive: true });
    for (const meta of Object.values(RULE_FILES)) {
      const src = path.join(this.rulesDir, meta.file);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(localDir, meta.file);
      let needCopy = true;
      try {
        needCopy = !fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size;
      } catch (e) {
        needCopy = true;
      }
      if (needCopy) fs.copyFileSync(src, dst);
    }
    return localDir;
  }

  /** 按路由模式生成 rule-providers / rules */
  buildRouting(routeMode) {
    const mode = ROUTE_MODES[routeMode] ? routeMode : 'global';
    if (mode === 'global') return { providers: null, rules: ['MATCH,PROXY'] };

    const need = mode === 'bypass-cn' ? ['cn-domain', 'cn-cidr'] : ['gfw-domain'];
    const providers = {};
    const missing = [];
    for (const key of need) {
      const meta = RULE_FILES[key];
      if (!this.rulesDir || !fs.existsSync(path.join(this.rulesDir, meta.file))) {
        missing.push(meta.file);
        continue;
      }
      providers[key] = {
        type: 'file',
        behavior: meta.behavior,
        format: 'yaml',
        path: `./rules/${meta.file}`, // 相对 dataDir，mihomo 只接受数据目录内的路径
      };
    }
    if (missing.length) {
      throw new Error(`缺少分流规则文件 ${missing.join(', ')}，请执行 npm run fetch-rules 后重新打包`);
    }

    const rules =
      mode === 'bypass-cn'
        ? ['RULE-SET,cn-domain,DIRECT', 'RULE-SET,cn-cidr,DIRECT', 'MATCH,PROXY']
        : ['RULE-SET,gfw-domain,PROXY', 'MATCH,DIRECT'];
    return { providers, rules };
  }

  buildConfig(node, port, ctlPort, opts = {}) {
    const conf = Object.assign({}, node.conf || {});
    // 关键字段以节点模型为准，避免 conf 里的残留字段覆盖
    delete conf.name;
    delete conf.type;
    delete conf.server;
    delete conf.port;

    const routing = this.buildRouting(opts.routeMode || 'global');

    const cfg = {
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
      rules: routing.rules,
    };
    if (routing.providers) cfg['rule-providers'] = routing.providers;
    return cfg;
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
    this.routeMode = ROUTE_MODES[opts.routeMode] ? opts.routeMode : 'global';
    this.lastError = '';

    const cfg = this.buildConfig(node, port, ctlPort, { routeMode: this.routeMode });
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.ensureLocalRules();
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

  /** 换节点：保持端口与路由模式不变（系统代理无需改动），重启内核即可 */
  async switchNode(node) {
    if (!this.running) throw new Error('系统代理未开启');
    const { port, routeMode } = this;
    await this.stop({ silent: true });
    return this.start(node, { port, routeMode });
  }

  /** 切换路由模式：同样保持端口不变，系统代理设置完全不动 */
  async setRouteMode(routeMode) {
    if (!this.running) throw new Error('系统代理未开启');
    if (!ROUTE_MODES[routeMode]) throw new Error('未知的路由模式：' + routeMode);
    if (routeMode === this.routeMode) return { port: this.port, routeMode };
    const port = this.port;
    const node = this.node;
    await this.stop({ silent: true });
    return this.start(node, { port, routeMode });
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
      routeMode: this.routeMode,
      routeLabel: (ROUTE_MODES[this.routeMode] || ROUTE_MODES.global).label,
      node: this.node
        ? { id: this.node.id, name: this.node.name, type: this.node.type, server: this.node.server, port: this.node.port }
        : null,
      startedAt: this.startedAt,
      error: this.lastError,
    };
  }
}

module.exports = { Gateway, DEFAULT_PORT, pickPort, ROUTE_MODES };
