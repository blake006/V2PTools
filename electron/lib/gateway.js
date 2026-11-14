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

/**
 * 境外 IP 查询服务：强制走代理。
 * 否则「绕过大陆」模式会把这些域名判成直连，自检测出来的还是本机 IP，
 * 看起来就像「代理没生效」——这是之前自检结果与实际不一致的根源。
 *
 * 注意：这里**只放境外域名**。国内域名必须留给分流规则自己判断，
 * 否则「国内流量走没走代理」这个信息就没了，也就分不出全局 / 绕过大陆。
 */
const SELF_CHECK_RULES = [
  'DOMAIN,icanhazip.com,PROXY',
  'DOMAIN-SUFFIX,ipify.org,PROXY',
  'DOMAIN,ipinfo.io,PROXY',
  'DOMAIN,ifconfig.me,PROXY',
  'DOMAIN,ip-api.com,PROXY',
];

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const yaml = require('js-yaml');

const { isPortFree } = require('./core');
const { fetchExitIP } = require('./tester');
const { validatePayload } = require('./ruleFormat');
const { sanitizeConfig, validateConfig, diagnoseStart, briefError } = require('./coreCompat');
const { cleanupStale, writePid, removePid } = require('./procCleanup');

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

function httpGet(port, urlPath, timeout = 1200, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: urlPath, timeout }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function tcpAlive(port, timeout = 800, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
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
    this.lastProbe = null;
    this.rulesReady = false;
    this.lastExitCode = null;
    this.degraded = false; // 控制器没起来、但代理端口可用时的降级状态
    this.configPath = path.join(this.dataDir, 'gateway.yaml');
    this.logPath = path.join(this.dataDir, 'gateway.log');
    this.pidFile = path.join(this.dataDir, 'gateway.pid');
  }

  /* ---------------- 配置 ---------------- */

  /**
   * mihomo 只允许 rule-provider 指向「数据目录内的子路径」，
   * 所以启动前把随包分发的规则复制到 <dataDir>/rules，配置里用相对路径引用。
   *
   * 复制的同时做一次格式自检：历史版本生成过「payload 里塞着 'payload:' 和
   * '- ''+.x.com'''」的脏规则，能被 mihomo 静默接受但一条都匹配不上，
   * 表现为分流模式下国内站点也打不开。这里直接抛错，别让它静默失效。
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
      this.assertRuleFileHealthy(dst, meta.file);
    }
    return localDir;
  }

  /** 规则文件格式自检：payload 必须是干净的值列表 */
  assertRuleFileHealthy(file, label) {
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`分流规则 ${label} 解析失败：${e.message}。请执行 npm run fetch-rules 重新生成规则后重新打包`);
    }
    const v = validatePayload(doc && doc.payload);
    if (!v.ok) {
      throw new Error(
        `分流规则 ${label} 格式损坏（示例：${JSON.stringify(v.bad)}）。` +
          '这会让分流完全失效（国内站点也会被代理）。请执行 npm run fetch-rules 重新生成规则后重新打包'
      );
    }
    if (v.count === 0) {
      throw new Error(`分流规则 ${label} 为空，请执行 npm run fetch-rules 重新生成`);
    }
    return v.count;
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
        ? [...SELF_CHECK_RULES, 'RULE-SET,cn-domain,DIRECT', 'RULE-SET,cn-cidr,DIRECT', 'MATCH,PROXY']
        : [...SELF_CHECK_RULES, 'RULE-SET,gfw-domain,PROXY', 'MATCH,DIRECT'];
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
      // 启动阶段用 info：能否监听端口、控制器有没有起来，都写在日志里。
      // 旧值 warning 会把这些 info 全吞掉，启动失败时只剩一句无关的 error 提示，
      // 排障时根本分不清「内核没起来」还是「起来了但连不上」。
      // 就绪后会通过 external-controller 降回 warning，避免连接日志把文件撑大。
      'log-level': 'info',
      ipv6: false,
      'external-controller': `127.0.0.1:${ctlPort}`,
      'unified-delay': true,
      'tcp-concurrent': true,
      'find-process-mode': 'off',
      'geo-auto-update': false,
      'geodata-mode': false,
      // 不要写 global-client-fingerprint：mihomo 1.19.x 已移除该顶层字段，
      // 写了会打一条 level=error（虽然不影响启动，但会被误当成失败原因）。
      // 节点自带的 client-fingerprint 随 conf 展开进 proxies[0]，那才是新内核认可的位置。
      profile: { 'store-selected': false, 'store-fake-ip': false },
      tun: opts.tun
        ? {
            enable: true,
            // gvisor 在 Windows 上兼容性最好，system 栈对某些驱动/杀软更敏感
            stack: 'gvisor',
            device: 'V2PTools',
            'auto-route': true,
            'auto-detect-interface': true,
            // 只劫持 DNS，不碰其他端口，减少与其它软件的摩擦
            'dns-hijack': ['any:53'],
            // strict-route 会在路由表里插更高优先级的规则，容易和别的 VPN 打架
            'strict-route': false,
            // 排除回环与私有网段：否则访问打印机 / NAS / 路由器这些内网设备
            // 也会被塞进 TUN，表现就是「开了代理内网就不通了」
            'route-exclude-address': [
              '127.0.0.0/8',
              '10.0.0.0/8',
              '172.16.0.0/12',
              '192.168.0.0/16',
              '169.254.0.0/16',
            ],
            mtu: 1500,
          }
        : { enable: false },
      dns: {
        enable: true,
        ipv6: false,
        // TUN 接管后所有 DNS 都经过内核：必须用 fake-ip，否则国内 DNS 解析
        // 境外域名会被污染，浏览器拿到假 IP 就是「代理开着打不开网页」
        'enhanced-mode': opts.tun ? 'fake-ip' : 'redir-host',
        'fake-ip-range': '198.18.0.1/16',
        'fake-ip-filter': [
          '*.lan',
          '*.local',
          '*.localhost',
          '*.internal',
          '*.home.arpa',
          'localhost.*',
          'localhost.ptlogin2.qq.com',
          '+.msftconnecttest.com',
          '+.msftncsi.com',
          'time.*.com',
          'ntp.*.com',
        ],
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
    // 兜底：以后内核再移除字段，只需在 coreCompat 里登记，不用改每个生成点
    return sanitizeConfig(cfg).config;
  }

  readLog() {
    try {
      return fs.readFileSync(this.logPath, 'utf8');
    } catch (e) {
      return '';
    }
  }

  /** 统一走兼容层：只认真正的致命错误，不拿日志里第一条 error 冒充失败原因 */
  briefError(log) {
    return briefError(log);
  }

  /* ---------------- 生命周期 ---------------- */

  async start(node, opts = {}) {
    if (!node) throw new Error('未选择节点');
    if (!this.corePath || !fs.existsSync(this.corePath)) throw new Error('未找到内核文件 mihomo.exe，请先执行 npm run fetch-core');

    // 清理上次被强杀/崩溃残留的内核（只杀 pid 对得上且进程名匹配的）
    try {
      cleanupStale(this.pidFile);
    } catch (e) {}

    await this.stop({ silent: true });

    const port = await pickPort(opts.port || DEFAULT_PORT);
    const ctlPort = await pickPort(port + 1);

    this.node = node;
    this.port = port;
    this.ctlPort = ctlPort;
    this.routeMode = ROUTE_MODES[opts.routeMode] ? opts.routeMode : 'global';
    this.tunMode = !!opts.tun;
    this.lastError = '';
    this.degraded = false;

    const cfg = this.buildConfig(node, port, ctlPort, { routeMode: this.routeMode, tun: this.tunMode });
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.ensureLocalRules();
    fs.writeFileSync(this.configPath, yaml.dump(cfg, { lineWidth: 4096, noRefs: true }), 'utf8');

    // 启动前让内核自己校验一次配置：真正的格式/协议错误立刻报，不用干等 15 秒超时。
    // 只对真实存在内核的场合生效（单测里常传占位路径）。
    if (fs.existsSync(this.corePath)) {
      const pre = await validateConfig(this.corePath, this.configPath, this.dataDir);
      if (!pre.ok) throw new Error('代理内核配置校验失败：' + pre.reason);
      if (pre.warnings && pre.warnings.length) this.onLog('内核兼容提示（不影响启动）：' + pre.warnings.join('；'));
    }

    const out = fs.openSync(this.logPath, 'w');
    this.proc = spawn(this.corePath, ['-d', this.dataDir, '-f', this.configPath], {
      cwd: this.dataDir,
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    writePid(this.pidFile, this.proc.pid);
    // 子进程已持有句柄，父进程这份要关掉，否则日志文件一直被占用
    try {
      fs.closeSync(out);
    } catch (e) {}

    this.lastExitCode = null;
    this.proc.on('exit', (code) => {
      const wasRunning = this.running;
      this.lastExitCode = code;
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
      const procAlive = !!(this.proc && this.proc.exitCode === null);
      // 端口没被占用 = 内核压根没监听成功；被占用 = 有别的程序抢了端口
      let portBusy = null;
      try {
        portBusy = !(await isPortFree(this.port));
      } catch (e) {}
      await this.stop({ silent: true });
      const diagnosis = diagnoseStart({
        log,
        procAlive,
        exitCode: this.lastExitCode,
        ctlPort: this.ctlPort,
        mixedPort: this.port,
        portBusy,
        timedOut: true,
      });
      this.lastError = diagnosis;
      throw new Error('代理内核启动失败：' + diagnosis);
    }

    // 关键：等分流规则集真正加载完再宣告就绪。
    // 11 万条域名规则的解析是异步的，比 IP 段慢得多；如果不等，
    // 用户刚开启代理就访问站点会落到 MATCH,PROXY，表现为「分流模式下
    // 国内站点也打不开」。这里等不到也不算致命 —— 只是降级为「可能先走代理」。
    await this.waitRulesLoaded(8000);

    this.running = true;
    this.startedAt = Date.now();
    return { port: this.port, ctlPort: this.ctlPort };
  }

  async waitReady(timeout) {
    const deadline = Date.now() + timeout;
    let degradedSince = 0;
    while (Date.now() < deadline) {
      if (!this.proc) return false;
      // 双地址尝试：某些机器上 127.0.0.1 被 hosts / 防火墙改写，localhost 仍可用
      // eslint-disable-next-line no-await-in-loop
      let ctlOk = await httpGet(this.ctlPort, '/version', 700)
        .then((r) => r.status === 200)
        .catch(() => false);
      if (!ctlOk) {
        // eslint-disable-next-line no-await-in-loop
        ctlOk = await httpGet(this.ctlPort, '/version', 700, 'localhost')
          .then((r) => r.status === 200)
          .catch(() => false);
      }
      if (ctlOk) {
        // eslint-disable-next-line no-await-in-loop
        return (await tcpAlive(this.port, 900)) || (await tcpAlive(this.port, 900, 'localhost'));
      }

      // 控制器起不来但内核日志显示已监听、mixed 端口也连得上时，降级就绪。
      // 控制器只用于流量悬浮窗和规则加载确认，缺了它代理本身仍然可用；
      // 以前这里一律等满 15 秒再报「启动失败」，是本次事故里最误导人的一环。
      // eslint-disable-next-line no-await-in-loop
      const mixedOk = await tcpAlive(this.port, 700);
      if (mixedOk && /listening at/i.test(this.readLog())) {
        if (!degradedSince) degradedSince = Date.now();
        if (Date.now() - degradedSince > 1200) {
          this.degraded = true;
          this.onLog('控制器未就绪，但代理端口已监听：降级启动（悬浮窗与规则确认可能不可用）');
          return true;
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }

  /**
   * 等所有 rule-provider 加载完成（ruleCount > 0）。
   * 只对非 global 模式有意义 —— global 模式没有 provider。
   * @returns {Promise<boolean>} 是否全部就绪
   */
  async waitRulesLoaded(timeout = 8000) {
    if (this.routeMode === 'global') return true;
    const expected = this.routeMode === 'bypass-cn' ? ['cn-domain', 'cn-cidr'] : ['gfw-domain'];
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      if (!this.proc) return false;
      // eslint-disable-next-line no-await-in-loop
      const r = await httpGet(this.ctlPort, '/providers/rules', 1500).catch(() => null);
      if (r && r.status === 200) {
        let providers = null;
        try {
          providers = JSON.parse(r.body).providers || {};
        } catch (e) {
          providers = null;
        }
        if (providers) {
          const allReady = expected.every((k) => providers[k] && Number(providers[k].ruleCount) > 0);
          if (allReady) {
            this.rulesReady = true;
            return true;
          }
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((res) => setTimeout(res, 150));
    }
    // 超时：记一笔，不影响可用性（只是可能先落到 MATCH）
    this.rulesReady = false;
    this.onLog('分流规则加载超时，可能暂时全部走代理出口');
    return false;
  }

  /**
   * 换节点 / 换模式：保持端口不变（系统代理不用改），重启内核。
   *
   * ⑥ 断网机制：重启会先停掉旧内核，这段时间系统代理仍指向这个端口。
   * 如果新配置启动失败，端口就是死的 —— 整机断网。所以失败时必须用
   * 原来的节点/模式在同端口把内核拉回来；连回滚都失败时，明确告诉上层
   * 去还原系统代理（main.js 的 ensureProxySafe 会兜底）。
   */
  async restartKeepingPort(target, fallback) {
    const port = this.port;
    const tun = this.tunMode;
    await this.stop({ silent: true });
    try {
      return await this.start(target.node, { port, routeMode: target.routeMode, tun });
    } catch (err) {
      try {
        await this.start(fallback.node, { port, routeMode: fallback.routeMode, tun });
      } catch (rb) {
        this.rollbackFailed = true;
        throw new Error(
          `新配置启动失败（${err.message}），且自动回退原配置也失败（${rb.message}）；系统代理需要复位`
        );
      }
      this.rollbackFailed = false;
      const e = new Error(`操作失败，已自动回退到原来的配置：${err.message}`);
      e.rolledBack = true;
      throw e;
    }
  }

  /** 换节点：保持端口与路由模式不变（系统代理无需改动），重启内核即可 */
  async switchNode(node) {
    if (!this.running) throw new Error('系统代理未开启');
    const fallback = { node: this.node, routeMode: this.routeMode };
    this.rollbackFailed = false;
    return this.restartKeepingPort({ node, routeMode: this.routeMode }, fallback);
  }

  /** 切换路由模式：同样保持端口不变，系统代理设置完全不动 */
  async setRouteMode(routeMode) {
    if (!this.running) throw new Error('系统代理未开启');
    if (!ROUTE_MODES[routeMode]) throw new Error('未知的路由模式：' + routeMode);
    if (routeMode === this.routeMode) return { port: this.port, routeMode };
    const fallback = { node: this.node, routeMode: this.routeMode };
    this.rollbackFailed = false;
    return this.restartKeepingPort({ node: this.node, routeMode }, fallback);
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
    removePid(this.pidFile);
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
      ctlPort: this.ctlPort,
      pid: this.proc ? this.proc.pid : 0,
      routeMode: this.routeMode,
      tunMode: !!this.tunMode,
      routeLabel: (ROUTE_MODES[this.routeMode] || ROUTE_MODES.global).label,
      node: this.node
        ? { id: this.node.id, name: this.node.name, type: this.node.type, server: this.node.server, port: this.node.port }
        : null,
      startedAt: this.startedAt,
      // 已运行时长（秒），未运行时为 0
      uptime: this.running && this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      // 最近一次出口探测结果：{ ok, ip, ms, at, error }
      lastProbe: this.lastProbe || null,
      // 分流规则是否已加载完（global 模式恒为 true）
      rulesReady: this.routeMode === 'global' ? true : this.rulesReady,
      degraded: !!this.degraded,
      error: this.lastError,
    };
  }

  /**
   * 内核存活自检：external-controller 能应答 + mixed 端口能连上。
   * 用于把「内核悄悄死了但注册表还指着它」这种状态识别出来。
   */
  async alive() {
    if (!this.running || !this.proc) return false;
    // 降级启动时控制器本来就不可用，只看代理端口，别误判成「内核死了」
    if (this.degraded) return tcpAlive(this.port, 900);
    const ctlOk = await httpGet(this.ctlPort, '/version', 900)
      .then((r) => r.status === 200)
      .catch(() => false);
    if (!ctlOk) return false;
    return tcpAlive(this.port, 900);
  }

  /** 带记忆的链路探测：结果存进 lastProbe，供状态面板展示 */
  async probeWithCache(opts = {}) {
    const r = await this.probe(opts).catch((e) => ({ ok: false, error: e.message }));
    this.lastProbe = {
      ok: !!r.ok,
      ip: r.ip || '',
      location: r.location || '',
      ms: r.ms || r.latency || 0,
      error: r.ok ? '' : r.error || '未知原因',
      at: Date.now(),
    };
    return this.lastProbe;
  }
}

module.exports = { Gateway, DEFAULT_PORT, pickPort, ROUTE_MODES, SELF_CHECK_RULES };
