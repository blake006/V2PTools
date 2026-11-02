/**
 * mihomo 配置生成（桌面 / 安卓共用）
 *
 * 设计要点：
 *  1. 一个 mihomo 进程同时承担两件事 ——
 *     · mixed-port 作为系统代理 / VPN 出口（走分流规则）
 *     · listeners 为**每个节点**各开一个独立端口，绑死到该节点（绕过规则）
 *     这样测速可以并发进行，不用反复切换 selector。
 *  2. 节点名必须唯一且不能带控制字符，否则 mihomo 会拒绝启动。
 *  3. 分流规则用 rule-providers 引用本地文件（相对 dataDir），运行时不需要联网。
 *
 * UMD：Node 下 require('js-yaml')，浏览器下用全局 jsyaml。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('js-yaml'));
  } else {
    root.V2PConfigGen = factory(root.jsyaml);
  }
})(typeof self !== 'undefined' ? self : this, function (yaml) {
  'use strict';

  var DEFAULT_MIXED_PORT = 7890;
  var DEFAULT_CTL_PORT = 9090;
  var DEFAULT_LISTENER_BASE = 20000;
  var MAX_LISTENERS = 200;

  var ROUTE_MODES = {
    global: { label: '全局代理', desc: '所有流量都走节点' },
    'bypass-cn': { label: '绕过大陆', desc: '国内域名/IP 直连，其余走节点' },
    'proxy-list': { label: '仅名单代理', desc: '只有名单内的站点走节点' }
  };

  var RULE_FILES = {
    'cn-domain': { file: 'cn-domain.yaml', behavior: 'domain' },
    'cn-cidr': { file: 'cn-cidr.yaml', behavior: 'ipcidr' },
    'gfw-domain': { file: 'gfw-domain.yaml', behavior: 'domain' }
  };

  /** 节点名清洗：去控制字符、压缩空白、限长，并保证唯一 */
  function uniqueName(base, used) {
    var name = String(base == null ? '' : base)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 60);
    if (!name) name = 'node';
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    for (var i = 2; i < 10000; i += 1) {
      var cand = name + ' #' + i;
      if (!used.has(cand)) {
        used.add(cand);
        return cand;
      }
    }
    var fallback = name + ' #' + Date.now();
    used.add(fallback);
    return fallback;
  }

  /** 把节点模型转成 mihomo 的 proxy 对象 */
  function toProxy(node, name) {
    var conf = Object.assign({}, node.conf || {});
    // 关键字段以节点模型为准，避免 conf 里的残留值覆盖
    delete conf.name;
    delete conf.type;
    delete conf.server;
    delete conf.port;

    var proxy = Object.assign({}, conf, {
      name: name,
      type: node.type,
      server: node.server,
      port: Number(node.port)
    });
    // 去掉 undefined，否则 YAML 里会出现空值字段
    Object.keys(proxy).forEach(function (k) {
      if (proxy[k] === undefined) delete proxy[k];
    });
    return proxy;
  }

  function buildRouting(routeMode) {
    var mode = ROUTE_MODES[routeMode] ? routeMode : 'global';
    if (mode === 'global') return { providers: null, rules: ['MATCH,PROXY'] };

    var need = mode === 'bypass-cn' ? ['cn-domain', 'cn-cidr'] : ['gfw-domain'];
    var providers = {};
    need.forEach(function (key) {
      var meta = RULE_FILES[key];
      providers[key] = {
        type: 'file',
        behavior: meta.behavior,
        format: 'yaml',
        path: './rules/' + meta.file
      };
    });
    var rules =
      mode === 'bypass-cn'
        ? ['RULE-SET,cn-domain,DIRECT', 'RULE-SET,cn-cidr,DIRECT', 'MATCH,PROXY']
        : ['RULE-SET,gfw-domain,PROXY', 'MATCH,DIRECT'];
    return { providers: providers, rules: rules };
  }

  /**
   * 生成完整配置
   * @param {object} opts
   * @param {Array} opts.nodes            节点数组（需含 type/server/port/conf）
   * @param {string} opts.routeMode       global | bypass-cn | proxy-list
   * @param {number} opts.mixedPort       系统代理 / VPN 出口端口
   * @param {number} opts.ctlPort         external-controller 端口
   * @param {number} opts.listenerBase    每节点测速端口起始值
   * @param {boolean} opts.enableTun      是否启用 TUN（VPN 模式）
   * @param {number} opts.tunFd           VpnService 提供的 TUN fd
   * @returns {{yaml: string, config: object, names: Array, listeners: Array}}
   */
  function buildMihomoConfig(opts) {
    opts = opts || {};
    var nodes = Array.isArray(opts.nodes) ? opts.nodes : [];
    if (!nodes.length) throw new Error('没有可用节点');

    var mixedPort = Number(opts.mixedPort) || DEFAULT_MIXED_PORT;
    var ctlPort = Number(opts.ctlPort) || DEFAULT_CTL_PORT;
    var listenerBase = Number(opts.listenerBase) || DEFAULT_LISTENER_BASE;
    var routeMode = ROUTE_MODES[opts.routeMode] ? opts.routeMode : 'global';

    var used = new Set();
    var proxies = [];
    var names = [];
    var listeners = [];

    // 所有节点都进代理池：否则「设为使用中」时第 201 个之后的节点在配置里根本不存在
    nodes.forEach(function (node) {
      var name = uniqueName(node.name || node.server, used);
      names.push(name);
      proxies.push(toProxy(node, name));
    });

    // 测速端口只给前 MAX_LISTENERS 个节点开，避免几千个 inbound 监听把内核内存吃光
    nodes.slice(0, MAX_LISTENERS).forEach(function (node, i) {
      listeners.push({
        name: 'probe-' + i,
        type: 'mixed',
        port: listenerBase + i,
        listen: '127.0.0.1',
        // proxy 字段让该监听器绕过规则，直接走指定节点 —— 测速专用
        proxy: names[i]
      });
    });

    var routing = buildRouting(routeMode);

    var config = {
      'mixed-port': mixedPort,
      'allow-lan': false,
      mode: 'rule',
      'log-level': 'warning',
      ipv6: false,
      'external-controller': '127.0.0.1:' + ctlPort,
      'unified-delay': true,
      'tcp-concurrent': true,
      'find-process-mode': 'off',
      'geodata-mode': false,
      'geo-auto-update': false,
      profile: { 'store-selected': false, 'store-fake-ip': false },
      dns: {
        enable: true,
        ipv6: false,
        'enhanced-mode': 'redir-host',
        'default-nameserver': ['223.5.5.5', '119.29.29.29'],
        nameserver: ['223.5.5.5', '119.29.29.29', '8.8.8.8']
      },
      proxies: proxies,
      'proxy-groups': [
        {
          name: 'PROXY',
          type: 'select',
          proxies: names.slice()
        }
      ],
      listeners: listeners,
      rules: routing.rules
    };

    if (routing.providers) config['rule-providers'] = routing.providers;

    // TUN：仅在拿到 VpnService 的 fd 时才启用
    if (opts.enableTun) {
      config.tun = {
        enable: true,
        stack: 'system',
        'auto-route': true,
        'auto-detect-interface': true,
        'dns-hijack': ['any:53'],
        'strict-route': false
      };
      if (opts.tunFd != null) config.tun.fd = Number(opts.tunFd);
    } else {
      config.tun = { enable: false };
    }

    var text = yaml.dump(config, { lineWidth: 4096, noRefs: true });
    return {
      yaml: text,
      config: config,
      names: names,
      listeners: listeners,
      routeMode: routeMode,
      routeLabel: ROUTE_MODES[routeMode].label
    };
  }

  /** 单节点测速端口 */
  function listenerPort(base, index) {
    return (Number(base) || DEFAULT_LISTENER_BASE) + index;
  }

  return {
    buildMihomoConfig: buildMihomoConfig,
    listenerPort: listenerPort,
    uniqueName: uniqueName,
    ROUTE_MODES: ROUTE_MODES,
    RULE_FILES: RULE_FILES,
    DEFAULT_MIXED_PORT: DEFAULT_MIXED_PORT,
    DEFAULT_CTL_PORT: DEFAULT_CTL_PORT,
    DEFAULT_LISTENER_BASE: DEFAULT_LISTENER_BASE,
    MAX_LISTENERS: MAX_LISTENERS
  };
});
