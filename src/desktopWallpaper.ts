// IDesktopWallpaper (shobjidl_core.h) through koffi: per-monitor wallpapers.
import koffi from 'koffi';

const ole32 = koffi.load('ole32.dll');
const GUID = koffi.struct('GUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: koffi.array('uint8', 8) });
const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const CoInitializeEx = ole32.func('__stdcall', 'CoInitializeEx', 'int32', ['void *', 'uint32']);
const CoCreateInstance = ole32.func('__stdcall', 'CoCreateInstance', 'int32',
  [koffi.pointer(GUID), 'void *', 'uint32', koffi.pointer(GUID), koffi.out(koffi.pointer('void *'))]);
const CoTaskMemFree = ole32.func('__stdcall', 'CoTaskMemFree', 'void', ['void *']);
// LPWSTR allocated by the callee: decode to a JS string, then CoTaskMemFree it
const ComStr = koffi.disposable('ComStr', 'str16', CoTaskMemFree);

function guid(s: string) {
  const h = s.replace(/[{}-]/g, '');
  return {
    Data1: parseInt(h.slice(0, 8), 16), Data2: parseInt(h.slice(8, 12), 16), Data3: parseInt(h.slice(12, 16), 16),
    Data4: Array.from({ length: 8 }, (_, i) => parseInt(h.slice(16 + i * 2, 18 + i * 2), 16)),
  };
}

const CLSID_DesktopWallpaper = guid('C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD');
const IID_IDesktopWallpaper = guid('B92B56A9-8B55-4E14-9A89-0199BBB6F93B');
const CLSCTX_ALL = 0x17;

// vtable slots (IUnknown takes 0..2)
const P = {
  Release: [2, koffi.proto('__stdcall', 'Release', 'uint32', ['void *'])],
  SetWallpaper: [3, koffi.proto('__stdcall', 'SetWallpaper', 'int32', ['void *', 'str16', 'str16'])],
  GetWallpaper: [4, koffi.proto('__stdcall', 'GetWallpaper', 'int32', ['void *', 'str16', koffi.out(koffi.pointer(ComStr))])],
  GetMonitorDevicePathAt: [5, koffi.proto('__stdcall', 'GetMonitorDevicePathAt', 'int32', ['void *', 'uint32', koffi.out(koffi.pointer(ComStr))])],
  GetMonitorDevicePathCount: [6, koffi.proto('__stdcall', 'GetMonitorDevicePathCount', 'int32', ['void *', koffi.out(koffi.pointer('uint32'))])],
  GetMonitorRECT: [7, koffi.proto('__stdcall', 'GetMonitorRECT', 'int32', ['void *', 'str16', koffi.out(koffi.pointer(RECT))])],
  SetPosition: [10, koffi.proto('__stdcall', 'SetPosition', 'int32', ['void *', 'int32'])],
} as const;

export type Position = 'center' | 'tile' | 'stretch' | 'fit' | 'fill' | 'span';
const POSITION: Record<Position, number> = { center: 0, tile: 1, stretch: 2, fit: 3, fill: 4, span: 5 };

export interface Monitor {
  /** device path, stable across reboots; used as the key for per-monitor state */
  id: string;
  index: number;
  width: number;
  height: number;
  left: number;
  top: number;
  wallpaper: string;
}

const hex = (hr: number) => '0x' + (hr >>> 0).toString(16).padStart(8, '0');

class DesktopWallpaper {
  private constructor(private readonly self: unknown, private readonly vtbl: unknown) {}

  static create(): DesktopWallpaper {
    CoInitializeEx(null, 0x2); // STA; S_FALSE / RPC_E_CHANGED_MODE are fine (Electron already did it)
    const out: unknown[] = [null];
    const hr = CoCreateInstance(CLSID_DesktopWallpaper, null, CLSCTX_ALL, IID_IDesktopWallpaper, out);
    if (hr < 0) throw new Error(`CoCreateInstance(DesktopWallpaper) failed ${hex(hr)}`);
    return new DesktopWallpaper(out[0], koffi.decode(out[0], 'void *'));
  }

  private call<K extends keyof typeof P>(name: K, ...args: unknown[]): number {
    const [slot, proto] = P[name];
    const fn = koffi.decode(this.vtbl, slot * 8, 'void *');
    return koffi.call(fn, proto, this.self, ...args);
  }

  private check(name: keyof typeof P, hr: number) {
    if (hr < 0) throw new Error(`IDesktopWallpaper.${name} failed ${hex(hr)}`);
  }

  monitors(): Monitor[] {
    const count = [0];
    this.check('GetMonitorDevicePathCount', this.call('GetMonitorDevicePathCount', count));
    const res: Monitor[] = [];
    for (let i = 0; i < count[0]; i++) {
      const id = [null as string | null];
      if (this.call('GetMonitorDevicePathAt', i, id) < 0 || !id[0]) continue;
      const rect = [{} as { left: number; top: number; right: number; bottom: number }];
      // fails for monitors that are known but not attached
      if (this.call('GetMonitorRECT', id[0], rect) < 0) continue;
      const r = rect[0];
      const wp = [null as string | null];
      this.call('GetWallpaper', id[0], wp);
      res.push({ id: id[0], index: res.length, width: r.right - r.left, height: r.bottom - r.top, left: r.left, top: r.top, wallpaper: wp[0] ?? '' });
    }
    return res;
  }

  set(monitorId: string | null, file: string): void {
    this.check('SetWallpaper', this.call('SetWallpaper', monitorId, file));
  }

  setPosition(p: Position): void {
    this.check('SetPosition', this.call('SetPosition', POSITION[p] ?? POSITION.fill));
  }

  release(): void { this.call('Release'); }
}

function withDw<T>(f: (dw: DesktopWallpaper) => T): T {
  const dw = DesktopWallpaper.create();
  try { return f(dw); } finally { dw.release(); }
}

/** Active monitors in Windows' order, physical pixels. */
export function listMonitors(): Monitor[] {
  return withDw(dw => dw.monitors());
}

/** Sets one image per monitor (monitor id -> file). */
export function setPerMonitor(files: Map<string, string>, position: Position): void {
  withDw(dw => {
    dw.setPosition(position === 'span' ? 'fill' : position);
    for (const [id, file] of files) dw.set(id, file);
  });
}
