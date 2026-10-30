'use strict';

/**
 * 测试调度器：分批启动内核 → 并发测试 → 汇总归属地与健康度
 */

const { testLatency, testSpeed, fetchExitIP, testTcp, DEFAULT_LATENCY_URLS, DEFAULT_IP_URLS } = require('./tester');
const geo = require('./geo');
const { UDP_TYPES } = require('./parser');

const CHUNK_SIZE = 500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pool(items, limit, worker, isAborted) {
  let idx = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      if (isAborted()) return;
      const cur = items[idx];
      idx += 1;
      // eslint-disable-next-line no-await-in-loop
      await worker(cur);
    }
  });
  await Promise.all(runners);
}

class Runner {
  constructor(opts) {
    this.core = opts.core;
    this.settings = opts.settings;
    this.emit = opts.emit;
    this.aborted = false;
  }

  cancel() {
    this.aborted = true;
  }

  /**
   * 启动内核；若因个别节点的配置非法导致启动失败，二分定位并剔除坏节点
   */
  async startWithFallback(nodes, depth = 0) {
    try {
      await this.core.start(nodes);
      return { valid: nodes, invalid: [] };
    } catch (e) {
      const msg = e.message || '';
      if (/未找到内核文件|内核正在启动中|端口不足/.test(msg) || nodes.length <= 1 || depth > 12) {
        return { valid: [], invalid: nodes.map((n) => ({ node: n, error: msg })) };
      }
      const mid = Math.ceil(nodes.length / 2);
      const left = await this.startWithFallback(nodes.slice(0, mid), depth + 1);
      const right = await this.startWithFallback(nodes.slice(mid), depth + 1);
      return {
        valid: left.valid.concat(right.valid),
        invalid: left.invalid.concat(right.invalid),
      };
    }
  }

  /** mode: latency | speed | ip | full */
  async run(nodes, mode = 'full') {
    this.aborted = false;
    const list = nodes.filter((n) => n && n.server && n.port);
    const total = list.length;
    if (!total) return { total: 0 };

    const concurrency = Math.max(1, Math.min(32, this.settings.concurrency || 8));
    const latencyTimeout = this.settings.latencyTimeout || 8000;
    const speedTimeout = this.settings.speedTimeout || 20000;
    const speedBytes = (this.settings.speedBytes || 10) * 1024 * 1024;
    const latencyUrls = this.settings.latencyUrls && this.settings.latencyUrls.length
      ? this.settings.latencyUrls
      : DEFAULT_LATENCY_URLS;
    const ipUrls = this.settings.ipUrls && this.settings.ipUrls.length ? this.settings.ipUrls : DEFAULT_IP_URLS;

    const wantLatency = true;
    const wantSpeed = mode === 'speed' || mode === 'full';
    const wantIp = mode === 'ip' || mode === 'full';
    const deep = wantIp && this.settings.deepHealth !== false;

    let finished = 0;
    const chunks = [];
    for (let i = 0; i < list.length; i += CHUNK_SIZE) chunks.push(list.slice(i, i + CHUNK_SIZE));

    this.emit({ type: 'run-start', total, mode });

    for (const chunk of chunks) {
      if (this.aborted) break;
      this.emit({ type: 'phase', phase: 'starting-core', count: chunk.length });

      try {
        // eslint-disable-next-line no-await-in-loop
        const started = await this.startWithFallback(chunk);
        if (started.invalid.length) {
          for (const bad of started.invalid) {
            finished += 1;
            Object.assign(bad.node, {
              status: 'fail',
              error: '配置无法加载: ' + String(bad.error).slice(0, 120),
              testedAt: Date.now(),
            });
            this.emit({
              type: 'node',
              id: bad.node.id,
              patch: { status: 'fail', error: bad.node.error, testedAt: bad.node.testedAt },
              finished,
              total,
            });
          }
        }
        if (!started.valid.length) {
          this.emit({ type: 'core-error', error: '该批次节点均无法加载' });
          continue;
        }
        // 二分后内核里只保留最后一次成功的子集，这里重新加载全部可用节点
        const valid = started.valid.slice();
        // eslint-disable-next-line no-await-in-loop
        await this.core.start(valid);
        chunk.length = 0;
        chunk.push(...valid);
      } catch (e) {
        this.emit({ type: 'core-error', error: e.message });
        for (const n of chunk) {
          finished += 1;
          this.emit({
            type: 'node',
            id: n.id,
            patch: { status: 'fail', error: '内核启动失败: ' + e.message, testedAt: Date.now() },
            finished,
            total,
          });
        }
        continue;
      }

      this.emit({ type: 'phase', phase: 'testing', count: chunk.length });

      await pool(
        chunk,
        concurrency,
        async (node) => {
          if (this.aborted) return;
          const port = this.core.portOf(node.id);
          const patch = { status: 'testing', error: '' };
          const send = (p, extra = {}) => {
            Object.assign(node, p);
            this.emit({ type: 'node', id: node.id, patch: p, finished, total, ...extra });
          };
          send(patch);

          const isUdp = UDP_TYPES.has(node.type);

          // 1) TCP 握手
          if (!isUdp) {
            const tcp = await testTcp(node.server, Number(node.port), Math.min(latencyTimeout, 5000));
            patch.tcp = tcp.ok ? tcp.ms : null;
            if (!tcp.ok && !wantIp) {
              // TCP 都不通，直接判定失败（UDP 类协议跳过）
              patch.status = 'fail';
              patch.error = 'TCP 连接失败: ' + (tcp.error || '');
              patch.testedAt = Date.now();
              finished += 1;
              send(patch);
              return;
            }
          }

          // 2) 通过代理测延迟
          let lat = { ok: false, error: '未测试' };
          if (port) {
            lat = await testLatency(port, {
              urls: latencyUrls,
              timeout: latencyTimeout,
              rounds: 3,
              signal: null,
            });
          } else {
            lat = { ok: false, error: '未分配本地端口' };
          }

          if (!lat.ok) {
            patch.status = 'fail';
            patch.latency = null;
            patch.error = lat.error || '代理不可用';
            patch.testedAt = Date.now();
            finished += 1;
            send(patch);
            return;
          }

          patch.latency = lat.avg;
          patch.jitter = lat.jitter;
          patch.status = 'ok';

          // 3) 测速
          if (wantSpeed && !this.aborted) {
            send({ ...patch, speed: null, testing: 'speed' });
            const sp = await testSpeed(port, {
              bytes: speedBytes,
              timeout: speedTimeout,
              sourceId: this.settings.speedSource,
            });
            patch.speed = sp.ok ? sp.mbps : null;
            if (!sp.ok) patch.speedError = sp.error;
          }

          // 4) 出口 IP
          if (wantIp && !this.aborted) {
            const ipr = await fetchExitIP(port, { urls: ipUrls, timeout: latencyTimeout });
            if (ipr.ok) {
              patch.ip = ipr.ip;
            } else {
              patch.ip = '';
              patch.ipError = ipr.error;
            }
          }

          patch.testedAt = Date.now();
          finished += 1;
          send(patch);
        },
        () => this.aborted
      );

      if (this.aborted) break;

      // 5) 归属地 + 黑名单 + 健康度
      if (wantIp) {
        this.emit({ type: 'phase', phase: 'geo', count: chunk.length });
        const okNodes = chunk.filter((n) => n.ip);
        const ipMap = await geo.lookupBatch(okNodes.map((n) => n.ip));

        const dnsblMap = new Map();
        if (deep) {
          await pool(
            okNodes,
            Math.min(6, concurrency),
            async (n) => {
              const r = await geo.checkDnsbl(n.ip);
              dnsblMap.set(n.id, r);
            },
            () => this.aborted
          );
        }

        for (const n of chunk) {
          const g = ipMap.get(n.ip) || null;
          const d = dnsblMap.get(n.id) || null;
          const { score, reasons } = geo.scoreHealth({
            geo: g,
            dnsbl: d,
            latency: n.latency,
            speed: n.speed,
          });
          const patch = {
            country: g ? g.country : '',
            countryCode: g ? g.countryCode : '',
            region: g ? g.region : '',
            city: g ? g.city : '',
            isp: g ? g.isp : '',
            asn: g ? g.asn : '',
            ipType: g ? geo.ipTypeLabel(g) : n.ip ? '未知' : '',
            proxyFlag: g ? g.proxy : null,
            hostingFlag: g ? g.hosting : null,
            mobileFlag: g ? g.mobile : null,
            dnsbl: d ? d.listed : null,
            health: n.status === 'ok' ? score : null,
            healthReasons: reasons || [],
          };
          Object.assign(n, patch);
          this.emit({ type: 'node', id: n.id, patch, finished, total, silent: true });
        }
      }
    }

    await sleep(50);
    this.emit({ type: 'run-end', total, finished, aborted: this.aborted });
    return { total, finished };
  }
}

module.exports = { Runner, CHUNK_SIZE };
