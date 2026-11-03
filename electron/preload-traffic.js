'use strict';

/** 流量悬浮窗的 preload：只负责收数据，不给页面任何额外权限 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trafficApi', {
  onData: (cb) => ipcRenderer.on('traffic:data', (e, d) => cb(d)),
  close: () => ipcRenderer.send('traffic:close'),
});
