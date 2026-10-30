'use strict';

/**
 * 极简 HTTP/HTTPS 代理 Agent（HTTP CONNECT 隧道）
 * 用于把请求打到 mihomo 的本地 mixed 监听端口上
 */

const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');

function tunnel(proxyPort, targetHost, targetPort, cb) {
  const socket = net.connect({ host: '127.0.0.1', port: proxyPort });
  let settled = false;

  const fail = (err) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    cb(err);
  };

  socket.setTimeout(0);
  socket.once('error', fail);
  socket.once('close', () => {
    if (!settled) fail(new Error('proxy tunnel closed'));
  });
  socket.once('connect', () => {
    socket.write(
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Connection: keep-alive\r\n\r\n`
    );
  });

  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) {
      if (buf.length > 8192) fail(new Error('proxy response too large'));
      return;
    }
    const head = buf.slice(0, idx).toString('latin1');
    const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(head);
    socket.removeListener('data', onData);
    if (!m) return fail(new Error('bad proxy response'));
    const code = Number(m[1]);
    if (code !== 200) return fail(new Error('proxy CONNECT failed: ' + code));
    const rest = buf.slice(idx + 4);
    if (rest.length) socket.unshift(rest);
    settled = true;
    cb(null, socket);
  };
  socket.on('data', onData);
  return socket;
}

function makeCreateConnection(secure) {
  return function createConnection(options, cb) {
    const port = Number(options.port) || (secure ? 443 : 80);
    const host = options.host;
    let socketRef = null;
    socketRef = tunnel(this.proxyPort, host, port, (err, socket) => {
      if (err) return cb(err);
      if (!secure) return cb(null, socket);
      const tlsSocket = tls.connect(
        {
          socket,
          servername: options.servername || host,
          rejectUnauthorized: false,
          ALPNProtocols: ['http/1.1'],
        },
        () => cb(null, tlsSocket)
      );
      tlsSocket.once('error', (e) => {
        try {
          socket.destroy();
        } catch (err2) {}
        cb(e);
      });
    });
    return undefined;
  };
}

class HttpTunnelAgent extends http.Agent {
  constructor(opts) {
    super({ keepAlive: false, maxSockets: 64 });
    this.proxyPort = opts.proxyPort;
  }
}
HttpTunnelAgent.prototype.createConnection = makeCreateConnection(false);

class HttpsTunnelAgent extends https.Agent {
  constructor(opts) {
    super({ keepAlive: false, maxSockets: 64 });
    this.proxyPort = opts.proxyPort;
  }
}
HttpsTunnelAgent.prototype.createConnection = makeCreateConnection(true);

function agentFor(proxyPort, isHttps) {
  return isHttps ? new HttpsTunnelAgent({ proxyPort }) : new HttpTunnelAgent({ proxyPort });
}

module.exports = { agentFor, HttpTunnelAgent, HttpsTunnelAgent };
