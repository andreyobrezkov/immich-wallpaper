// Orchestrates one wallpaper change: pick -> download -> fix orientation -> cache -> set (per monitor) -> lock screen.
import fs from 'node:fs';
import path from 'node:path';
import { Config, writeJsonAtomic } from './config';
import { ImmichClient, errText, isTransient } from './immich';
import { fetchWallpaperImage } from './imageSource';
import { ConcreteOrientation, describeFilters, dims, pickAsset, Pick } from './picker';
import { log } from './log';
import { setWallpaper } from './win32';
import { setPerMonitor } from './desktopWallpaper';
import { setLockScreen } from './lockscreen';

export interface Current {
  id: string | null;
  name: string;
  file: string;
  url: string | null;
  offline?: boolean;
  at: number;
}

/** Where a picture goes: one monitor (id = device path) or all of them (id = null). */
export interface Target {
  id: string | null;
  label: string;
  orientation: ConcreteOrientation;
  /** physical pixels; pictures are scaled down to cover this size */
  width: number;
  height: number;
}

export interface ScreenState { id: string | null; label: string; current: Current }

export interface State {
  history: string[];
  blocked: string[];
  /** picture of the first target (primary monitor) */
  current: Current | null;
  screens: ScreenState[];
  lastChange: number;
  lastError: string | null;
  lastProfile: string | null;
}

export interface ChangeRequest {
  cfg: Config;           // effective config (filter set already applied)
  apiKey: string | null;
  targets: Target[];     // all targets of the current layout
  only?: string | null;  // change just this target id (others keep their picture)
  profile: string | null;
  reason: string;
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png']);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class Changer {
  readonly cacheDir: string;
  private readonly stateFile: string;
  state: State;
  private running: Promise<void> | null = null;

  constructor(dataDir: string) {
    this.cacheDir = process.env.IMMICH_WALLPAPER_CACHE || path.join(dataDir, 'cache');
    this.stateFile = path.join(dataDir, 'state.json');
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.state = { history: [], blocked: [], current: null, screens: [], lastChange: 0, lastError: null, lastProfile: null };
    try { Object.assign(this.state, JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))); } catch { /* first run */ }
    if (!this.state.screens) this.state.screens = [];
  }

  get busy(): boolean { return this.running !== null; }

  saveState(): void { writeJsonAtomic(this.stateFile, this.state); }

  block(id: string): void {
    if (!this.state.blocked.includes(id)) this.state.blocked.push(id);
    this.saveState();
  }

  /** Runs one change; concurrent calls share the run in progress. */
  change(req: ChangeRequest): Promise<void> {
    if (!this.running) this.running = this.doChange(req).finally(() => { this.running = null; });
    return this.running;
  }

  private async doChange(req: ChangeRequest): Promise<void> {
    const { cfg } = req;
    const targets = req.only !== undefined ? req.targets.filter(t => t.id === req.only) : req.targets;
    log(`--- change (${req.reason})${req.profile ? `, filter set '${req.profile}'` : ''}, ${targets.map(t => t.label).join(' + ')}`);
    if (!targets.length) { this.fail('monitor not found'); return; }
    if (!req.apiKey) { this.fail('no API key configured - open Settings'); return; }
    const client = new ImmichClient(cfg.server, req.apiKey);
    const blocked = new Set(this.state.blocked);
    // pictures on the monitors we keep must not be picked again
    const keep = this.state.screens
      .filter(s => req.targets.some(t => t.id === s.id) && !targets.some(t => t.id === s.id))
      .map(s => s.current.id).filter(Boolean) as string[];

    const picks: { target: Target; pick: Pick }[] = [];
    for (let attempt = 1; ; attempt++) {
      try {
        picks.length = 0;
        let history = [...this.state.history];
        const taken = new Set(keep);
        for (const target of targets) {
          log(`${target.label}: filters ${describeFilters(cfg, target.orientation)}`);
          // photos already on another monitor are excluded hard (reported as "blocked/in use")
          const pick = await pickAsset(client, cfg, target.orientation, history, new Set([...blocked, ...taken]), log);
          if (!pick) { log(`${target.label}: no photo matches the filters`); continue; }
          if (pick.newRound) history = [];
          taken.add(pick.asset.id);
          picks.push({ target, pick });
        }
        if (picks.some(p => p.pick.newRound)) this.state.history = [];
        break;
      } catch (e) {
        if (!isTransient(e)) { this.fail(`Immich: ${errText(e)}`); return; }
        if (attempt >= cfg.retries) { await this.useCache(req, targets, `Immich unavailable (${errText(e)})`); return; }
        log(`Immich unavailable (${errText(e)}) - retry ${attempt}/${cfg.retries - 1} in ${cfg.retryDelaySec}s`);
        await sleep(cfg.retryDelaySec * 1000);
      }
    }
    if (!picks.length) { this.fail('no photo matches the filters - keeping current wallpaper'); return; }

    const done: { target: Target; current: Current }[] = [];
    for (const { target, pick } of picks) {
      const a = pick.asset;
      const [w, h] = dims(a);
      log(`${target.label}: picked ${a.id} '${a.originalFileName}' ${w}x${h}, taken ${a.localDateTime?.slice(0, 10) ?? '?'}${pick.rank ? `, relevance rank ${pick.rank}` : ''}`);
      try {
        const file = await fetchWallpaperImage(client, cfg, a, { width: target.width, height: target.height }, this.cacheDir, log);
        done.push({ target, current: { id: a.id, name: a.originalFileName, file, url: client.photoUrl(a.id), at: Date.now() } });
      } catch (e) {
        log(`${target.label}: download failed (${errText(e)})`);
      }
    }
    if (!done.length) { await this.useCache(req, targets, 'download failed'); return; }

    if (!(await this.apply(req, done))) return;
    for (const d of done) {
      if (d.current.id) this.state.history = [d.current.id, ...this.state.history.filter(x => x !== d.current.id)];
    }
    this.state.history = this.state.history.slice(0, cfg.historySize);
    this.state.lastError = null;
    this.saveState();
    this.trimCache(Math.max(cfg.cacheSize, this.state.screens.length + 1));
  }

  /** Sets the pictures, updates current/screens state. Returns false on failure. */
  private async apply(req: ChangeRequest, done: { target: Target; current: Current }[]): Promise<boolean> {
    const { cfg } = req;
    try {
      if (done.length === 1 && done[0].target.id === null) {
        await setWallpaper(done[0].current.file, cfg.style);
      } else {
        try {
          setPerMonitor(new Map(done.map(d => [d.target.id!, d.current.file])), cfg.style);
        } catch (e) {
          // fall back to one picture for all monitors rather than leaving the old wallpaper
          log(`warning: per-monitor wallpaper failed (${errText(e)}) - using one picture for all monitors`);
          await setWallpaper(done[0].current.file, cfg.style);
          done.splice(1);
          done[0].target = { ...done[0].target, id: null, label: 'All monitors' };
          req = { ...req, targets: [done[0].target] };
        }
      }
    } catch (e) {
      this.fail(`cannot set wallpaper: ${errText(e)}`);
      return false;
    }
    for (const d of done) log(`${d.target.label}: wallpaper set ${d.current.file}`);

    // keep screens in the order of the current layout; drop monitors that are gone
    const prev = new Map(this.state.screens.map(s => [s.id, s]));
    for (const d of done) prev.set(d.target.id, { id: d.target.id, label: d.target.label, current: d.current });
    this.state.screens = req.targets.map(t => prev.get(t.id)).filter(Boolean)
      .map(s => ({ ...s!, label: req.targets.find(t => t.id === s!.id)!.label }));
    this.state.current = this.state.screens[0]?.current ?? done[0].current;
    this.state.lastChange = Date.now();
    this.state.lastProfile = req.profile;

    if (cfg.lockScreen && this.state.current) {
      try {
        await setLockScreen(this.state.current.file);
        log(`lock screen set: ${this.state.current.name}`);
      } catch (e) {
        log(`warning: cannot set lock screen: ${errText(e)}`);
      }
    }
    return true;
  }

  private async useCache(req: ChangeRequest, targets: Target[], why: string): Promise<void> {
    const inUse = new Set(this.state.screens.map(s => s.current.file));
    const files = this.cachedFiles().filter(f => !inUse.has(f)).sort(() => Math.random() - 0.5);
    if (!files.length) { this.fail(`${why} - cache is empty, keeping current wallpaper`); return; }
    log(`${why} - using the offline cache (${files.length} files)`);
    const done = targets.slice(0, files.length).map((target, i) => {
      const file = files[i];
      const id = path.basename(file, path.extname(file));
      return { target, current: { id: /^[0-9a-f-]{36}$/.test(id) ? id : null, name: path.basename(file), file, url: null, offline: true, at: Date.now() } };
    });
    if (await this.apply(req, done)) {
      this.state.lastError = why;
      this.saveState();
    }
  }

  private fail(msg: string): void {
    log(`ERROR: ${msg}`);
    this.state.lastError = msg;
    this.saveState();
  }

  cachedFiles(): string[] {
    return fs.readdirSync(this.cacheDir)
      .filter(f => IMAGE_EXT.has(path.extname(f).toLowerCase()))
      .map(f => path.join(this.cacheDir, f));
  }

  private trimCache(keep: number): void {
    const inUse = new Set(this.state.screens.map(s => s.current.file));
    const files = this.cachedFiles()
      .map(f => ({ f, t: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) {
      if (!inUse.has(f)) try { fs.unlinkSync(f); } catch { /* in use */ }
    }
  }

  removeFromCache(id: string): void {
    const inUse = new Set(this.state.screens.map(s => s.current.file));
    for (const f of this.cachedFiles()) {
      if (path.basename(f).startsWith(id) && !inUse.has(f)) try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
}
