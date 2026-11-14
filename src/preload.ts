import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('settings:load'),
  save: (cfg: unknown, key: string | null) => ipcRenderer.invoke('settings:save', cfg, key),
  check: (server: string, key: string | null) => ipcRenderer.invoke('immich:check', server, key),
  lists: (server: string, key: string | null) => ipcRenderer.invoke('immich:lists', server, key),
  preview: (cfg: unknown, key: string | null) => ipcRenderer.invoke('immich:preview', cfg, key),
  next: () => ipcRenderer.invoke('action:next'),
  openExternal: (url: string) => ipcRenderer.invoke('action:openExternal', url),
  log: () => ipcRenderer.invoke('log:recent'),
  clearBlocked: () => ipcRenderer.invoke('blocked:clear'),
  onLogLine: (fn: (line: string) => void) => { ipcRenderer.on('log:line', (_e, line: string) => fn(line)); },
  onStateChanged: (fn: () => void) => { ipcRenderer.on('state:changed', () => fn()); },
});
