'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  getStore: (key) => ipcRenderer.invoke('store:get', key),
  setStore: (key, value) => ipcRenderer.invoke('store:set', key, value),

  parseImport: (text, opts) => ipcRenderer.invoke('import:parse', { text, opts }),
  fetchSubscription: (url) => ipcRenderer.invoke('import:fetch', url),
  importFile: () => ipcRenderer.invoke('import:file'),

  runTest: (payload) => ipcRenderer.invoke('test:run', payload),
  cancelTest: () => ipcRenderer.invoke('test:cancel'),

  exportFile: (payload) => ipcRenderer.invoke('export:save', payload),
  exportClash: (payload) => ipcRenderer.invoke('export:clash', payload),
  exportSingBox: (payload) => ipcRenderer.invoke('export:singbox', payload),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),

  // 系统代理
  proxyStatus: () => ipcRenderer.invoke('proxy:status'),
  proxyEnable: (nodeId, mode) => ipcRenderer.invoke('proxy:enable', nodeId, mode),
  tunCheck: () => ipcRenderer.invoke('proxy:tun-check'),
  trafficToggle: () => ipcRenderer.invoke('traffic:toggle'),
  qrMake: (text) => ipcRenderer.invoke('qr:make', text),
  envConflicts: () => ipcRenderer.invoke('env:conflicts'),
  backup: () => ipcRenderer.invoke('data:backup'),
  restore: () => ipcRenderer.invoke('data:restore'),
  resetAll: () => ipcRenderer.invoke('data:reset'),
  relaunchElevated: () => ipcRenderer.invoke('app:relaunch-elevated'),
  proxyDisable: () => ipcRenderer.invoke('proxy:disable'),
  proxyCheck: () => ipcRenderer.invoke('proxy:check'),
  // 托盘菜单「开启/关闭系统代理」→ 交给渲染层复用同一套逻辑
  onTrayToggleProxy: (cb) => ipcRenderer.on('tray:toggle-proxy', () => cb()),
  proxySwitch: (nodeId) => ipcRenderer.invoke('proxy:switch', nodeId),
  proxyRoute: (mode) => ipcRenderer.invoke('proxy:route', mode),
  proxyProbe: () => ipcRenderer.invoke('proxy:probe'),
  proxyBypassDefault: () => ipcRenderer.invoke('proxy:bypassDefault'),
  netInspect: () => ipcRenderer.invoke('net:inspect'),
  netRepair: () => ipcRenderer.invoke('net:repair'),

  onProxyState: (cb) => {
    const handler = (_e, st) => cb(st);
    ipcRenderer.on('proxy:state', handler);
    return () => ipcRenderer.removeListener('proxy:state', handler);
  },
  onProxyError: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('proxy:error', handler);
    return () => ipcRenderer.removeListener('proxy:error', handler);
  },
  onNetGuardNotice: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('net:guard-notice', handler);
    return () => ipcRenderer.removeListener('net:guard-notice', handler);
  },

  onTestEvent: (cb) => {
    const handler = (_e, ev) => cb(ev);
    ipcRenderer.on('test:event', handler);
    return () => ipcRenderer.removeListener('test:event', handler);
  },
  onCoreLog: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('core:log', handler);
    return () => ipcRenderer.removeListener('core:log', handler);
  },
});
