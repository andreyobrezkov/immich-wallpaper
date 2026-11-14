// Native Windows calls via koffi: wallpaper (user32) and Credential Manager (advapi32).
import koffi from 'koffi';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// ---------- wallpaper ----------
const user32 = koffi.load('user32.dll');
const SystemParametersInfoW = user32.func('__stdcall', 'SystemParametersInfoW', 'bool', ['uint32', 'uint32', 'str16', 'uint32']);
const SPI_SETDESKWALLPAPER = 0x14;
const SPIF_UPDATEINIFILE_SENDCHANGE = 0x3;

export type WallpaperStyle = 'fill' | 'fit' | 'stretch' | 'center' | 'tile' | 'span';
const STYLES: Record<WallpaperStyle, [string, string]> = {
  fill: ['10', '0'], fit: ['6', '0'], stretch: ['2', '0'], center: ['0', '0'], tile: ['0', '1'], span: ['22', '0'],
};

async function regSetDesktop(name: string, value: string): Promise<void> {
  await execFileP('reg', ['add', 'HKCU\\Control Panel\\Desktop', '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true });
}

export async function setWallpaper(file: string, style: WallpaperStyle): Promise<void> {
  const [ws, tile] = STYLES[style] ?? STYLES.fill;
  await regSetDesktop('WallpaperStyle', ws);
  await regSetDesktop('TileWallpaper', tile);
  if (!SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, file, SPIF_UPDATEINIFILE_SENDCHANGE)) {
    throw new Error('SystemParametersInfoW failed');
  }
}

// ---------- Credential Manager ----------
const advapi32 = koffi.load('advapi32.dll');
const FILETIME = koffi.struct('FILETIME', { dwLowDateTime: 'uint32', dwHighDateTime: 'uint32' });
const CREDENTIALW = koffi.struct('CREDENTIALW', {
  Flags: 'uint32',
  Type: 'uint32',
  TargetName: 'str16',
  Comment: 'str16',
  LastWritten: FILETIME,
  CredentialBlobSize: 'uint32',
  CredentialBlob: 'void *',
  Persist: 'uint32',
  AttributeCount: 'uint32',
  Attributes: 'void *',
  TargetAlias: 'str16',
  UserName: 'str16',
});
const CredWriteW = advapi32.func('__stdcall', 'CredWriteW', 'bool', [koffi.pointer(CREDENTIALW), 'uint32']);
const CredReadW = advapi32.func('__stdcall', 'CredReadW', 'bool', ['str16', 'uint32', 'uint32', koffi.out(koffi.pointer('void *'))]);
const CredDeleteW = advapi32.func('__stdcall', 'CredDeleteW', 'bool', ['str16', 'uint32', 'uint32']);
const CredFree = advapi32.func('__stdcall', 'CredFree', 'void', ['void *']);

const CRED_TYPE_GENERIC = 1;
const CRED_PERSIST_LOCAL_MACHINE = 2;
const TARGET = 'immich-wallpaper:api-key';

export function writeApiKey(key: string): void {
  const blob = Buffer.from(key, 'utf16le');
  const ok = CredWriteW({
    Flags: 0, Type: CRED_TYPE_GENERIC, TargetName: TARGET, Comment: 'Immich Wallpaper API key',
    LastWritten: { dwLowDateTime: 0, dwHighDateTime: 0 },
    CredentialBlobSize: blob.length, CredentialBlob: blob, Persist: CRED_PERSIST_LOCAL_MACHINE,
    AttributeCount: 0, Attributes: null, TargetAlias: null, UserName: 'immich-wallpaper',
  }, 0);
  if (!ok) throw new Error('CredWriteW failed');
}

export function readApiKey(): string | null {
  const out: unknown[] = [null];
  if (!CredReadW(TARGET, CRED_TYPE_GENERIC, 0, out)) return null;
  try {
    const cred = koffi.decode(out[0], CREDENTIALW);
    if (!cred.CredentialBlobSize) return '';
    const bytes = koffi.decode(cred.CredentialBlob, 'uint8_t', cred.CredentialBlobSize);
    return Buffer.from(bytes).toString('utf16le');
  } finally {
    CredFree(out[0]);
  }
}

export function deleteApiKey(): void {
  CredDeleteW(TARGET, CRED_TYPE_GENERIC, 0);
}
