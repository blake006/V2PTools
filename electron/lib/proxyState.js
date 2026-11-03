'use strict';

/**
 * 系统代理状态机
 *
 * 以前 proxyStatus 只算一个布尔值，结果下面这些「坏状态」全都显示成「已关闭」，
 * 用户根本不知道电脑正处于什么情况。这里把它们拆成 6 个明确状态：
 *
 *   off        系统代理未开启，内核也没跑
 *   on         内核在跑 + 系统代理正确指向本机网关   ← 唯一健康态
 *   starting   内核在跑但存活自检失败（刚启动 / 挂了）
 *   hijacked   内核在跑，但系统代理被别的程序改掉 / 关掉了
 *   orphan     系统代理还指向网关端口，但内核已经死了   ← 正在断网
 *   foreign    系统代理开着，指向的是别的地址（不是本工具）
 *
 * 纯函数，方便单测。
 */

const STATE_TEXT = {
  off: '系统代理 已关闭',
  on: '系统代理 ',
  starting: '系统代理 启动中…',
  hijacked: '系统代理 被外部修改',
  orphan: '系统代理 已失联',
  foreign: '系统代理 指向其它地址',
};

/**
 * @param {object} gw  gateway.status() 的结果
 * @param {object} sys sysproxy.status() 的结果
 * @returns {string} 状态码
 */
function deriveProxyState(gw, sys) {
  const running = !!(gw && gw.running);
  const target = gw && gw.port ? `127.0.0.1:${gw.port}` : '';
  const sysEnabled = !!(sys && sys.proxyEnable === 1 && sys.server);
  const pointsHere = !!(sys && sys.server && target && sys.server === target);
  const knownBackup = !!(sys && sys.backup && sys.backup.target);

  // TUN 模式：流量在网卡层就被接管，系统代理本来就该是关的，不能因此判成未开启
  if (running && gw.tunMode) {
    return gw.aliveFlag === false ? 'starting' : 'on';
  }

  if (running && pointsHere) {
    // 内核在跑、代理也指着它，但存活自检明确失败 —— 说明内核僵了
    if (gw.aliveFlag === false) return 'starting';
    return 'on';
  }
  if (running && !pointsHere) return 'hijacked';
  // 内核没跑，但注册表还指着我们的网关端口
  if (!running && sysEnabled && pointsHere) return knownBackup ? 'orphan' : 'foreign';
  if (!running && sysEnabled && !pointsHere) return 'foreign';
  return 'off';
}

/**
 * 决定「当前生效的分流方式」。
 *
 * 内核在跑时以内核为准（切换模式会按新模式重启内核，它才是权威）；
 * 内核没跑时以保存的设置为准 —— `gateway.routeMode` 是上次运行的残留值，
 * 不能拿它覆盖用户关掉代理之后新选的模式。
 *
 * 历史 bug：直接写 `gw.routeMode || settings.routeMode`，导致
 * 「关闭代理 → 把模式从全局改成绕过大陆 → 界面仍显示全局代理」。
 *
 * @param {{running:boolean, routeMode?:string}} gw
 * @param {{routeMode?:string}} settings
 * @returns {string} 三选一，非法值回退 global
 */
function pickRouteMode(gw, settings) {
  const valid = ['global', 'bypass-cn', 'proxy-list'];
  const running = !!(gw && gw.running);
  const primary = running ? gw && gw.routeMode : settings && settings.routeMode;
  const fallback = running ? settings && settings.routeMode : gw && gw.routeMode;
  const pick = [primary, fallback].find((m) => valid.includes(m));
  return pick || 'global';
}

module.exports = { deriveProxyState, pickRouteMode, STATE_TEXT };
