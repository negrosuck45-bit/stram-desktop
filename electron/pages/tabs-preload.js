'use strict'

// The docked browser sidebar's own bridge: it renders open tabs, drives the
// active page, and routes clicks back to the main process.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('stramTabs', {
  activate: (id) => ipcRenderer.invoke('stram:tab-activate', id),
  close: (id) => ipcRenderer.invoke('stram:tab-close', id),
  openUrl: (url) => ipcRenderer.invoke('stram:tab-open', url),
  newTab: () => ipcRenderer.invoke('stram:tab-new'),
  hide: () => ipcRenderer.invoke('stram:sidebar-hide'),
  command: (action, payload) => ipcRenderer.invoke('stram:tab-command', action, payload),
  list: () => ipcRenderer.invoke('stram:tab-list'),
  onState: (callback) => {
    ipcRenderer.on('stram:tabs-state', (_event, state) => callback(state))
  },
})
