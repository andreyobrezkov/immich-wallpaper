import fs from 'node:fs';
import path from 'node:path';

let file = '';
const recent: string[] = [];
const listeners = new Set<(line: string) => void>();

/** Called with every new log line (used to stream the log into the settings window). */
export function onLogLine(fn: (line: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const MAX_BYTES = 512 * 1024;

export function initLog(dir: string): void {
  file = path.join(dir, 'wallpaper.log');
  try {
    if (fs.statSync(file).size > MAX_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-300);
      fs.writeFileSync(file, lines.join('\n'));
    }
  } catch { /* no log yet */ }
}

const pad = (n: number) => String(n).padStart(2, '0');

export function log(msg: string): void {
  const d = new Date();
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const line = `${ts} ${msg}`;
  console.log(line);
  recent.push(line);
  if (recent.length > 300) recent.shift();
  if (file) try { fs.appendFileSync(file, line + '\n'); } catch { /* ignore */ }
  for (const fn of listeners) try { fn(line); } catch { /* a closed window must not break logging */ }
}

export const logFile = () => file;
export const recentLog = () => recent.slice();
