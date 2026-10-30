'use strict';

/**
 * mihomo (Clash.Meta) 内核管理
 * - 依据节点列表生成配置：每个节点一个本地 mixed 监听端口（listener → proxy 绑定）
 * - 负责内核进程的启动 / 停止 / 健康检查
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const yaml = require('js-yaml');

const PORT_BASE = 23400;
const PORT_MAX = 29000;

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function findFreePorts(count, startAt = PORT_BASE) {
  const ports = [];
  let p = startAt;
  while (ports.length < count && p < PORT_MAX) {
    // eslint-disable-next-line no-await-in-loop
    const free = await isPortFree(p);
    if (free) ports.push(p);
    p += 1;
  }
  if (ports.length < count) throw new Error('本地端口不足，无法为全部节点分配监听端口');
  return ports;
}

function httpGet(port, urlPath, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

class CoreManager {
  constructor(opts) {
    this.corePath = opts.corePath;
    this.dataDir = opts.dataDir;
    this.onLog = opts.onLog || (() => {});
    this.proc = null;
    this.configPath = path.join(this.dataDir, 'config.yaml');
    this.ctlPort = 0;
    this.portMap = new Map(); // nodeId -> local port
    this.nodeNameMap = new Map(); // nodeId -> core proxy name
    this.nameToId = new Map();
    this.running = false;
    this.starting = false;
    this.lastError = '';
  }

  version() {
    return new Promise((resolve) => {
      if (!this.corePath || !fs.existsSync(this.corePath)) return resolve('');
      execFile(this.corePath, ['-v'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve('');
        resolve(String(stdout || '').trim());
      });
    });
  }

  buildConfig(nodes, ports) {
    const proxies = [];
    const listeners = [];
    const names = [];

    nodes.forEach((n, i) => {
      const name = `n${i}`;
      this.nodeNameMap.set(n.id, name);
      this.nameToId.set(name, n.id);
      proxies.push({ name, type: n.type, server: n.server, port: Number(n.port), ...n.conf });
      listeners.push({
        name: `l${i}`,
        type: 'mixed',
        port: ports[i],
        listen: '127.0.0.1',
        proxy: name,
      });
      names.push(name);
    });

    const cfg = {
      'mixed-port': 0,
      'allow-lan': false,
      mode: 'rule',
      'log-level': 'warning',
      ipv6: false,
      'external-controller': `127.0.0.1:${this.ctlPort}`,
      'unified-delay': true,
      'tcp-concurrent': true,
      'find-process-mode': 'off',
      'geo-auto-update': false,
      'geodata-mode': false,
      profile: { 'store-selected': false, 'store-fake-ip': false },
      dns: {
        enable: true,
        ipv6: false,
        'enhanced-mode': 'redir-host',
        'default-nameserver': ['223.5.5.5', '119.29.29.29'],
        nameserver: ['223.5.5.5', '119.29.29.29', '8.8.8.8'],
      },
      proxies,
      listeners,
      'proxy-groups': [
        {
          name: 'IPH-PROXY',
          type: 'select',
          proxies: names.length ? names : ['DIRECT'],
        },
      ],
      rules: ['MATCH,DIRECT'],
    };
    return cfg;
  }

  async start(nodes) {
    if (this.starting) throw new Error('内核正在启动中');
    this.starting = true;
    try {
      await this.stop();
      if (!this.corePath || !fs.existsSync(this.corePath)) {
        throw new Error('未找到内核文件 mihomo.exe');
      }
      if (!nodes || !nodes.length) throw new Error('没有可用的节点');

      this.portMap.clear();
      this.nodeNameMap.clear();
      this.nameToId.clear();

      const ports = await findFreePorts(nodes.length + 1);
      this.ctlPort = ports[0];
      const nodePorts = ports.slice(1);
      nodes.forEach((n, i) => this.portMap.set(n.id, nodePorts[i]));

      const cfg = this.buildConfig(nodes, nodePorts);
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.configPath, yaml.dump(cfg, { lineWidth: 4096, noRefs: true }), 'utf8');

      const errLog = path.join(this.dataDir, 'core.log');
      const out = fs.openSync(errLog, 'w');

      this.proc = spawn(this.corePath, ['-d', this.dataDir, '-f', this.configPath], {
        cwd: this.dataDir,
        windowsHide: true,
        stdio: ['ignore', out, out],
      });

      this.proc.on('exit', (code, signal) => {
        this.running = false;
        if (code !== 0 && code !== null) {
          this.lastError = this.readLog();
          this.onLog('内核退出 code=' + code + ' ' + this.lastError.slice(-400));
        }
      });

      // 等待 external-controller 就绪
      const ok = await this.waitReady(15000);
      if (!ok) {
        const log = this.readLog();
        await this.stop();
        throw new Error('内核启动失败: ' + this.briefError(log));
      }
      this.running = true;
      return { ports: this.portMap, ctlPort: this.ctlPort };
    } finally {
      this.starting = false;
    }
  }

  readLog() {
    try {
      return fs.readFileSync(path.join(this.dataDir, 'core.log'), 'utf8');
    } catch (e) {
      return '';
    }
  }

  /** 从内核日志里提取一行最可读的错误信息 */
  briefError(log) {
    const lines = String(log || '').split('\n').filter(Boolean);
    const errLine = lines.find((l) => /level=(error|fatal)/i.test(l));
    const pick = errLine || lines[lines.length - 1] || '未知错误';
    const m = /msg="?([^"]+)"?$/.exec(pick);
    return (m ? m[1] : pick).slice(0, 160);
  }

  async waitReady(timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.proc && this.proc.exitCode !== null) return false;
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await httpGet(this.ctlPort, '/version', 1200);
        if (r.status === 200) return true;
      } catch (e) {
        /* 继续等待 */
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 180));
    }
    return false;
  }

  portOf(nodeId) {
    return this.portMap.get(nodeId) || 0;
  }

  async stop() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 120));
      if (this.proc && this.proc.exitCode === null) {
        try {
          process.kill(this.proc.pid, 'SIGKILL');
        } catch (e) {}
      }
      this.proc = null;
    }
    this.running = false;
  }
}

module.exports = { CoreManager, findFreePorts, isPortFree };
