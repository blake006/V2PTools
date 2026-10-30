'use strict';

/**
 * 配置合法性校验：把各格式解析出的节点生成 mihomo 配置，用 mihomo -t 校验
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');
const parser = require('../electron/lib/parser');
const { CoreManager } = require('../electron/lib/core');
const { cases } = require('./test-parser');

const nodes = [];
for (const [, text] of cases) {
  const r = parser.parseText(text, { plainType: 'socks5', allowHttpProxy: true });
  nodes.push(...r.nodes);
}

const uniq = parser.dedupe(nodes);
console.log('待校验节点数:', uniq.length, '类型:', [...new Set(uniq.map((n) => n.type))].join(', '));

const tmp = path.join(os.tmpdir(), 'iph-cfgtest');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

const core = new CoreManager({ corePath: path.join(__dirname, '..', 'vendor', 'mihomo.exe'), dataDir: tmp });
core.ctlPort = 23999;
const ports = uniq.map((_, i) => 25000 + i);
const cfg = core.buildConfig(uniq, ports);
const cfgPath = path.join(tmp, 'config.yaml');
fs.writeFileSync(cfgPath, yaml.dump(cfg, { lineWidth: 4096, noRefs: true }), 'utf8');

try {
  const out = execFileSync(path.join(__dirname, '..', 'vendor', 'mihomo.exe'), ['-t', '-d', tmp, '-f', cfgPath], {
    encoding: 'utf8',
    timeout: 30000,
  });
  console.log(out.trim().split('\n').slice(-1).join('\n'));
  console.log('✅ 配置校验通过');
} catch (e) {
  console.log('❌ 配置校验失败');
  console.log((e.stdout || '').split('\n').slice(-10).join('\n'));
  console.log((e.stderr || '').split('\n').slice(-10).join('\n'));
  process.exit(1);
}
