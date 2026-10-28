const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('kit', {
  store: { get: call('store:get'), set: call('store:set') },
  copy: call('clipboard:write'),
  open: call('shell:open'),
  reveal: call('shell:reveal'),
  openFolder: call('shell:openFolder'),
  pathFor: (file) => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
  writeFile: call('file:write'),
  exists: call('file:exists'),
  saveAs: call('file:saveAs'),
  saveText: call('file:writeText'),
  pickFolder: call('dialog:folder'),
  defaults: call('app:defaults'),
  claude: { ask: call('claude:ask'), cancel: call('claude:cancel'), status: call('claude:status') },
  stock: { search: call('stock:search'), download: call('stock:download') },
  openai: { ask: call('openai:ask'), cancel: call('openai:cancel'), status: call('openai:status') },
  probe: call('media:probe'),
  version: call('app:version'),
  update: {
    check: call('update:check'),
    install: call('update:install'),
    openPage: call('update:openPage'),
    onProgress: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on('update:progress', h); return () => ipcRenderer.off('update:progress', h); },
    onAvailable: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on('update:available', h); return () => ipcRenderer.off('update:available', h); },
  },
  whisper: {
    status: call('whisper:status'),
    install: call('whisper:install'),
    transcribe: call('whisper:transcribe'),
    cancel: call('whisper:cancel'),
    log: call('whisper:log'),
    onProgress: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on('whisper:progress', h); return () => ipcRenderer.off('whisper:progress', h); },
    onInstallProgress: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on('whisper:installProgress', h); return () => ipcRenderer.off('whisper:installProgress', h); },
  },
});
