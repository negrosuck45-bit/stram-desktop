'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('stramDesktop', {
  isDesktop: true,
  getInfo: () => ipcRenderer.invoke('stram:info'),
  retry: () => ipcRenderer.invoke('stram:retry'),
  openExternal: (url) => ipcRenderer.invoke('stram:open-external', url),
  openSettingsWindow: () => ipcRenderer.invoke('stram:open-settings'),
  getSettings: () => ipcRenderer.invoke('stram:get-settings'),
  saveSettings: (url) => ipcRenderer.invoke('stram:save-settings', url),
  resetSettings: () => ipcRenderer.invoke('stram:reset-settings'),
  closeSettings: () => ipcRenderer.invoke('stram:close-settings'),
  openDownloads: () => ipcRenderer.invoke('stram:open-downloads'),
  startSignIn: () => ipcRenderer.invoke('stram:start-sign-in'),
  continueToSite: () => ipcRenderer.invoke('stram:continue-to-site'),
  // Computer tools for the site's AI: guarded in main.js to the Stram site
  // origin inside this window, so a normal browser tab has none of these.
  computerRun: (command) => ipcRenderer.invoke('stram:computer-run', command),
  computerFs: (op, payload) => ipcRenderer.invoke('stram:computer-fs', op, payload),
  computerScreen: () => ipcRenderer.invoke('stram:computer-screen'),
  computerOpen: (target) => ipcRenderer.invoke('stram:computer-open', target),
  computerApp: (action, payload) => ipcRenderer.invoke('stram:computer-app', action, payload),
  computerBrowse: (url) => ipcRenderer.invoke('stram:computer-browse', url),
  computerInfo: () => ipcRenderer.invoke('stram:computer-info'),
  // In-app browser tabs and local MCP servers (1.2.5), guarded like the rest.
  tabOpen: (url) => ipcRenderer.invoke('stram:tab-open', url),
  tabNew: () => ipcRenderer.invoke('stram:tab-new'),
  tabClose: (id) => ipcRenderer.invoke('stram:tab-close', id),
  tabActivate: (id) => ipcRenderer.invoke('stram:tab-activate', id),
  tabList: () => ipcRenderer.invoke('stram:tab-list'),
  tabCommand: (action, payload) => ipcRenderer.invoke('stram:tab-command', action, payload),
  sidebarOpen: () => ipcRenderer.invoke('stram:sidebar-open'),
  sidebarHide: () => ipcRenderer.invoke('stram:sidebar-hide'),
  mcpList: () => ipcRenderer.invoke('stram:mcp-list'),
  mcpLink: (record) => ipcRenderer.invoke('stram:mcp-link', record),
  mcpUnlink: (record) => ipcRenderer.invoke('stram:mcp-unlink', record),
  mcpRestart: (record) => ipcRenderer.invoke('stram:mcp-restart', record),
  mcpCall: (tool, args) => ipcRenderer.invoke('stram:mcp-call', { tool, args }),
})
