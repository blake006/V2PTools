'use strict';

/**
 * 安卓二维码链路自检：分享链接 → 二维码 SVG
 * 运行：node scripts/test-qr.js
 */

const path = require('path');

const WEB = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'web');

const qrcode = require(path.join(WEB, 'qrcode.js'));
const share = require(path.join(WEB, 'share.js'));

const node = {
  type: 'anytls',
  server: 'gho107.icuvdproduction.org',
  port: 18443,
  name: '[anytls]香港7-v6-移动联通优化',
  conf: {
    password: '6cfbc3ea-f5ba-43b7-a25a-5bd2bb76a4a0',
    sni: 'd1--ov-gotcha07.bilivideo.com',
    'skip-cert-verify': true,
  },
};

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + name);
  } else {
    fail += 1;
    console.log('  ✗ ' + name + (extra ? '\n      ' + extra : ''));
  }
}

console.log('安卓二维码链路');

const link = share.toShareLink(node);
ok('分享链接非空', !!link, link);
ok('链接格式正确', link.indexOf('anytls://') === 0, link.slice(0, 60));

let svg = '';
let modules = 0;
try {
  const qr = qrcode(0, 'M');
  qr.addData(link);
  qr.make();
  modules = qr.getModuleCount();
  svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
} catch (e) {
  ok('生成二维码', false, e.message);
}

ok('SVG 生成成功', svg.indexOf('<svg') === 0, svg.slice(0, 40));
ok('模块数合理（21~177）', modules >= 21 && modules <= 177, 'modules=' + modules);
ok('SVG 含路径数据', svg.indexOf('path') > 0 || svg.indexOf('rect') > 0, 'len=' + svg.length);

// 超长链接（带完整参数）也要能画出来
const longNode = Object.assign({}, node, { name: '这是一个特别长的节点名称用来测试二维码容量边界情况-香港-移动-优化-01' });
const longLink = share.toShareLink(longNode);
let longOk = false;
let longModules = 0;
try {
  const q2 = qrcode(0, 'M');
  q2.addData(longLink);
  q2.make();
  longModules = q2.getModuleCount();
  longOk = q2.createSvgTag({ cellSize: 3, margin: 2 }).indexOf('<svg') === 0;
} catch (e) {
  longOk = false;
}
ok('长链接也能生成', longOk, 'modules=' + longModules);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
