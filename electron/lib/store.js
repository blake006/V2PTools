'use strict';

const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(name) {
    return path.join(this.dir, name);
  }

  read(name, fallback) {
    try {
      const raw = fs.readFileSync(this.file(name), 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  write(name, data) {
    const target = this.file(name);
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, target);
    return true;
  }
}

const DEFAULT_SETTINGS = {
  concurrency: 8,
  latencyTimeout: 8000,
  speedTimeout: 20000,
  // 每个节点测速下载的大小（MB）。10MB × 上千节点会吃掉几十 GB 流量，5MB 足够反映带宽
  speedBytes: 5,
  speedSource: 'cloudflare',
  deepHealth: true,
  autoSyncOnStart: false,
  sidebarHidden: false,
  latencyUrls: [],
  ipUrls: [],
  plainType: 'socks5',
  theme: 'dark',
  // 系统代理
  systemProxyPort: 7890,
  systemProxyBypass: '',
  systemProxyWinhttp: false,
  routeMode: 'global',
  // 拉取订阅时用的代理（留空 = 自动：本机代理内核在跑就借用，否则直连）
  subProxy: '',
  // 上次是否开着系统代理：重启应用时据此自动恢复，不用每次再点一次「启动」
  proxyOn: false,
  lastNodeId: '',
  lastProxyMode: 'system',
  // 双站点服务的境外域名：强制走节点，避免被「国内域名直连」判成直连
  forceProxyDomains: ['minimax.io'],
  // 需要境外 DNS 的域名（否则会解析到境内边缘节点，服务端仍按国内网络处理）
  overseasDnsDomains: ['+.minimax.io'],
};

module.exports = { Store, DEFAULT_SETTINGS };
