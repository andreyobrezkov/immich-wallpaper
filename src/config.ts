import fs from 'node:fs';
import path from 'node:path';
import type { WallpaperStyle } from './win32';

export interface Named { id: string; name: string }
export type Orientation = 'auto' | 'landscape' | 'portrait' | 'square' | 'any';

/** The "which photos" part of the settings; the default set lives in Config, others in profiles. */
export interface FilterSet {
  tags: Named[];
  albums: Named[];
  people: Named[];
  favoritesOnly: boolean;
  smartQuery: string;
}

/** A filter set that is active on given days within a time window (to < from means overnight). */
export interface Profile extends FilterSet {
  name: string;
  enabled: boolean;
  days: number[];   // 0 = Sunday ... 6 = Saturday
  from: string;     // "HH:MM"
  to: string;       // "HH:MM"
}

export const FILTER_KEYS = ['tags', 'albums', 'people', 'favoritesOnly', 'smartQuery'] as const;

export interface Config extends FilterSet {
  server: string;
  profiles: Profile[];
  perMonitor: boolean;
  lockScreen: boolean;
  smartTop: number;
  orientation: Orientation;
  minWidth: number;
  minHeight: number;
  minAspect: number;
  maxAspect: number;
  quality: 'fullsize' | 'preview';
  style: WallpaperStyle;
  intervalMinutes: number;
  batchSize: number;
  historySize: number;
  cacheSize: number;
  retries: number;
  retryDelaySec: number;
  autostart: boolean;
  paused: boolean;
}

export const DEFAULTS: Config = {
  server: 'http://localhost:2283',
  tags: [], albums: [], people: [],
  favoritesOnly: false, smartQuery: '', smartTop: 100,
  profiles: [], perMonitor: true, lockScreen: false,
  orientation: 'auto', minWidth: 1920, minHeight: 1080, minAspect: 0, maxAspect: 0,
  quality: 'fullsize', style: 'fill', intervalMinutes: 60,
  batchSize: 200, historySize: 500, cacheSize: 30, retries: 3, retryDelaySec: 20,
  autostart: true, paused: false,
};

const fileOf = (dir: string) => path.join(dir, 'config.json');

export function loadConfig(dir: string): Config {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(fileOf(dir), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function configExists(dir: string): boolean {
  return fs.existsSync(fileOf(dir));
}

export function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function saveConfig(dir: string, cfg: Config): void {
  writeJsonAtomic(fileOf(dir), cfg);
}
