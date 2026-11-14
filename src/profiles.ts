// Time-based filter sets: which one is active now, and when that can change next.
import { Config, FILTER_KEYS, Profile } from './config';

const minutes = (hhmm: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : 0;
};

export function isActive(p: Profile, now: Date): boolean {
  if (!p.enabled || !p.days.length) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  const from = minutes(p.from), to = minutes(p.to);
  const day = now.getDay();
  if (from === to) return p.days.includes(day);                 // whole day
  if (from < to) return p.days.includes(day) && t >= from && t < to;
  // overnight: the evening part belongs to today, the morning part to the day before
  if (t >= from) return p.days.includes(day);
  if (t < to) return p.days.includes((day + 6) % 7);
  return false;
}

/** First enabled profile whose window contains `now`; null = the default filters. */
export function activeProfile(cfg: Config, now = new Date()): Profile | null {
  return cfg.profiles.find(p => isActive(p, now)) ?? null;
}

/** Config with the profile's filters applied. */
export function effectiveConfig(cfg: Config, p: Profile | null): Config {
  if (!p) return cfg;
  const out = { ...cfg };
  for (const k of FILTER_KEYS) (out as Record<string, unknown>)[k] = p[k];
  return out;
}

/** Next moment (ms) when some profile starts or ends, within 8 days; null if there are no profiles. */
export function nextBoundary(cfg: Config, now = new Date()): number | null {
  let best: number | null = null;
  for (const p of cfg.profiles) {
    if (!p.enabled || !p.days.length) continue;
    for (const hhmm of [p.from, p.to]) {
      const m = minutes(hhmm);
      for (let d = 0; d <= 8; d++) {
        const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, Math.floor(m / 60), m % 60, 0, 0).getTime();
        if (t > now.getTime()) { if (best === null || t < best) best = t; break; }
      }
    }
  }
  return best;
}
