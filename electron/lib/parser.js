'use strict';

/**
 * 代理节点解析器
 * 支持: vmess / vless / trojan / ss / ssr / hysteria / hysteria2 / tuic / anytls /
 *       socks5 / http(s) / wireguard / 纯 IP:端口 / Clash YAML / Base64 订阅 / JSON
 */

const yaml = require('js-yaml');

const TYPE_LABEL = {
  vmess: 'VMess',
  vless: 'VLESS',
  trojan: 'Trojan',
  ss: 'SS',
  ssr: 'SSR',
  hysteria: 'Hysteria',
  hysteria2: 'Hysteria2',
  tuic: 'TUIC',
  anytls: 'AnyTLS',
  socks5: 'SOCKS5',
  http: 'HTTP',
  wireguard: 'WireGuard',
  ssh: 'SSH',
};

/** UDP 系协议（无 TCP 握手延迟） */
const UDP_TYPES = new Set(['hysteria', 'hysteria2', 'tuic', 'wireguard']);

let seq = 0;
function newId() {
  seq = (seq + 1) % 100000;
  return 'p' + Date.now().toString(36) + seq.toString(36) + Math.random().toString(36).slice(2, 6);
}

function b64decode(input) {
  if (!input) return '';
  let s = String(input).trim().replace(/\s+/g, '');
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad === 2) s += '==';
  else if (pad === 3) s += '=';
  else if (pad === 1) s += '===';
  try {
    return Buffer.from(s, 'base64').toString('utf8');
  } catch (e) {
    return '';
  }
}

function looksBase64(str) {
  const s = String(str || '').trim().replace(/\s+/g, '');
  if (s.length < 16) return false;
  if (!/^[A-Za-z0-9+/\-_=]+$/.test(s)) return false;
  return true;
}

function safeDecodeURI(v) {
  if (v == null) return '';
  try {
    return decodeURIComponent(v);
  } catch (e) {
    return String(v);
  }
}

function parseQuery(str) {
  const out = {};
  if (!str) return out;
  const s = str.startsWith('?') ? str.slice(1) : str;
  for (const part of s.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = i === -1 ? part : part.slice(0, i);
    const v = i === -1 ? '' : part.slice(i + 1);
    out[safeDecodeURI(k).toLowerCase()] = safeDecodeURI(v);
  }
  return out;
}

function splitHash(link) {
  const i = link.indexOf('#');
  if (i === -1) return { body: link, name: '' };
  return { body: link.slice(0, i), name: safeDecodeURI(link.slice(i + 1)) };
}

function truthy(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function toInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

/** 把 v2ray 风格的 network 参数转成 mihomo 的字段 */
function applyTransport(conf, o) {
  const net = (o.network || 'tcp').toLowerCase();
  const host = o.host || '';
  const path = o.path || '';
  const sni = o.sni || '';
  const fp = o.fp || '';

  if (sni) conf.servername = sni;
  if (o.alpn) conf.alpn = String(o.alpn).split(',').map((s) => s.trim()).filter(Boolean);
  if (fp) conf['client-fingerprint'] = fp;
  if (o.allowInsecure) conf['skip-cert-verify'] = true;
  if (o.flow) conf.flow = o.flow;

  if (o.realityPublicKey) {
    conf['reality-opts'] = {
      'public-key': o.realityPublicKey,
      'short-id': o.realityShortId || '',
    };
  }

  switch (net) {
    case 'ws':
    case 'websocket': {
      conf.network = 'ws';
      const opts = { path: path || '/' };
      if (host) opts.headers = { Host: host };
      if (o.wsEarlyData) {
        opts['max-early-data'] = toInt(o.wsEarlyData, 2048);
        opts['early-data-header-name'] = 'Sec-WebSocket-Protocol';
      }
      conf['ws-opts'] = opts;
      break;
    }
    case 'grpc': {
      conf.network = 'grpc';
      conf['grpc-opts'] = { 'grpc-service-name': o.serviceName || path || '' };
      break;
    }
    case 'h2':
    case 'http2': {
      conf.network = 'h2';
      conf['h2-opts'] = { path: path || '/', host: host ? [host] : [] };
      break;
    }
    case 'http': {
      conf.network = 'http';
      conf['http-opts'] = {
        method: 'GET',
        path: [path || '/'],
        headers: host ? { Host: [host] } : {},
      };
      break;
    }
    case 'quic': {
      conf.network = 'quic';
      break;
    }
    default:
      conf.network = 'tcp';
      break;
  }
  return conf;
}

function buildNode(partial) {
  return {
    id: newId(),
    name: partial.name || '',
    type: partial.type,
    server: partial.server,
    port: partial.port,
    conf: partial.conf || {},
    raw: partial.raw || '',
    group: partial.group || '',
    source: partial.source || '',
    enabled: true,
    remark: '',
    // 测试结果
    tcp: null,
    latency: null,
    jitter: null,
    speed: null,
    ip: '',
    country: '',
    countryCode: '',
    region: '',
    city: '',
    isp: '',
    asn: '',
    ipType: '',
    proxyFlag: null,
    hostingFlag: null,
    mobileFlag: null,
    dnsbl: null,
    health: null,
    status: 'idle',
    error: '',
    testedAt: null,
  };
}

/* ------------------------------------------------------------------ */
/* 各协议解析                                                          */
/* ------------------------------------------------------------------ */

function parseVmess(link) {
  const { body, name } = splitHash(link);
  const payload = b64decode(body.slice('vmess://'.length));
  if (!payload) throw new Error('vmess 内容不是合法 Base64');
  let j;
  try {
    j = JSON.parse(payload);
  } catch (e) {
    throw new Error('vmess 内容不是合法 JSON');
  }
  const server = (j.add || '').trim();
  const port = toInt(j.port, 0);
  if (!server || !port) throw new Error('vmess 缺少服务器或端口');

  const conf = {
    uuid: j.id,
    alterId: toInt(j.aid, 0),
    cipher: j.scy || 'auto',
    udp: true,
  };
  if (truthy(j.tls) || String(j.tls || '').toLowerCase() === 'tls' || j.tls === true) {
    conf.tls = true;
  }
  applyTransport(conf, {
    network: j.net,
    host: j.host,
    path: j.path,
    sni: j.sni || j.host,
    fp: j.fp,
    alpn: j.alpn,
    flow: j.flow,
    serviceName: j.path,
    allowInsecure: truthy(j.allowInsecure) || truthy(j.verify_cert === false),
  });
  if (!conf.tls && conf['reality-opts']) conf.tls = true;

  return buildNode({
    name: j.ps || name,
    type: 'vmess',
    server,
    port,
    conf,
    raw: link,
  });
}

function parseVless(link) {
  const { body, name } = splitHash(link);
  const u = new URL(body.replace(/^vless:\/\//i, 'http://'));
  const uuid = safeDecodeURI(u.username);
  const server = u.hostname;
  const port = toInt(u.port, 443);
  if (!uuid || !server) throw new Error('vless 缺少 uuid 或服务器');
  const q = parseQuery(u.search);

  const conf = { uuid, udp: true };
  const security = (q.security || 'none').toLowerCase();
  if (security === 'tls' || security === 'reality' || security === 'xtls') conf.tls = true;
  applyTransport(conf, {
    network: q.type || 'tcp',
    host: q.host,
    path: q.path,
    sni: q.sni || q.host,
    fp: q.fp,
    alpn: q.alpn,
    flow: q.flow,
    serviceName: q.servicename || q.serviceName,
    allowInsecure: truthy(q.allowinsecure) || truthy(q.insecure),
    realityPublicKey: q.pbk,
    realityShortId: q.sid,
  });
  if (q.headerType && (q.type || 'tcp') === 'tcp') {
    // tcp + http 伪装
    if (q.headerType === 'http') {
      conf.network = 'http';
      conf['http-opts'] = {
        method: 'GET',
        path: [q.path || '/'],
        headers: q.host ? { Host: [q.host] } : {},
      };
    }
  }

  return buildNode({ name: name || '', type: 'vless', server, port, conf, raw: link });
}

function parseTrojan(link) {
  const { body, name } = splitHash(link);
  const u = new URL(body.replace(/^trojan:\/\//i, 'http://'));
  const password = safeDecodeURI(u.username || u.password || '');
  const server = u.hostname;
  const port = toInt(u.port, 443);
  if (!password || !server) throw new Error('trojan 缺少密码或服务器');
  const q = parseQuery(u.search);

  const conf = { password, udp: true };
  applyTransport(conf, {
    network: q.type || 'tcp',
    host: q.host,
    path: q.path,
    sni: q.sni || q.peer || q.host,
    fp: q.fp,
    alpn: q.alpn,
    serviceName: q.servicename,
    allowInsecure: truthy(q.allowinsecure) || truthy(q.insecure),
  });
  if (conf.servername) conf.sni = conf.servername;
  if (conf['skip-cert-verify']) conf['skip-cert-verify'] = true;
  if (q.type && q.type !== 'tcp' && q.type !== 'original') conf.network = q.type;

  return buildNode({ name: name || '', type: 'trojan', server, port, conf, raw: link });
}

function ssPluginConf(pluginStr) {
  if (!pluginStr) return null;
  const parts = pluginStr.split(';').map((s) => s.trim()).filter(Boolean);
  const pname = parts.shift() || '';
  const opts = {};
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i === -1) opts[p] = true;
    else opts[p.slice(0, i)] = p.slice(i + 1);
  }
  if (/obfs/.test(pname)) {
    return {
      plugin: 'obfs',
      'plugin-opts': { mode: opts.obfs || 'http', host: opts['obfs-host'] || '' },
    };
  }
  if (/v2ray/.test(pname)) {
    const out = {
      mode: opts.mode || 'websocket',
      host: opts.host || '',
      path: opts.path || '/',
    };
    if (truthy(opts.tls)) out.tls = true;
    return { plugin: 'v2ray-plugin', 'plugin-opts': out };
  }
  if (/shadow-tls/.test(pname)) {
    return { plugin: 'shadow-tls', 'plugin-opts': { host: opts.host, password: opts.password, version: toInt(opts.version, 3) } };
  }
  return null;
}

function parseSs(link) {
  const { body, name } = splitHash(link);
  let rest = body.slice('ss://'.length);
  let query = '';
  const qi = rest.indexOf('?');
  if (qi !== -1) {
    query = rest.slice(qi + 1);
    rest = rest.slice(0, qi);
  }

  let method = '';
  let password = '';
  let server = '';
  let port = 0;

  if (rest.includes('@')) {
    // SIP002
    const at = rest.lastIndexOf('@');
    let userinfo = rest.slice(0, at);
    const hostpart = rest.slice(at + 1);
    if (!userinfo.includes(':')) userinfo = b64decode(userinfo);
    const ci = userinfo.indexOf(':');
    method = userinfo.slice(0, ci);
    password = userinfo.slice(ci + 1);
    const hp = hostpart.split('/')[0];
    const hi = hp.lastIndexOf(':');
    server = hp.slice(0, hi).replace(/^\[|\]$/g, '');
    port = toInt(hp.slice(hi + 1), 0);
  } else {
    // 旧版整体 base64
    const decoded = b64decode(rest);
    if (!decoded) throw new Error('ss 内容无法解码');
    const at = decoded.lastIndexOf('@');
    if (at === -1) throw new Error('ss 格式无法识别');
    const userinfo = decoded.slice(0, at);
    const hostpart = decoded.slice(at + 1).split('/')[0];
    const ci = userinfo.indexOf(':');
    method = userinfo.slice(0, ci);
    password = userinfo.slice(ci + 1);
    const hi = hostpart.lastIndexOf(':');
    server = hostpart.slice(0, hi);
    port = toInt(hostpart.slice(hi + 1), 0);
  }

  if (!server || !port || !method) throw new Error('ss 缺少必要字段');
  const q = parseQuery(query);
  const conf = { cipher: method, password, udp: true };
  const plugin = ssPluginConf(q.plugin);
  if (plugin) Object.assign(conf, plugin);

  return buildNode({ name: name || '', type: 'ss', server, port, conf, raw: link });
}

function parseSsr(link) {
  const { body, name } = splitHash(link);
  const decoded = b64decode(body.slice('ssr://'.length));
  if (!decoded) throw new Error('ssr 内容无法解码');
  const main = decoded.split('/?')[0];
  const paramStr = decoded.includes('/?') ? decoded.split('/?')[1] : '';
  const seg = main.split(':');
  if (seg.length < 6) throw new Error('ssr 字段数量不足');
  const server = seg[0];
  const port = toInt(seg[1], 0);
  const protocol = seg[2];
  const cipher = seg[3];
  const obfs = seg[4];
  const password = b64decode(seg.slice(5).join(':'));
  if (!server || !port) throw new Error('ssr 缺少服务器或端口');

  const q = {};
  for (const p of paramStr.split('&')) {
    if (!p) continue;
    const i = p.indexOf('=');
    const k = i === -1 ? p : p.slice(0, i);
    const v = i === -1 ? '' : p.slice(i + 1);
    q[k] = b64decode(v);
  }

  const conf = {
    cipher,
    password,
    protocol: protocol === 'origin' ? 'origin' : protocol,
    obfs,
    udp: true,
  };
  if (q.protoparam) conf['protocol-param'] = q.protoparam;
  if (q.obfsparam) conf['obfs-param'] = q.obfsparam;

  return buildNode({ name: name || q.remarks || '', type: 'ssr', server, port, conf, raw: link });
}

function parseHysteria2(link) {
  const { body, name } = splitHash(link);
  const u = new URL(body.replace(/^(hysteria2|hy2):\/\//i, 'http://'));
  const server = u.hostname;
  const port = toInt(u.port, 443);
  const auth = safeDecodeURI(u.username || '') + (u.password ? ':' + safeDecodeURI(u.password) : '');
  if (!server) throw new Error('hysteria2 缺少服务器');
  const q = parseQuery(u.search);
  const conf = { password: auth, udp: true };
  if (q.sni) conf.sni = q.sni;
  if (q.insecure) conf['skip-cert-verify'] = truthy(q.insecure);
  if (q.obfs) {
    conf.obfs = q.obfs;
    conf['obfs-password'] = q['obfs-password'] || q.obfspassword || '';
  }
  if (q.pinsha256) conf.fingerprint = q.pinsha256;
  if (q.mport || q.ports) conf.ports = q.mport || q.ports;
  return buildNode({ name: name || '', type: 'hysteria2', server, port, conf, raw: link });
}

function parseHysteria(link) {
  const { body, name } = splitHash(link);
  const u = new URL(body.replace(/^hysteria:\/\//i, 'http://'));
  const server = u.hostname;
  const port = toInt(u.port, 443);
  if (!server) throw new Error('hysteria 缺少服务器');
  const q = parseQuery(u.search);
  const conf = {
    'auth-str': q.auth || safeDecodeURI(u.username || ''),
    protocol: q.protocol || 'udp',
    up: q.upmbps ? `${q.upmbps} Mbps` : q.up || '50 Mbps',
    down: q.downmbps ? `${q.downmbps} Mbps` : q.down || '100 Mbps',
    sni: q.peer || q.sni || server,
    'skip-cert-verify': truthy(q.insecure),
  };
  if (q.obfsparam) conf.obfs = q.obfsparam;
  return buildNode({ name: name || '', type: 'hysteria', server, port, conf, raw: link });
}

function parseTuic(link) {
  const { body, name } = splitHash(link);
  const u = new URL(body.replace(/^tuic:\/\//i, 'http://'));
  const server = u.hostname;
  const port = toInt(u.port, 443);
  if (!server) throw new Error('tuic 缺少服务器');
  const q = parseQuery(u.search);
  const conf = {
    uuid: safeDecodeURI(u.username || ''),
    password: safeDecodeURI(u.password || ''),
    udp: true,
    'congestion-controller': q.congestion_control || q.congestion || 'bbr',
    'udp-relay-mode': q.udp_relay_mode || 'native',
    'reduce-rtt': truthy(q.reduce_rtt),
    sni: q.sni || server,
    alpn: (q.alpn || 'h3').split(','),
    'skip-cert-verify': truthy(q.allow_insecure) || truthy(q.insecure),
  };
  if (q.disable_sni) conf['disable-sni'] = true;
  return buildNode({ name: name || '', type: 'tuic', server, port, conf, raw: link });
}

function parseAnytls(link) {
  const { body, name } = splitHash(link);
  const u = new URL(body.replace(/^anytls:\/\//i, 'http://'));
  const server = u.hostname;
  const port = toInt(u.port, 443);
  if (!server) throw new Error('anytls 缺少服务器');
  const q = parseQuery(u.search);
  const conf = {
    password: safeDecodeURI(u.username || ''),
    udp: true,
  };
  if (q.sni) conf.sni = q.sni;
  if (q.insecure) conf['skip-cert-verify'] = truthy(q.insecure);
  if (q.fp) conf['client-fingerprint'] = q.fp;
  return buildNode({ name: name || '', type: 'anytls', server, port, conf, raw: link });
}

function parseSocks(link, type) {
  const { body, name } = splitHash(link);
  const u = new URL(body.replace(/^socks(4|5|5h)?:\/\//i, 'http://'));
  const server = u.hostname;
  const port = toInt(u.port, 1080);
  if (!server) throw new Error('socks 缺少服务器');
  const conf = { udp: true };
  if (u.username) {
    conf.username = safeDecodeURI(u.username);
    conf.password = safeDecodeURI(u.password || '');
  }
  return buildNode({ name: name || '', type: type || 'socks5', server, port, conf, raw: link });
}

function parseHttpProxy(link) {
  const { body, name } = splitHash(link);
  const isTls = /^https:\/\//i.test(body);
  const u = new URL(body);
  const server = u.hostname;
  const port = toInt(u.port, isTls ? 443 : 8080);
  if (!server) throw new Error('http 代理缺少服务器');
  const conf = {};
  if (u.username) {
    conf.username = safeDecodeURI(u.username);
    conf.password = safeDecodeURI(u.password || '');
  }
  if (isTls) conf.tls = true;
  return buildNode({ name: name || '', type: 'http', server, port, conf, raw: link });
}

/** 纯文本: host:port / host:port:user:pass / user:pass@host:port */
function parsePlain(text, defaultType) {
  const t = text.trim();
  let server = '';
  let port = 0;
  const conf = {};

  if (t.includes('@')) {
    const at = t.lastIndexOf('@');
    const cred = t.slice(0, at);
    const hp = t.slice(at + 1);
    const hi = hp.lastIndexOf(':');
    server = hp.slice(0, hi);
    port = toInt(hp.slice(hi + 1), 0);
    const ci = cred.indexOf(':');
    if (ci !== -1) {
      conf.username = cred.slice(0, ci);
      conf.password = cred.slice(ci + 1);
    }
  } else {
    const seg = t.split(':');
    server = seg[0];
    port = toInt(seg[1], 0);
    if (seg.length >= 4) {
      conf.username = seg[2];
      conf.password = seg[3];
    }
  }
  server = (server || '').trim();
  if (!server || !port) throw new Error('无法识别的代理地址');
  if (defaultType === 'socks5') conf.udp = true;
  return buildNode({ name: '', type: defaultType, server, port, conf, raw: text });
}

/* ------------------------------------------------------------------ */
/* Clash YAML                                                          */
/* ------------------------------------------------------------------ */

const CLASH_TYPE_MAP = {
  ss: 'ss',
  ssr: 'ssr',
  vmess: 'vmess',
  vless: 'vless',
  trojan: 'trojan',
  hysteria: 'hysteria',
  hysteria2: 'hysteria2',
  hy2: 'hysteria2',
  tuic: 'tuic',
  anytls: 'anytls',
  socks5: 'socks5',
  http: 'http',
  wireguard: 'wireguard',
  ssh: 'ssh',
};

function clashProxyToNode(p) {
  const type = CLASH_TYPE_MAP[String(p.type || '').toLowerCase()];
  if (!type) return null;
  const conf = {};
  for (const [k, v] of Object.entries(p)) {
    if (['name', 'type', 'server', 'port'].includes(k)) continue;
    conf[k] = v;
  }
  return buildNode({
    name: p.name || '',
    type,
    server: p.server,
    port: toInt(p.port, 0),
    conf,
    raw: JSON.stringify(p),
  });
}

function parseClashYaml(text, group) {
  let doc;
  try {
    doc = yaml.load(text);
  } catch (e) {
    throw new Error('Clash 配置 YAML 解析失败: ' + e.message);
  }
  const list = doc && (doc.proxies || doc.Proxy || doc.proxy);
  if (!Array.isArray(list)) throw new Error('未找到 proxies 节点列表');
  const nodes = [];
  for (const p of list) {
    try {
      const n = clashProxyToNode(p);
      if (n && n.server && n.port) {
        n.group = group || '';
        nodes.push(n);
      }
    } catch (e) {
      /* 跳过单条异常 */
    }
  }
  return nodes;
}

function parseClashJson(text, group) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return null;
  }
  const list = doc && (doc.proxies || doc.nodes || (Array.isArray(doc) ? doc : null));
  if (!Array.isArray(list)) return null;
  const nodes = [];
  for (const p of list) {
    try {
      if (p.type && p.server) {
        const n = clashProxyToNode(p);
        if (n && n.server && n.port) {
          n.group = group || '';
          nodes.push(n);
        }
      }
    } catch (e) {}
  }
  return nodes.length ? nodes : null;
}

/* ------------------------------------------------------------------ */
/* Surge / Loon / Shadowrocket 文本格式                                */
/* ------------------------------------------------------------------ */

function kvParse(parts) {
  const kv = {};
  const positional = [];
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i > 0) kv[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim();
    else if (p) positional.push(p);
  }
  return { kv, positional };
}

function surgeLineToNode(line) {
  const m = /^([^=]+?)\s*=\s*([a-zA-Z0-9_-]+)\s*,\s*(.+)$/.exec(line);
  if (!m) return null;
  const name = m[1].trim();
  const type = m[2].toLowerCase();
  const parts = m[3].split(',').map((s) => s.trim());
  const server = parts[0];
  const port = toInt(parts[1], 0);
  if (!server || !port) return null;
  const { kv, positional } = kvParse(parts.slice(2));

  const tlsOn = truthy(kv.tls) || truthy(kv['over-tls']);
  const sni = kv.sni || kv['tls-host'] || kv.peer || '';

  switch (type) {
    case 'ss':
    case 'shadowsocks': {
      const conf = {
        cipher: kv['encrypt-method'] || kv.method || 'aes-128-gcm',
        password: kv.password || '',
        udp: truthy(kv['udp-relay']) || kv['udp-relay'] === undefined,
      };
      if (kv.obfs) {
        conf.plugin = 'obfs';
        conf['plugin-opts'] = { mode: kv.obfs, host: kv['obfs-host'] || '' };
      }
      return buildNode({ name, type: 'ss', server, port, conf });
    }
    case 'vmess': {
      const conf = {
        uuid: kv.username || kv.uuid || '',
        alterId: toInt(kv.alterid || kv.aid, 0),
        cipher: kv['encrypt-method'] || 'auto',
        udp: true,
      };
      if (tlsOn) conf.tls = true;
      const ws = truthy(kv.ws);
      const net = ws ? 'ws' : 'tcp';
      let host = kv['ws-headers'] ? (/(?:Host|host):\s*([^|,]+)/.exec(kv['ws-headers']) || [])[1] : '';
      host = (host || kv['obfs-host'] || '').trim();
      applyTransport(conf, {
        network: net,
        host,
        path: kv['ws-path'] || kv['obfs-uri'] || '/',
        sni: sni || host,
        allowInsecure: truthy(kv['skip-cert-verify']),
      });
      return buildNode({ name, type: 'vmess', server, port, conf });
    }
    case 'vless': {
      const conf = { uuid: kv.username || kv.uuid || '', udp: true };
      if (tlsOn) conf.tls = true;
      applyTransport(conf, {
        network: truthy(kv.ws) ? 'ws' : 'tcp',
        host: kv['ws-headers'] ? (/(?:Host|host):\s*([^|,]+)/.exec(kv['ws-headers']) || [])[1] : '',
        path: kv['ws-path'] || '/',
        sni,
        flow: kv.flow,
        allowInsecure: truthy(kv['skip-cert-verify']),
      });
      return buildNode({ name, type: 'vless', server, port, conf });
    }
    case 'trojan': {
      const conf = { password: kv.password || '', udp: true };
      applyTransport(conf, {
        network: truthy(kv.ws) ? 'ws' : 'tcp',
        host: kv['ws-headers'] ? (/(?:Host|host):\s*([^|,]+)/.exec(kv['ws-headers']) || [])[1] : '',
        path: kv['ws-path'] || '/',
        sni: sni || server,
        allowInsecure: truthy(kv['skip-cert-verify']),
      });
      conf.sni = conf.servername || sni || server;
      return buildNode({ name, type: 'trojan', server, port, conf });
    }
    case 'hysteria2':
    case 'hy2': {
      const conf = { password: kv.password || kv.auth || '', udp: true };
      if (sni) conf.sni = sni;
      if (truthy(kv['skip-cert-verify'])) conf['skip-cert-verify'] = true;
      if (kv.obfs) {
        conf.obfs = kv.obfs;
        conf['obfs-password'] = kv['obfs-password'] || '';
      }
      return buildNode({ name, type: 'hysteria2', server, port, conf });
    }
    case 'socks5':
    case 'socks': {
      const conf = { udp: true };
      const user = kv.username || positional[0];
      const pass = kv.password || positional[1];
      if (user) conf.username = user;
      if (pass) conf.password = pass;
      return buildNode({ name, type: 'socks5', server, port, conf });
    }
    case 'http':
    case 'https': {
      const conf = {};
      const user = kv.username || positional[0];
      const pass = kv.password || positional[1];
      if (user) conf.username = user;
      if (pass) conf.password = pass;
      if (tlsOn || type === 'https') conf.tls = true;
      return buildNode({ name, type: 'http', server, port, conf });
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Quantumult X 格式                                                   */
/* ------------------------------------------------------------------ */

function qxLineToNode(line) {
  const m = /^(shadowsocks|vmess|vless|trojan|hysteria2|socks5|http)\s*=\s*([^,]+)(?:,\s*(.*))?$/i.exec(line);
  if (!m) return null;
  const type = m[1].toLowerCase();
  const hostport = m[2].trim();
  const hi = hostport.lastIndexOf(':');
  const server = hostport.slice(0, hi).replace(/^\[|\]$/g, '');
  const port = toInt(hostport.slice(hi + 1), 0);
  if (!server || !port) return null;
  const { kv } = kvParse((m[3] || '').split(',').map((s) => s.trim()));
  const name = kv.tag || '';

  switch (type) {
    case 'shadowsocks': {
      const conf = { cipher: kv.method || 'aes-128-gcm', password: kv.password || '', udp: true };
      if (kv.obfs) {
        conf.plugin = 'obfs';
        conf['plugin-opts'] = { mode: kv.obfs, host: kv['obfs-host'] || '' };
      }
      return buildNode({ name, type: 'ss', server, port, conf });
    }
    case 'vmess': {
      const obfs = (kv.obfs || '').toLowerCase();
      const conf = {
        uuid: kv.password || kv.uuid || '',
        alterId: toInt(kv.aid, 0),
        cipher: kv.method || 'auto',
        udp: true,
      };
      const isTls = obfs === 'wss' || obfs === 'over-tls' || truthy(kv['tls-verification']) === false;
      if (isTls) conf.tls = true;
      if (obfs.startsWith('ws')) {
        applyTransport(conf, {
          network: 'ws',
          host: kv['obfs-host'],
          path: kv['obfs-uri'] || '/',
          sni: kv['obfs-host'],
          allowInsecure: kv['tls-verification'] === 'false',
        });
      } else {
        applyTransport(conf, { network: 'tcp', sni: kv['obfs-host'] });
      }
      return buildNode({ name, type: 'vmess', server, port, conf });
    }
    case 'vless': {
      const conf = { uuid: kv.password || kv.uuid || '', udp: true };
      applyTransport(conf, {
        network: (kv.obfs || '').startsWith('ws') ? 'ws' : 'tcp',
        host: kv['obfs-host'],
        path: kv['obfs-uri'] || '/',
        sni: kv['obfs-host'],
      });
      if ((kv.obfs || '').includes('tls')) conf.tls = true;
      return buildNode({ name, type: 'vless', server, port, conf });
    }
    case 'trojan': {
      const conf = { password: kv.password || '', udp: true, sni: kv['tls-host'] || server };
      if (kv['tls-verification'] === 'false') conf['skip-cert-verify'] = true;
      return buildNode({ name, type: 'trojan', server, port, conf });
    }
    case 'hysteria2': {
      const conf = { password: kv.password || kv.auth || '', udp: true };
      if (kv.obfs) {
        conf.obfs = kv.obfs;
        conf['obfs-password'] = kv['obfs-password'] || '';
      }
      if (kv['tls-host'] || kv.sni) conf.sni = kv['tls-host'] || kv.sni;
      if (kv['tls-verification'] === 'false') conf['skip-cert-verify'] = true;
      return buildNode({ name, type: 'hysteria2', server, port, conf });
    }
    case 'socks5':
      return buildNode({
        name,
        type: 'socks5',
        server,
        port,
        conf: { username: kv.username, password: kv.password, udp: true },
      });
    case 'http':
      return buildNode({
        name,
        type: 'http',
        server,
        port,
        conf: { username: kv.username, password: kv.password },
      });
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* sing-box / SIP008 JSON                                              */
/* ------------------------------------------------------------------ */

function singboxTls(conf, tls) {
  if (!tls || !tls.enabled) return;
  conf.tls = true;
  if (tls.server_name) conf.servername = tls.server_name;
  if (tls.insecure) conf['skip-cert-verify'] = true;
  if (Array.isArray(tls.alpn) && tls.alpn.length) conf.alpn = tls.alpn;
  if (tls.utls && tls.utls.fingerprint) conf['client-fingerprint'] = tls.utls.fingerprint;
  if (tls.reality && tls.reality.enabled) {
    conf['reality-opts'] = {
      'public-key': tls.reality.public_key,
      'short-id': tls.reality.short_id || '',
    };
  }
}

function singboxTransport(conf, tr) {
  if (!tr || !tr.type) return;
  if (tr.type === 'ws') {
    conf.network = 'ws';
    const opts = { path: tr.path || '/' };
    const host = tr.headers && (tr.headers.Host || tr.headers.host);
    if (host) opts.headers = { Host: Array.isArray(host) ? host[0] : host };
    conf['ws-opts'] = opts;
  } else if (tr.type === 'grpc') {
    conf.network = 'grpc';
    conf['grpc-opts'] = { 'grpc-service-name': tr.service_name || '' };
  } else if (tr.type === 'http') {
    conf.network = 'h2';
    conf['h2-opts'] = { path: tr.path || '/', host: tr.host || [] };
  }
}

function singboxOutboundToNode(o) {
  if (!o || !o.type) return null;
  const server = o.server;
  const port = toInt(o.server_port || o.port, 0);
  if (!server || !port) return null;
  const name = o.tag || '';
  let conf = null;
  let type = o.type;

  switch (o.type) {
    case 'shadowsocks':
      conf = { cipher: o.method, password: o.password, udp: true };
      type = 'ss';
      break;
    case 'vmess':
      conf = { uuid: o.uuid, alterId: toInt(o.alter_id, 0), cipher: o.security || 'auto', udp: true };
      singboxTls(conf, o.tls);
      singboxTransport(conf, o.transport);
      break;
    case 'vless':
      conf = { uuid: o.uuid, udp: true };
      if (o.flow) conf.flow = o.flow;
      singboxTls(conf, o.tls);
      singboxTransport(conf, o.transport);
      break;
    case 'trojan':
      conf = { password: o.password, udp: true };
      singboxTls(conf, o.tls);
      singboxTransport(conf, o.transport);
      if (conf.servername) conf.sni = conf.servername;
      break;
    case 'hysteria2':
      conf = { password: o.password, udp: true };
      if (o.obfs && o.obfs.type) {
        conf.obfs = o.obfs.type;
        conf['obfs-password'] = o.obfs.password || '';
      }
      singboxTls(conf, o.tls);
      if (conf.servername) conf.sni = conf.servername;
      break;
    case 'tuic':
      conf = {
        uuid: o.uuid,
        password: o.password,
        udp: true,
        'congestion-controller': o.congestion_control || 'bbr',
        'udp-relay-mode': o.udp_relay_mode || 'native',
      };
      singboxTls(conf, o.tls);
      if (conf.servername) conf.sni = conf.servername;
      break;
    case 'anytls':
      conf = { password: o.password, udp: true };
      singboxTls(conf, o.tls);
      if (conf.servername) conf.sni = conf.servername;
      break;
    case 'socks':
      conf = { username: o.username, password: o.password, udp: true };
      type = 'socks5';
      break;
    case 'http':
      conf = { username: o.username, password: o.password };
      if (o.tls && o.tls.enabled) conf.tls = true;
      break;
    default:
      return null;
  }
  if (!conf) return null;
  return buildNode({ name, type, server, port, conf });
}

function parseSingboxJson(doc, group) {
  const list = doc.outbounds || doc.nodes;
  if (!Array.isArray(list)) return null;
  const nodes = [];
  for (const o of list) {
    try {
      const n = singboxOutboundToNode(o);
      if (n) {
        n.group = group || '';
        nodes.push(n);
      }
    } catch (e) {}
  }
  return nodes.length ? nodes : null;
}

/** SIP008 (Shadowsocks 官方订阅) */
function parseSip008(doc, group) {
  const list = doc.servers;
  if (!Array.isArray(list)) return null;
  const nodes = [];
  for (const s of list) {
    if (!s.server || !s.server_port) continue;
    const conf = { cipher: s.method, password: s.password, udp: true };
    if (s.plugin) {
      const pl = ssPluginConf(`${s.plugin}${s.plugin_opts ? ';' + s.plugin_opts : ''}`);
      if (pl) Object.assign(conf, pl);
    }
    const n = buildNode({
      name: s.remarks || s.name || '',
      type: 'ss',
      server: s.server,
      port: toInt(s.server_port, 0),
      conf,
    });
    n.group = group || '';
    nodes.push(n);
  }
  return nodes.length ? nodes : null;
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

const PROTOCOLS = [
  ['vmess://', parseVmess],
  ['vless://', parseVless],
  ['trojan://', parseTrojan],
  ['ssr://', parseSsr],
  ['ss://', parseSs],
  ['hysteria2://', parseHysteria2],
  ['hy2://', parseHysteria2],
  ['hysteria://', parseHysteria],
  ['tuic://', parseTuic],
  ['anytls://', parseAnytls],
  ['socks5://', (l) => parseSocks(l, 'socks5')],
  ['socks://', (l) => parseSocks(l, 'socks5')],
  ['socks4://', (l) => parseSocks(l, 'socks5')],
  ['http://', parseHttpProxy],
  ['https://', parseHttpProxy],
];

function parseLine(line, opts) {
  const s = String(line || '').trim();
  if (!s || s.startsWith('#') || s.startsWith('//')) return null;
  const lower = s.toLowerCase();
  for (const [prefix, fn] of PROTOCOLS) {
    if (lower.startsWith(prefix)) {
      // http(s):// 默认当订阅链接，除非明确是代理地址
      if (prefix === 'http://' || prefix === 'https://') {
        if (!opts.allowHttpProxy) {
          const u = s.split('#')[0];
          const hasCred = /^https?:\/\/[^/@]+@/i.test(u);
          const afterHost = u.replace(/^https?:\/\//i, '').split('/')[1];
          if (!hasCred && afterHost !== undefined) return null;
        }
      }
      const node = fn(s);
      if (opts.group) node.group = opts.group;
      node.source = opts.source || '';
      if (!node.name) node.name = `${node.server}:${node.port}`;
      return node;
    }
  }
  // 纯 IP:端口
  if (/^[\w.\-\[\]:]+:\d{1,5}(:[^:]+:[^:]+)?$/.test(s) || /^[^@\s]+@[\w.\-]+:\d{1,5}$/.test(s)) {
    const node = parsePlain(s, opts.plainType || 'socks5');
    if (opts.group) node.group = opts.group;
    node.source = opts.source || '';
    node.name = node.name || `${node.server}:${node.port}`;
    return node;
  }
  return null;
}

/**
 * 解析一段任意文本（多行链接 / Base64 / Clash YAML / sing-box JSON / Surge / QX）
 * @returns {{nodes: Array, errors: Array<{line:string, error:string}>, format: string}}
 */
function parseText(text, opts = {}, depth = 0) {
  const nodes = [];
  const errors = [];
  let content = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!content) return { nodes, errors, format: 'empty' };

  const group = opts.group || '';
  const done = (fmt) => ({ nodes, errors, format: fmt });
  // 统一打上来源/分组标记（Clash / JSON 分支不走逐行解析，需要单独补）
  const tagAll = (arr) => {
    for (const n of arr) {
      if (opts.source && !n.source) n.source = opts.source;
      if (group && !n.group) n.group = group;
    }
    return arr;
  };

  /* ---------- 1. JSON ---------- */
  if (/^[\[{]/.test(content)) {
    try {
      const doc = JSON.parse(content);
      const sb = parseSingboxJson(doc, group);
      if (sb) return { nodes: tagAll(sb), errors, format: 'sing-box JSON' };
      const sip = parseSip008(doc, group);
      if (sip) return { nodes: tagAll(sip), errors, format: 'SIP008 JSON' };
      const clash = parseClashJson(content, group);
      if (clash) return { nodes: tagAll(clash), errors, format: 'Clash JSON' };
      if (Array.isArray(doc)) {
        const arr = [];
        for (const item of doc) {
          if (item && item.type && item.server) {
            const n = clashProxyToNode(item) || singboxOutboundToNode(item);
            if (n) arr.push(n);
          }
        }
        if (arr.length) return { nodes: tagAll(arr), errors, format: 'JSON 数组' };
      }
    } catch (e) {
      /* 继续尝试其它格式 */
    }
  }

  /* ---------- 2. Clash / Clash.Meta YAML ---------- */
  const looksClash = /^\s*(proxies|proxy-providers|proxy-groups)\s*:/m.test(content)
    || /^\s*(mixed-port|socks-port|redir-port|tproxy-port)\s*:/m.test(content);
  if (looksClash) {
    try {
      const doc = yaml.load(content);
      if (doc && typeof doc === 'object') {
        if (Array.isArray(doc.proxies) && doc.proxies.length) {
          return { nodes: tagAll(parseClashYaml(content, group)), errors, format: 'Clash YAML' };
        }
        if (doc['proxy-providers'] && typeof doc['proxy-providers'] === 'object') {
          const providers = Object.keys(doc['proxy-providers']);
          errors.push({
            line: 'proxy-providers',
            error: `该 Clash 配置仅包含 ${providers.length} 个远程 provider（${providers.join(', ')}），请直接使用 provider 的订阅链接导入`,
          });
          return done('clash-provider');
        }
      }
    } catch (e) {
      errors.push({ line: 'YAML', error: e.message });
    }
  }

  /* ---------- 3. Base64 订阅（可能多层） ---------- */
  if (!/:\/\//.test(content) && looksBase64(content) && depth < 2) {
    const decoded = b64decode(content);
    if (decoded && (decoded.includes('://') || decoded.includes('=') || decoded.includes(':'))) {
      const r = parseText(decoded, opts, depth + 1);
      if (r.nodes.length) return { nodes: r.nodes, errors: r.errors.concat(errors), format: 'Base64 订阅' };
    }
  }

  /* ---------- 4. 逐行解析 ---------- */
  const lines = content.split(/\r?\n/);
  let linkCount = 0;
  let surgeCount = 0;
  let qxCount = 0;

  for (const raw of lines) {
    const t = raw.trim();
    if (!t || t.startsWith('#') || t.startsWith('//') || t.startsWith(';')) continue;
    // 跳过 YAML/配置节
    if (/^[\[\w-]+\]$/.test(t)) continue;
    if (/^(port|socks-port|mixed-port|allow-lan|mode|log-level|external-controller|dns|rules|proxy-groups|proxies)\s*:/i.test(t)) continue;

    try {
      let node = null;
      if (t.includes('://')) {
        node = parseLine(t, opts);
        if (node) linkCount += 1;
      }
      if (!node) {
        const qx = qxLineToNode(t);
        if (qx) {
          node = qx;
          qxCount += 1;
        }
      }
      if (!node && t.includes('=') && !t.includes('://')) {
        const sg = surgeLineToNode(t);
        if (sg) {
          node = sg;
          surgeCount += 1;
        }
      }
      if (!node) {
        node = parseLine(t, opts);
      }
      if (node) {
        if (group) node.group = group;
        node.source = opts.source || '';
        if (!node.name) node.name = `${node.server}:${node.port}`;
        nodes.push(node);
      }
    } catch (e) {
      errors.push({ line: t.slice(0, 120), error: e.message });
    }
  }

  let format = '链接列表';
  if (surgeCount && surgeCount >= linkCount) format = 'Surge/Loon 配置';
  else if (qxCount && qxCount >= linkCount) format = 'Quantumult X 配置';
  return { nodes, errors, format };
}

function nodeKey(n) {
  return `${n.type}|${String(n.server).toLowerCase()}|${n.port}`;
}

/** 去重（按 类型+服务器+端口） */
function dedupe(nodes) {
  const seen = new Set();
  const out = [];
  for (const n of nodes) {
    const k = nodeKey(n);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

module.exports = {
  parseText,
  parseLine,
  parseClashYaml,
  dedupe,
  newId,
  TYPE_LABEL,
  UDP_TYPES,
  b64decode,
  looksBase64,
};
