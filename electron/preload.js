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
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),

  // 系统代理
  proxyStatus: () => ipcRenderer.invoke('proxy:status'),
  proxyEnable: (nodeId) => ipcRenderer.invoke('proxy:enable', nodeId),
  proxyDisable: () => ipcRenderer.invoke('proxy:disable'),
  proxySwitch: (nodeId) => ipcRenderer.invoke('proxy:switch', nodeId),
  proxyRoute: (mode) => ipcRenderer.invoke('proxy:route', mode),
  proxyProbe: () => ipcRenderer.invoke('proxy:probe'),
  proxyBypassDefault: () => ipcRenderer.invoke('proxy:bypassDefault'),

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
