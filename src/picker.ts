// Filtering and selection logic (port of Set-ImmichWallpaper.ps1).
import type { Config, Orientation } from './config';
import type { Asset, ImmichClient, SearchFilter } from './immich';

export type ConcreteOrientation = Exclude<Orientation, 'auto'>;

export function resolveOrientation(o: Orientation, screen: { width: number; height: number }): ConcreteOrientation {
  if (o !== 'auto') return o;
  return screen.width >= screen.height ? 'landscape' : 'portrait';
}

/** Width/height as displayed. Immich returns them already rotated by EXIF orientation. */
export function dims(a: Asset): [number, number] {
  if (a.width && a.height) return [a.width, a.height];
  const w = a.exifInfo?.exifImageWidth ?? 0;
  const h = a.exifInfo?.exifImageHeight ?? 0;
  return ['5', '6', '7', '8'].includes(String(a.exifInfo?.orientation)) ? [h, w] : [w, h];
}

export function rejectReason(a: Asset, cfg: Config, o: ConcreteOrientation, blocked: Set<string>): string | null {
  if (a.isTrashed) return 'trashed';
  if (blocked.has(a.id)) return 'blocked/in use';
  const [w, h] = dims(a);
  if (!w || !h) return 'no size info';
  const ratio = w / h;
  if (o === 'landscape' && ratio <= 1.05) return 'orientation';
  if (o === 'portrait' && ratio >= 0.95) return 'orientation';
  if (o === 'square' && (ratio < 0.95 || ratio > 1.05)) return 'orientation';
  // long side vs long side, so one min pair works for any orientation
  const long = Math.max(w, h), short = Math.min(w, h);
  if (long < Math.max(cfg.minWidth, cfg.minHeight) || short < Math.min(cfg.minWidth, cfg.minHeight)) return 'too small';
  if (cfg.minAspect > 0 && ratio < cfg.minAspect) return 'aspect';
  if (cfg.maxAspect > 0 && ratio > cfg.maxAspect) return 'aspect';
  return null;
}

export function buildFilter(cfg: Config): SearchFilter {
  const f: SearchFilter = { type: 'IMAGE', withExif: true };
  if (cfg.tags.length) f.tagIds = cfg.tags.map(t => t.id);
  if (cfg.albums.length) f.albumIds = cfg.albums.map(t => t.id);
  if (cfg.people.length) f.personIds = cfg.people.map(t => t.id);
  if (cfg.favoritesOnly) f.isFavorite = true;
  return f;
}

export function describeFilters(cfg: Config, o: ConcreteOrientation): string {
  const d = [`orientation=${o}`, `min=${cfg.minWidth}x${cfg.minHeight}`];
  if (cfg.tags.length) d.push(`tags=${cfg.tags.map(t => t.name).join('|')}`);
  if (cfg.albums.length) d.push(`albums=${cfg.albums.map(t => t.name).join('|')}`);
  if (cfg.people.length) d.push(`people=${cfg.people.map(t => t.name).join('|')}`);
  if (cfg.favoritesOnly) d.push('favorites');
  if (cfg.smartQuery) d.push(`smart='${cfg.smartQuery}' top ${cfg.smartTop}`);
  return d.join(', ');
}

export interface Batch {
  fetched: Asset[];
  pass: Asset[];
  rejected: Record<string, number>;
  /** true when the server returned everything that matches (no point fetching more) */
  complete: boolean;
  smart: boolean;
}

export function summarize(rejected: Record<string, number>): string {
  const s = Object.entries(rejected).sort().map(([k, v]) => `${k}=${v}`).join(', ');
  return s || 'none';
}

/** One batch of candidates: a random sample, or the top N of a smart search (ranked). */
export async function fetchBatch(client: ImmichClient, cfg: Config, o: ConcreteOrientation, blocked: Set<string>): Promise<Batch> {
  const filter = buildFilter(cfg);
  let fetched: Asset[] = [];
  let complete: boolean;
  if (cfg.smartQuery) {
    let page: number | null = 1;
    while (page && fetched.length < cfg.smartTop) {
      const res = await client.smart(filter, cfg.smartQuery, page, Math.min(100, cfg.smartTop - fetched.length));
      fetched.push(...res.assets.items);
      page = res.assets.nextPage ? Number(res.assets.nextPage) : null;
    }
    complete = true;
  } else {
    fetched = await client.random(filter, cfg.batchSize);
    complete = fetched.length < cfg.batchSize;
  }
  const pass: Asset[] = [];
  const rejected: Record<string, number> = {};
  for (const a of fetched) {
    const r = rejectReason(a, cfg, o, blocked);
    if (r) rejected[r] = (rejected[r] ?? 0) + 1; else pass.push(a);
  }
  return { fetched, pass, rejected, complete, smart: !!cfg.smartQuery };
}

export interface Pick { asset: Asset; rank?: number; newRound: boolean }

export async function pickAsset(
  client: ImmichClient, cfg: Config, o: ConcreteOrientation,
  history: string[], blocked: Set<string>, log: (m: string) => void,
): Promise<Pick | null> {
  const seen = new Set(history);
  const pool = new Map<string, Asset>();
  for (let i = 1; i <= 3; i++) {
    const b = await fetchBatch(client, cfg, o, blocked);
    b.pass.forEach(a => pool.set(a.id, a));
    const fresh = b.pass.filter(a => !seen.has(a.id));
    log(`${b.smart ? 'smart search' : `random batch ${i}`}: got ${b.fetched.length}, rejected: ${summarize(b.rejected)}, pass ${b.pass.length}, not shown recently ${fresh.length}`);
    if (fresh.length) {
      const asset = fresh[Math.floor(Math.random() * fresh.length)];
      return { asset, rank: b.smart ? b.fetched.indexOf(asset) + 1 : undefined, newRound: false };
    }
    if (b.complete) break;
  }
  if (!pool.size) return null;
  const all = [...pool.values()];
  log(`all ${all.length} matching photos were shown recently - starting a new round`);
  return { asset: all[Math.floor(Math.random() * all.length)], newRound: true };
}
