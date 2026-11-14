// Minimal Immich REST client (tested against Immich 3.4).

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Errors worth retrying: connection refused, DNS, timeouts, 5xx. Not bad keys or missing permissions. */
export function isTransient(e: unknown): boolean {
  return !(e instanceof HttpError) || e.status >= 500;
}

export interface Asset {
  id: string;
  originalFileName: string;
  originalMimeType?: string;
  localDateTime?: string;
  isTrashed?: boolean;
  width?: number | null;
  height?: number | null;
  exifInfo?: { exifImageWidth?: number | null; exifImageHeight?: number | null; orientation?: string | null };
}

export interface SearchFilter {
  type: 'IMAGE';
  withExif: boolean;
  tagIds?: string[];
  albumIds?: string[];
  personIds?: string[];
  isFavorite?: boolean;
}

export class ImmichClient {
  constructor(public readonly server: string, private readonly key: string) {}

  get base(): string { return this.server.replace(/\/+$/, '') + '/api'; }

  photoUrl(id: string): string { return `${this.server.replace(/\/+$/, '')}/photos/${id}`; }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'x-api-key': this.key, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(this.base + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw await toHttpError(r);
    return (await r.json()) as T;
  }

  version() { return this.req<{ major: number; minor: number; patch: number }>('GET', '/server/version'); }
  /** Permissions of the API key itself (Immich 1.130+). */
  keyInfo() { return this.req<{ name: string; permissions: string[] }>('GET', '/api-keys/me'); }
  tags() { return this.req<{ id: string; name: string; value: string }[]>('GET', '/tags'); }
  albums() { return this.req<{ id: string; albumName: string; assetCount: number }[]>('GET', '/albums'); }
  async people() {
    const r = await this.req<{ people: { id: string; name: string }[] }>('GET', '/people?size=1000&withHidden=true');
    return r.people.filter(p => p.name);
  }

  random(filter: SearchFilter, size: number) {
    return this.req<Asset[]>('POST', '/search/random', { ...filter, size });
  }

  smart(filter: SearchFilter, query: string, page: number, size: number) {
    return this.req<{ assets: { items: Asset[]; nextPage: string | null } }>('POST', '/search/smart', { ...filter, query, page, size });
  }

  /** The original file as uploaded (needs asset.download). */
  original(id: string): Promise<{ buf: Buffer; type: string }> {
    return this.fetchBinary(`${this.base}/assets/${id}/original`, 300_000);
  }

  image(id: string, size: 'fullsize' | 'preview' | 'thumbnail', timeoutMs = 120_000): Promise<{ buf: Buffer; type: string }> {
    return this.fetchBinary(`${this.base}/assets/${id}/thumbnail?size=${size}`, timeoutMs);
  }

  private async fetchBinary(url: string, timeoutMs: number): Promise<{ buf: Buffer; type: string }> {
    const r = await fetch(url, {
      headers: { 'x-api-key': this.key }, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw await toHttpError(r);
    return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') ?? '' };
  }
}

async function toHttpError(r: Response): Promise<HttpError> {
  let msg = r.statusText;
  try { msg = ((await r.json()) as { message?: string }).message ?? msg; } catch { /* not json */ }
  return new HttpError(r.status, `${r.status} ${msg}`);
}

export function errText(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause;
    if (e.name === 'TimeoutError') return 'timeout';
    return cause?.code ?? cause?.message ?? e.message;
  }
  return String(e);
}
