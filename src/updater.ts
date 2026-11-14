// Auto-update from GitHub releases (electron-updater reads latest.yml published by the build workflow).
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { log } from './log';

export type UpdateStatus =
  | { state: 'disabled'; reason: string }
  | { state: 'idle'; checkedAt: number | null }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };

const FIRST_CHECK_MS = 60_000;          // let the app (and Docker/Immich) start first
const CHECK_EVERY_MS = 6 * 3600_000;

let status: UpdateStatus = { state: 'idle', checkedAt: null };
let onChange: (s: UpdateStatus) => void = () => {};
let timer: NodeJS.Timeout | null = null;
let enabled = false;

function set(s: UpdateStatus) {
  status = s;
  onChange(s);
}

export const updateStatus = () => status;

export function initUpdater(autoUpdate: boolean, changed: (s: UpdateStatus) => void): void {
  onChange = changed;
  if (!app.isPackaged) { set({ state: 'disabled', reason: 'dev mode' }); return; }

  autoUpdater.logger = {
    info: (m: unknown) => log(`updater: ${String(m)}`),
    warn: (m: unknown) => log(`updater warning: ${String(m)}`),
    error: (m: unknown) => log(`updater error: ${String(m)}`),
    debug: () => {},
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ state: 'idle', checkedAt: Date.now() }));
  autoUpdater.on('update-available', i => set({ state: 'available', version: i.version }));
  autoUpdater.on('download-progress', p => {
    const version = status.state === 'available' || status.state === 'downloading' ? status.version : '?';
    set({ state: 'downloading', version, percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', i => {
    log(`update ${i.version} downloaded - installs on quit or via "Restart to update"`);
    set({ state: 'downloaded', version: i.version });
  });
  autoUpdater.on('error', e => set({ state: 'error', message: e?.message?.split('\n')[0] ?? String(e) }));

  setAutoUpdate(autoUpdate);
}

/** Turns periodic checks on/off (settings checkbox). Manual checks always work in the built app. */
export function setAutoUpdate(on: boolean): void {
  if (!app.isPackaged) return;
  enabled = on;
  if (timer) { clearTimeout(timer); timer = null; }
  if (!on) { if (status.state === 'idle') set({ state: 'idle', checkedAt: null }); return; }
  const loop = (delay: number) => {
    timer = setTimeout(() => { void checkNow(); loop(CHECK_EVERY_MS); }, delay);
  };
  loop(FIRST_CHECK_MS);
}

export async function checkNow(): Promise<UpdateStatus> {
  if (!app.isPackaged) return status;
  if (status.state === 'checking' || status.state === 'downloading' || status.state === 'downloaded') return status;
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    set({ state: 'error', message: e instanceof Error ? e.message.split('\n')[0] : String(e) });
  }
  return status;
}

/** Quits and runs the downloaded installer silently, then starts the new version. */
export function installNow(): void {
  if (status.state !== 'downloaded') return;
  log(`installing update ${status.version}`);
  autoUpdater.quitAndInstall(true, true);
}

export const autoUpdateEnabled = () => enabled;
