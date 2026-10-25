// SPDX-License-Identifier: AGPL-3.0-only
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('studio', Object.freeze({
  restore: () => ipcRenderer.invoke('session:restore'),
  recent: () => ipcRenderer.invoke('session:recent'),
  openRecent: (kind, index) => ipcRenderer.invoke('workspace:recent', kind, index),
  remember: state => ipcRenderer.send('session:update', state),
  onSessionError: callback => { ipcRenderer.on('session:error', () => callback()); },
  chooseFolder: () => ipcRenderer.invoke('workspace:choose'),
  list: id => ipcRenderer.invoke('workspace:list', id),
  read: id => ipcRenderer.invoke('workspace:read', id),
  save: (id, text, version) => ipcRenderer.invoke('workspace:save', id, text, version),
  changed: (id, version) => ipcRenderer.invoke('workspace:changed', id, version),
  create: name => ipcRenderer.invoke('workspace:create', name),
  createDirectory: (parent, name) => ipcRenderer.invoke('workspace:mkdir', parent, name),
  close: () => ipcRenderer.send('window:close'),
  onClose: callback => { ipcRenderer.on('window:request-close', () => callback()); },
  onCommand: callback => { ipcRenderer.on('menu:command', (_event, command) => callback(command)); }
}));
