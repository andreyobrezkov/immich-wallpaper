import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell, screen, powerMonitor, protocol, MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import { Config, DEFAULTS, Named, configExists, loadConfig, saveConfig } from './config';
import { Changer, Target } from './changer';
import { ImmichClient, errText } from './immich';
import { dims, fetchBatch, resolveOrientation, summarize } from './picker';
import { initLog, log, logFile, onLogLine, recentLog } from './log';
import { readApiKey, writeApiKey } from './win32';
import { listMonitors } from './desktopWallpaper';
import { activeProfile, effectiveConfig, nextBoundary } from './profiles';
import { checkNow, initUpdater, installNow, setAutoUpdate, updateStatus, UpdateStatus } from './updater';

const ROOT = path.join(__dirname, '..');
const asset = (f: string) => path.join(ROOT, 'assets', f);
const PKG = require(path.join(ROOT, 'package.json')) as { homepage?: string; description?: string };

protocol.registerSchemesAsPrivileged([
  { scheme: 'immich-thumb', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let dataDir: string;
let cfg: Config;
let apiKey: string | null = null;
let changer: Changer;
let tray: Tray | null = null;
let timer: NodeJS.Timeout | null = null;
let nextAt = 0;
let settingsWin: BrowserWindow | null = null;
/** server/key used by the settings window preview before they are saved */
let previewCreds: { server: string; key: string } | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--next')) void changeNow('command line');
    else openSettings();
  });
  app.on('window-all-closed', () => { /* keep running in the tray */ });
  app.whenReady().then(start).catch(e => { log(`fatal: ${errText(e)}`); app.quit(); });
}

async function start(): Promise<void> {
  app.setAppUserModelId('local.immich.wallpaper');
  dataDir = app.getPath('userData');
  initLog(dataDir);
  cfg = loadConfig(dataDir);
  apiKey = readApiKey();
  changer = new Changer(dataDir);
  log(`started ${app.getVersion()}, data in ${dataDir}`);

  protocol.handle('immich-thumb', async req => {
    const id = new URL(req.url).pathname.replace(/^\/+/, '');
    const creds = previewCreds ?? (apiKey ? { server: cfg.server, key: apiKey } : null);
    if (!creds || !/^[0-9a-f-]{36}$/.test(id)) return new Response(null, { status: 404 });
    try {
      const { buf, type } = await new ImmichClient(creds.server, creds.key).image(id, 'thumbnail', 30_000);
      return new Response(new Uint8Array(buf), { headers: { 'content-type': type } });
    } catch {
      return new Response(null, { status: 502 });
    }
  });

  registerIpc();
  tray = new Tray(trayIcon());
  tray.on('click', () => tray?.popUpContextMenu());
  tray.on('double-click', () => openCurrentInImmich());
  updateTray();
  applyAutostart();
  initUpdater(cfg.autoUpdate, s => {
    updateTray();
    settingsWin?.webContents.send('update:status', s);
  });

  powerMonitor.on('resume', () => schedule());     // timers drift during sleep
  powerMonitor.on('unlock-screen', () => schedule());
  screen.on('display-metrics-changed', () => updateTray());

  if (!configExists(dataDir) || !apiKey) openSettings();
  // after logon give Docker/Immich a minute to come up
  schedule(process.argv.includes('--autostart') ? 60_000 : 10_000);
}

// ---------- changing ----------
function orientation() {
  return resolveOrientation(cfg.orientation, screen.getPrimaryDisplay().size);
}

/** Where pictures go: each active monitor (per-monitor mode) or one picture for all. */
function targets(): Target[] {
  let ms: ReturnType<typeof listMonitors> = [];
  try { ms = listMonitors(); } catch (e) { log(`warning: cannot list monitors (${errText(e)})`); }
  if (cfg.perMonitor && ms.length > 1) {
    return ms.map(m => ({
      id: m.id, label: `Monitor ${m.index + 1} (${m.width}×${m.height})`,
      orientation: resolveOrientation(cfg.orientation, m), width: m.width, height: m.height,
    }));
  }
  // one picture for all: big enough for the largest monitor
  const d = screen.getPrimaryDisplay();
  const width = Math.max(Math.round(d.size.width * d.scaleFactor), ...ms.map(m => m.width));
  const height = Math.max(Math.round(d.size.height * d.scaleFactor), ...ms.map(m => m.height));
  return [{ id: null, label: 'All monitors', orientation: orientation(), width, height }];
}

async function changeNow(reason: string, only?: string | null): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  // second-instance and tray events arrive inside a synchronous window message; out-of-process COM
  // (IDesktopWallpaper lives in Explorer) fails there with RPC_E_CANTCALLOUT_ININPUTSYNCCALL
  await new Promise(r => setTimeout(r, 0));
  const profile = activeProfile(cfg);
  const run = changer.change({
    cfg: effectiveConfig(cfg, profile), apiKey, targets: targets(), only, profile: profile?.name ?? null, reason,
  });
  updateTray();
  await run;
  updateTray();
  schedule();
  settingsWin?.webContents.send('state:changed');
}

/** Timer fires at the next interval or the next filter-set boundary, whichever is first. */
function schedule(minDelay = 2_000): void {
  if (timer) clearTimeout(timer);
  timer = null;
  nextAt = 0;
  if (cfg.paused || changer.busy) { updateTray(); return; }
  const due = changer.state.lastChange + cfg.intervalMinutes * 60_000;
  const boundary = nextBoundary(cfg);
  const at = Math.max(Math.min(due, boundary ?? Infinity), Date.now() + minDelay);
  nextAt = Math.max(due, Date.now() + minDelay);
  timer = setTimeout(() => {
    const profile = activeProfile(cfg)?.name ?? null;
    if (Date.now() >= due - 1000) void changeNow('timer');
    else if (profile !== changer.state.lastProfile) void changeNow(`filter set '${profile ?? 'Default'}' started`);
    else schedule();
  }, at - Date.now());
  updateTray();
}

function togglePause(): void {
  cfg.paused = !cfg.paused;
  saveConfig(dataDir, cfg);
  log(cfg.paused ? 'paused' : 'resumed');
  schedule();
}

function openInImmich(id: string | null | undefined): void {
  if (id) void shell.openExternal(new ImmichClient(cfg.server, '').photoUrl(id));
}

const openCurrentInImmich = () => openInImmich(changer.state.current?.id);

/** Hides the photo for good and replaces it (only on that monitor in per-monitor mode). */
async function neverShow(screenId: string | null): Promise<void> {
  const s = changer.state.screens.find(x => x.id === screenId);
  const cur = s?.current ?? changer.state.current;
  if (!cur?.id) return;
  changer.block(cur.id);
  log(`never show again: ${cur.id} '${cur.name}'`);
  await changeNow('never show', s && changer.state.screens.length > 1 ? screenId : undefined);
  changer.removeFromCache(cur.id);
}

// ---------- tray ----------
function trayIcon() {
  return nativeImage.createFromPath(asset(cfg.paused ? 'tray-paused.png' : 'tray.png'));
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function updateTray(): void {
  if (!tray) return;
  const st = changer.state;
  const cur = st.current;
  const status = changer.busy ? 'changing…' : cfg.paused ? 'paused' : nextAt ? `next at ${hhmm(nextAt)}` : '';
  tray.setImage(trayIcon());
  tray.setToolTip(cut(['Immich Wallpaper', cur ? cut(cur.name, 50) : '', status].filter(Boolean).join('\n'), 127));

  const profile = activeProfile(cfg)?.name;
  const items: MenuItemConstructorOptions[] = [];
  if (st.screens.length > 1) {
    // one submenu per monitor
    for (const s of st.screens) {
      items.push({
        label: `${s.label.replace(/ \(.*/, '')}: ${cut(s.current.name, 40)}${s.current.offline ? ' (offline)' : ''}`,
        submenu: [
          { label: 'Next photo on this monitor', enabled: !changer.busy, click: () => void changeNow('manual, one monitor', s.id) },
          { label: 'Open in Immich', enabled: !!s.current.id, click: () => openInImmich(s.current.id) },
          { label: 'Never show this photo', enabled: !!s.current.id && !changer.busy, click: () => void neverShow(s.id) },
        ],
      });
    }
  } else {
    items.push({ label: cur ? cut(cur.name, 50) + (cur.offline ? ' (offline)' : '') : 'No wallpaper yet', enabled: false });
  }
  if (profile) items.push({ label: `Filter set: ${profile}`, enabled: false });
  if (st.lastError) items.push({ label: `⚠ ${cut(st.lastError, 60)}`, enabled: false });
  if (status) items.push({ label: status, enabled: false });
  items.push(
    { type: 'separator' },
    { label: st.screens.length > 1 ? 'Next photos' : 'Next photo', enabled: !changer.busy, click: () => void changeNow('manual') },
    { label: cfg.paused ? 'Resume' : 'Pause', click: togglePause },
  );
  if (st.screens.length <= 1) {
    items.push(
      { label: 'Open in Immich', enabled: !!cur?.id, click: openCurrentInImmich },
      { label: 'Never show this photo', enabled: !!cur?.id && !changer.busy, click: () => void neverShow(cur?.id ? (st.screens[0]?.id ?? null) : null) },
    );
  }
  const upd = updateStatus();
  items.push({ type: 'separator' });
  if (upd.state === 'downloaded') {
    items.push({ label: `Restart to update to v${upd.version}`, click: installNow });
  } else if (upd.state !== 'disabled') {
    items.push({ label: updateLabel(upd), enabled: upd.state !== 'checking' && upd.state !== 'downloading', click: () => void checkNow() });
  }
  items.push(
    { label: 'Settings…', click: openSettings },
    { label: 'Open log', click: () => void shell.openPath(logFile()) },
    { label: 'Open cache folder', click: () => void shell.openPath(changer.cacheDir) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function updateLabel(s: UpdateStatus): string {
  switch (s.state) {
    case 'checking': return 'Checking for updates…';
    case 'available': return `Update v${s.version} found…`;
    case 'downloading': return `Downloading v${s.version}: ${s.percent}%`;
    case 'error': return 'Check for updates (last check failed)';
    default: return 'Check for updates';
  }
}

// ---------- autostart ----------
function applyAutostart(): void {
  if (!app.isPackaged) return; // dev runs would register electron.exe
  app.setLoginItemSettings({ openAtLogin: cfg.autostart, path: process.execPath, args: ['--autostart'] });
}

// ---------- settings window ----------
function openSettings(): void {
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 1040, height: 800, minWidth: 760, minHeight: 560, show: false,
    title: 'Immich Wallpaper — Settings', icon: asset('icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  settingsWin.removeMenu();
  settingsWin.loadFile(path.join(ROOT, 'static', 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin?.show());
  // stream new log lines into the Log tab
  const unsubscribe = onLogLine(line => settingsWin?.webContents.send('log:line', line));
  settingsWin.on('closed', () => { unsubscribe(); settingsWin = null; previewCreds = null; });
  settingsWin.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
}

function clientFor(server: string, key: string | null): ImmichClient {
  const k = key || apiKey;
  if (!k) throw new Error('no API key');
  return new ImmichClient(server, k);
}

async function lists(client: ImmichClient) {
  const errors: string[] = [];
  const safe = async <T>(what: string, f: () => Promise<T[]>): Promise<T[]> => {
    try { return await f(); } catch (e) { errors.push(`${what}: ${errText(e)}`); return []; }
  };
  const byName = (a: Named, b: Named) => a.name.localeCompare(b.name);
  const [tags, albums, people] = await Promise.all([
    safe('tags', async () => (await client.tags()).map(t => ({ id: t.id, name: t.value || t.name })).sort(byName)),
    safe('albums', async () => (await client.albums()).map(a => ({ id: a.id, name: a.albumName, count: a.assetCount })).sort(byName)),
    safe('people', async () => (await client.people()).map(p => ({ id: p.id, name: p.name })).sort(byName)),
  ]);
  return { tags, albums, people, errors };
}

function registerIpc(): void {
  ipcMain.handle('settings:load', () => {
    const d = screen.getPrimaryDisplay().size;
    let monitors: { label: string; orientation: string }[] = [];
    try {
      monitors = listMonitors().map(m => ({ label: `Monitor ${m.index + 1}: ${m.width}×${m.height}`, orientation: resolveOrientation(cfg.orientation, m) }));
    } catch { /* not critical */ }
    return {
      cfg, hasKey: !!apiKey, keyHint: apiKey ? `…${apiKey.slice(-4)}` : '',
      about: {
        version: app.getVersion(), homepage: PKG.homepage ?? '', description: PKG.description ?? '',
        electron: process.versions.electron, logFile: logFile(),
      },
      update: updateStatus(),
      screen: d, orientation: orientation(), monitors, dataDir, packaged: app.isPackaged,
      activeProfile: activeProfile(cfg)?.name ?? null, screens: changer.state.screens,
      current: changer.state.current, lastError: changer.state.lastError,
      blockedCount: changer.state.blocked.length, historyCount: changer.state.history.length,
    };
  });

  ipcMain.handle('settings:save', (_e, next: Config, newKey: string | null) => {
    if (newKey) { writeApiKey(newKey.trim()); apiKey = newKey.trim(); log('API key saved to Credential Manager'); }
    const updateWas = cfg.autoUpdate;
    cfg = { ...DEFAULTS, ...next, paused: cfg.paused };
    saveConfig(dataDir, cfg);
    log('settings saved');
    applyAutostart();
    if (cfg.autoUpdate !== updateWas) setAutoUpdate(cfg.autoUpdate);
    schedule();
    return true;
  });

  ipcMain.handle('immich:check', async (_e, server: string, key: string | null) => {
    try {
      const c = clientFor(server, key);
      const v = await c.version();
      let perms: string[] | null = null;
      try { perms = (await c.keyInfo()).permissions; } catch { /* older Immich */ }
      return { ok: true, version: `${v.major}.${v.minor}.${v.patch}`, perms };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  });

  ipcMain.handle('immich:lists', async (_e, server: string, key: string | null) => {
    try { return await lists(clientFor(server, key)); } catch (e) { return { tags: [], albums: [], people: [], errors: [errText(e)] }; }
  });

  ipcMain.handle('immich:preview', async (_e, draft: Config, key: string | null) => {
    try {
      const c = clientFor(draft.server, key);
      previewCreds = { server: draft.server, key: key || apiKey! };
      const full = { ...DEFAULTS, ...draft };
      const o = resolveOrientation(full.orientation, screen.getPrimaryDisplay().size);
      const b = await fetchBatch(c, full, o, new Set(changer.state.blocked));
      return {
        ok: true, orientation: o, fetched: b.fetched.length, pass: b.pass.length, complete: b.complete, smart: b.smart,
        rejected: summarize(b.rejected),
        items: b.pass.slice(0, 60).map(a => { const [w, h] = dims(a); return { id: a.id, name: a.originalFileName, w, h }; }),
      };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  });

  ipcMain.handle('action:next', () => changeNow('settings'));
  ipcMain.handle('update:check', () => checkNow());
  ipcMain.handle('update:install', () => installNow());
  ipcMain.handle('action:openExternal', (_e, url: string) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); });
  ipcMain.handle('log:recent', () => recentLog());
  ipcMain.handle('blocked:clear', () => { changer.state.blocked = []; changer.saveState(); log('blocked list cleared'); return true; });
}
