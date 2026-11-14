// Gets a wallpaper-ready JPEG for one asset.
// Full quality comes from the ORIGINAL converted locally, so Immich does not need to keep full-size
// copies of the whole library: only the few photos that pass the filters are ever converted, and they
// are scaled down to the monitor size before caching.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import decodeHeic from 'heic-decode';
import type { Config } from './config';
import { HttpError, ImmichClient, errText, type Asset } from './immich';

export interface Size { width: number; height: number }

const HEIF = /image\/(heic|heif)/i;
/** formats sharp's prebuilt libvips decodes */
const SHARP_NATIVE = /image\/(jpeg|png|webp|avif|tiff|gif)/i;

/** Re-encode only if the picture is noticeably larger than the monitor (or must be converted/rotated anyway). */
const SHRINK_THRESHOLD = 1.25;

interface Result { file: string; note: string }

export async function fetchWallpaperImage(
  client: ImmichClient, cfg: Config, asset: Asset, target: Size | null, cacheDir: string, log: (m: string) => void,
): Promise<string> {
  const file = path.join(cacheDir, `${asset.id}.jpg`);
  const steps: { name: string; run: () => Promise<Result> }[] = [];
  if (cfg.quality === 'fullsize') {
    steps.push({ name: 'original', run: () => fromOriginal(client, asset, target, file) });
    steps.push({ name: 'fullsize', run: () => fromRendition(client, asset.id, 'fullsize', target, file) });
  }
  steps.push({ name: 'preview', run: () => fromRendition(client, asset.id, 'preview', target, file) });

  let lastErr: unknown = null;
  for (const s of steps) {
    try {
      const r = await s.run();
      log(`downloaded ${s.name}: ${r.note}`);
      return r.file;
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError && e.status === 403) {
        log(`${s.name} needs 'asset.download' permission - trying a smaller version`);
        // fullsize needs the same permission, skip straight to preview
        if (s.name === 'original') steps.splice(steps.findIndex(x => x.name === 'fullsize'), 1);
      } else {
        log(`${s.name} failed: ${errText(e)}`);
      }
    }
  }
  throw lastErr ?? new Error('no usable image');
}

async function fromOriginal(client: ImmichClient, asset: Asset, target: Size | null, file: string): Promise<Result> {
  const mime = asset.originalMimeType ?? '';
  if (!HEIF.test(mime) && !SHARP_NATIVE.test(mime)) throw new Error(`cannot convert ${mime || 'unknown format'} locally`);
  const { buf } = await client.original(asset.id);
  const mb = (buf.length / 1048576).toFixed(1);
  // trust the bytes, not the extension: some phones save JPEGs as .heic
  if (isHevcHeif(buf)) {
    // libheif applies the HEIF rotation/mirroring itself, so no EXIF rotation afterwards
    const img = await decodeHeic({ buffer: buf });
    const raw = sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength),
      { raw: { width: img.width, height: img.height, channels: 4 } });
    return encode(raw, { width: img.width, height: img.height }, target, file, `${mime} ${mb} MB ${img.width}x${img.height}`, true);
  }
  const actual = sniffMime(buf) ?? mime;
  return fromBuffer(buf, actual, target, file, `${actual}${actual !== mime ? ` (labelled ${mime})` : ''} ${mb} MB`);
}

/** HEIF container with an HEVC brand (what sharp's prebuilt libvips cannot decode); AVIF is left to sharp. */
function isHevcHeif(buf: Buffer): boolean {
  if (buf.length < 12 || buf.toString('latin1', 4, 8) !== 'ftyp') return false;
  return /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/.test(buf.toString('latin1', 8, 12));
}

function sniffMime(buf: Buffer): string | null {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('latin1', 4, 8) === 'ftyp' && /^avi[fs]$/.test(buf.toString('latin1', 8, 12))) return 'image/avif';
  return null;
}

async function fromRendition(client: ImmichClient, id: string, size: 'fullsize' | 'preview', target: Size | null, file: string): Promise<Result> {
  const { buf, type } = await client.image(id, size);
  if (!SHARP_NATIVE.test(type)) throw new Error(`${type} is not usable as wallpaper`);
  return fromBuffer(buf, type, target, file, type);
}

async function fromBuffer(buf: Buffer, mime: string, target: Size | null, file: string, what: string): Promise<Result> {
  const img = sharp(buf, { failOn: 'none' });
  const meta = await img.metadata();
  const rotated = (meta.orientation ?? 1) >= 5;
  const size = { width: (rotated ? meta.height : meta.width) ?? 0, height: (rotated ? meta.width : meta.height) ?? 0 };
  const needsRotation = (meta.orientation ?? 1) > 1;
  const isJpeg = /jpe?g/i.test(mime) && meta.format === 'jpeg';
  const label = `${what} ${size.width}x${size.height}${needsRotation ? `, EXIF rotation ${meta.orientation}` : ''}`;
  if (isJpeg && !needsRotation && !tooBig(size, target)) {
    fs.writeFileSync(file, buf);
    return { file, note: `${label}, saved as is` };
  }
  // Windows ignores the EXIF orientation flag for wallpapers - bake the rotation into the pixels
  return encode(img.rotate(), size, target, file, label, !isJpeg);
}

function tooBig(size: Size, target: Size | null): boolean {
  if (!target) return false;
  // "outside" fit: the scaled picture still covers the monitor in both directions
  const scale = Math.max(target.width / size.width, target.height / size.height);
  return scale * SHRINK_THRESHOLD < 1;
}

async function encode(img: sharp.Sharp, size: Size, target: Size | null, file: string, label: string, converted: boolean): Promise<Result> {
  let pipeline = img;
  let resized = '';
  if (target && tooBig(size, target)) {
    pipeline = pipeline.resize({ width: target.width, height: target.height, fit: 'outside', withoutEnlargement: true });
    resized = `, scaled for ${target.width}x${target.height}`;
  }
  const info = await pipeline.jpeg({ quality: 90, mozjpeg: true }).toFile(file);
  return { file, note: `${label}${converted ? ', converted' : ''}${resized} -> ${info.width}x${info.height} jpeg ${(info.size / 1048576).toFixed(1)} MB` };
}
