'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const REQUEST_CHANNEL = 'dji-desktop:request';

contextBridge.exposeInMainWorld('djiDesktop', Object.freeze({
  request(route, options) {
    return ipcRenderer.invoke(REQUEST_CHANNEL, route, options);
  },
}));
