// Settings window script (runs in the sandboxed renderer; talks to main only through window.api).

interface NamedItem { id: string; name: string; count?: number }
interface SettingsData {
  cfg: Record<string, any>;
  hasKey: boolean; keyHint: string;
  about: { version: string; homepage: string; description: string; electron: string; logFile: string };
  screen: { width: number; height: number }; orientation: string;
  monitors: { label: string; orientation: string }[];
  activeProfile: string | null;
  screens: { id: string | null; label: string; current: { id: string | null; name: string; offline?: boolean; at: number } }[];
  packaged: boolean; dataDir: string;
  current: { id: string | null; name: string; offline?: boolean; at: number } | null;
  lastError: string | null; blockedCount: number; historyCount: number;
}
interface Api {
  load(): Promise<SettingsData>;
  save(cfg: unknown, key: string | null): Promise<boolean>;
  check(server: string, key: string | null): Promise<{ ok: boolean; version?: string; perms?: string[] | null; error?: string }>;
  lists(server: string, key: string | null): Promise<{ tags: NamedItem[]; albums: NamedItem[]; people: NamedItem[]; errors: string[] }>;
  preview(cfg: unknown, key: string | null): Promise<any>;
  next(): Promise<void>;
  openExternal(url: string): Promise<void>;
  log(): Promise<string[]>;
  clearBlocked(): Promise<boolean>;
  onLogLine(fn: (line: string) => void): void;
  onStateChanged(fn: () => void): void;
}
interface Window { api: Api }

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;
const NUM_FIELDS = ['smartTop', 'minWidth', 'minHeight', 'minAspect', 'maxAspect', 'intervalMinutes', 'historySize', 'cacheSize'];
const TEXT_FIELDS = ['server', 'orientation', 'style', 'quality'];
const BOOL_FIELDS = ['autostart', 'perMonitor', 'lockScreen'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** A filter set being edited: index 0 is Default (no schedule), the rest become cfg.profiles. */
interface EditSet {
  name: string; enabled: boolean; days: number[]; from: string; to: string;
  tags: NamedItem[]; albums: NamedItem[]; people: NamedItem[]; favoritesOnly: boolean; smartQuery: string;
}
let sets: EditSet[] = [];
let curSet = 0;
const NEEDED_PERMS = ['asset.read', 'asset.view', 'tag.read', 'album.read', 'person.read', 'asset.download'];

let data: SettingsData;
let dirty = false;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function setStatus(el: HTMLElement, text: string, cls = '') {
  el.textContent = text;
  el.className = 'status ' + cls;
}

// ---------- chip picker ----------
class Picker {
  selected: NamedItem[] = [];
  options: NamedItem[] = [];
  private chips: HTMLDivElement;
  private input: HTMLInputElement;
  private drop: HTMLDivElement;
  private active = 0;

  constructor(host: HTMLElement, placeholder: string) {
    this.chips = document.createElement('div'); this.chips.className = 'chips';
    this.input = document.createElement('input'); this.input.type = 'text'; this.input.placeholder = placeholder;
    this.input.dataset.ph = placeholder;
    this.drop = document.createElement('div'); this.drop.className = 'dropdown'; this.drop.hidden = true;
    host.append(this.chips, this.input, this.drop);
    this.input.addEventListener('input', () => { this.active = 0; this.renderDrop(); });
    this.input.addEventListener('focus', () => this.renderDrop());
    this.input.addEventListener('blur', () => setTimeout(() => { this.drop.hidden = true; }, 150));
    this.input.addEventListener('keydown', e => {
      const m = this.matches();
      if (e.key === 'ArrowDown') { this.active = Math.min(this.active + 1, m.length - 1); this.renderDrop(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { this.active = Math.max(this.active - 1, 0); this.renderDrop(); e.preventDefault(); }
      if (e.key === 'Enter' && m[this.active]) { this.add(m[this.active]); e.preventDefault(); }
      if (e.key === 'Escape') this.drop.hidden = true;
      if (e.key === 'Backspace' && !this.input.value && this.selected.length) this.remove(this.selected[this.selected.length - 1].id);
    });
  }

  set(sel: NamedItem[]) { this.selected = sel.map(({ id, name }) => ({ id, name })); this.renderChips(); }
  get value(): NamedItem[] { return this.selected.map(({ id, name }) => ({ id, name })); }
  setDisabled(reason: string | null) {
    this.input.disabled = !!reason;
    this.input.placeholder = reason ?? this.input.dataset.ph ?? this.input.placeholder;
  }

  private matches(): NamedItem[] {
    const q = this.input.value.trim().toLowerCase();
    const sel = new Set(this.selected.map(s => s.id));
    return this.options.filter(o => !sel.has(o.id) && (!q || o.name.toLowerCase().includes(q))).slice(0, 50);
  }

  private add(item: NamedItem) {
    this.selected.push({ id: item.id, name: item.name });
    this.input.value = '';
    this.renderChips(); this.renderDrop(); markDirty();
  }

  private remove(id: string) {
    this.selected = this.selected.filter(s => s.id !== id);
    this.renderChips(); markDirty();
  }

  private renderChips() {
    this.chips.innerHTML = '';
    for (const s of this.selected) {
      const c = document.createElement('span'); c.className = 'chip'; c.textContent = s.name;
      const x = document.createElement('button'); x.textContent = '×'; x.title = 'Remove';
      x.onclick = () => this.remove(s.id);
      c.append(x); this.chips.append(c);
    }
  }

  private renderDrop() {
    const m = this.matches();
    this.drop.innerHTML = '';
    if (!m.length || document.activeElement !== this.input) { this.drop.hidden = true; return; }
    m.forEach((o, i) => {
      const d = document.createElement('div');
      if (i === this.active) d.className = 'active';
      d.innerHTML = `<span>${esc(o.name)}</span>${o.count !== undefined ? `<span class="count">${o.count}</span>` : ''}`;
      d.onmousedown = e => { e.preventDefault(); this.add(o); };
      this.drop.append(d);
    });
    this.drop.hidden = false;
  }
}

const pickers = {
  tags: new Picker($('pick-tags'), 'Type to add a tag…'),
  albums: new Picker($('pick-albums'), 'Type to add an album…'),
  people: new Picker($('pick-people'), 'Type to add a person…'),
};

// ---------- filter sets ----------
const filtersOf = (s: EditSet) => ({ tags: s.tags, albums: s.albums, people: s.people, favoritesOnly: s.favoritesOnly, smartQuery: s.smartQuery });

function initSets(cfg: Record<string, any>) {
  sets = [
    { name: 'Default', enabled: true, days: [], from: '00:00', to: '00:00', ...filtersOf(cfg as EditSet) },
    ...(cfg.profiles ?? []).map((p: EditSet) => ({ ...p })),
  ];
  curSet = 0;
  const days = $<HTMLDivElement>('setDays');
  days.innerHTML = '';
  for (const d of DAY_ORDER) {
    const l = document.createElement('label');
    l.innerHTML = `<input type="checkbox" value="${d}"> ${DAY_NAMES[d]}`;
    days.append(l);
  }
  days.querySelectorAll('input').forEach(i => i.addEventListener('change', markDirty));
  loadSet();
}

/** form -> sets[curSet] */
function storeSet() {
  const s = sets[curSet];
  s.tags = pickers.tags.value; s.albums = pickers.albums.value; s.people = pickers.people.value;
  s.favoritesOnly = $('favoritesOnly').checked; s.smartQuery = $('smartQuery').value.trim();
  if (curSet > 0) {
    s.name = $('setName').value.trim() || `Set ${curSet}`;
    s.enabled = $('setEnabled').checked;
    s.from = $('setFrom').value || '00:00'; s.to = $('setTo').value || '00:00';
    s.days = [...$<HTMLDivElement>('setDays').querySelectorAll<HTMLInputElement>('input:checked')].map(i => +i.value);
  }
}

/** sets[curSet] -> form, and refresh the selector */
function loadSet() {
  const s = sets[curSet];
  pickers.tags.set(s.tags); pickers.albums.set(s.albums); pickers.people.set(s.people);
  $('favoritesOnly').checked = s.favoritesOnly; $('smartQuery').value = s.smartQuery;
  const sched = $<HTMLDivElement>('setSchedule');
  sched.hidden = curSet === 0;
  ($<HTMLButtonElement>('setDelete')).disabled = curSet === 0;
  if (curSet > 0) {
    $('setName').value = s.name; $('setEnabled').checked = s.enabled; $('setFrom').value = s.from; $('setTo').value = s.to;
    $<HTMLDivElement>('setDays').querySelectorAll<HTMLInputElement>('input').forEach(i => { i.checked = s.days.includes(+i.value); });
  }
  const sel = $<HTMLSelectElement>('setSelect');
  sel.innerHTML = '';
  sets.forEach((x, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    const when = i === 0 ? 'when no other set matches' : `${x.days.length === 7 ? 'every day' : x.days.map(d => DAY_NAMES[d]).join(' ') || 'no days'}, ${x.from === x.to ? 'all day' : `${x.from}–${x.to}`}${x.enabled ? '' : ', off'}`;
    o.textContent = `${x.name} (${when})${data.activeProfile === x.name || (i === 0 && !data.activeProfile) ? ' • active now' : ''}`;
    sel.append(o);
  });
  sel.value = String(curSet);
}

function switchSet(i: number) { storeSet(); curSet = i; loadSet(); }

function addSet() {
  storeSet();
  sets.push({ name: `Set ${sets.length}`, enabled: true, days: [1, 2, 3, 4, 5], from: '18:00', to: '23:00', ...filtersOf(sets[curSet]),
    tags: [...sets[curSet].tags], albums: [...sets[curSet].albums], people: [...sets[curSet].people] });
  curSet = sets.length - 1;
  loadSet(); markDirty();
  $('setName').focus(); $('setName').select();
}

function deleteSet() {
  if (curSet === 0) return;
  sets.splice(curSet, 1);
  curSet = 0;
  loadSet(); markDirty();
}

// ---------- form <-> config ----------
function fillForm(cfg: Record<string, any>) {
  for (const f of [...NUM_FIELDS, ...TEXT_FIELDS]) $(f).value = String(cfg[f] ?? '');
  for (const f of BOOL_FIELDS) $(f).checked = !!cfg[f];
  initSets(cfg);
}

function readForm(): Record<string, any> {
  storeSet();
  const cfg: Record<string, any> = { ...data.cfg };
  for (const f of NUM_FIELDS) cfg[f] = Number($(f).value) || 0;
  for (const f of TEXT_FIELDS) cfg[f] = $(f).value.trim();
  for (const f of BOOL_FIELDS) cfg[f] = $(f).checked;
  Object.assign(cfg, filtersOf(sets[0]));
  cfg.profiles = sets.slice(1).map(s => ({ ...s }));
  if (cfg.intervalMinutes < 1) cfg.intervalMinutes = 1;
  return cfg;
}

/** Config for the preview: the set being edited applied over the rest of the form. */
function readDraftForPreview(): Record<string, any> {
  const cfg = readForm();
  return { ...cfg, ...filtersOf(sets[curSet]) };
}

const typedKey = () => $('apikey').value.trim() || null;

function markDirty() {
  dirty = true;
  setStatus($('saveStatus'), 'Unsaved changes', 'warn');
}

// ---------- server checks ----------
async function checkConnection() {
  const st = $<HTMLDivElement>('checkStatus');
  const server = $('server').value.trim();
  if (!server) { setStatus(st, 'Enter the server URL', 'err'); return; }
  if (!typedKey() && !data.hasKey) { setStatus(st, 'Enter the API key', 'err'); return; }
  setStatus(st, 'Checking…');
  const r = await window.api.check(server, typedKey());
  const perms = $<HTMLDivElement>('perms');
  perms.innerHTML = '';
  if (!r.ok) { setStatus(st, `Cannot connect: ${r.error}`, 'err'); return; }
  setStatus(st, `Connected to Immich ${r.version}`, 'ok');
  if (r.perms) {
    const all = r.perms.includes('all');
    for (const p of NEEDED_PERMS) {
      const have = all || r.perms.includes(p);
      const s = document.createElement('span');
      s.className = 'perm ' + (have ? 'have' : 'miss');
      s.textContent = (have ? '✓ ' : '✗ ') + p;
      perms.append(s);
    }
  }
  await loadLists();
}

async function loadLists() {
  const server = $('server').value.trim();
  if (!server || (!typedKey() && !data.hasKey)) return;
  const l = await window.api.lists(server, typedKey());
  pickers.tags.options = l.tags; pickers.albums.options = l.albums; pickers.people.options = l.people;
  // "needs permission" only for 403; otherwise show the real reason (server down, timeout…)
  const reason = (what: string, perm: string) => {
    const e = l.errors.find(x => x.startsWith(what) || !/^(tags|albums|people):/.test(x));
    if (!e) return null;
    return /\b403\b/.test(e) ? `needs ${perm} permission` : `cannot load: ${e.replace(/^\w+: /, '')}`;
  };
  pickers.tags.setDisabled(reason('tags', 'tag.read'));
  pickers.albums.setDisabled(reason('albums', 'album.read'));
  pickers.people.setDisabled(reason('people', 'person.read'));
}

// ---------- preview ----------
async function preview() {
  const stats = $<HTMLDivElement>('previewStats');
  const grid = $<HTMLDivElement>('grid');
  stats.textContent = 'Searching…';
  grid.innerHTML = '';
  const r = await window.api.preview(readDraftForPreview(), typedKey());
  if (!r.ok) { stats.innerHTML = `<span class="err">${esc(r.error)}</span>`; return; }
  const what = r.smart ? `top ${r.fetched} smart search results` : r.complete ? `all ${r.fetched} photos matching the server-side filters` : `a random sample of ${r.fetched}`;
  stats.innerHTML = `Filter set <b>${esc(sets[curSet].name)}</b>: checked ${esc(what)} (orientation of monitor 1: ${esc(r.orientation)}). <b>${r.pass} fit</b>; rejected: ${esc(r.rejected)}.` +
    (r.pass > r.items.length ? ` Showing the first ${r.items.length}.` : '');
  if (!r.items.length) { grid.innerHTML = '<div class="empty">Nothing fits. Loosen the filters.</div>'; return; }
  const server = $('server').value.trim().replace(/\/+$/, '');
  for (const it of r.items) {
    const t = document.createElement('div'); t.className = 'tile'; t.title = `${it.name}\n${it.w}×${it.h}`;
    t.innerHTML = `<img loading="lazy" src="immich-thumb://asset/${it.id}" alt=""><span>${esc(it.name)} · ${it.w}×${it.h}</span>`;
    t.onclick = () => window.api.openExternal(`${server}/photos/${it.id}`);
    grid.append(t);
  }
}

// ---------- side tabs ----------
function renderCurrent() {
  const box = $<HTMLDivElement>('currentBox');
  const screens = data.screens?.length ? data.screens : data.current ? [{ id: null, label: 'All monitors', current: data.current }] : [];
  if (!screens.length) { box.innerHTML = '<div class="empty">No wallpaper set yet.</div>'; }
  else {
    box.innerHTML = screens.map(s => {
      const c = s.current;
      const img = c.id ? `<img src="immich-thumb://asset/${c.id}" alt="">` : '';
      return `<div class="current">${img}<div><span class="hint">${esc(s.label)}</span><br><b>${esc(c.name)}</b>${c.offline ? ' (from offline cache)' : ''}<br>
        <span class="hint">set ${esc(new Date(c.at).toLocaleString())}</span></div></div>`;
    }).join('') +
      `<div class="hint">Active filter set: ${esc(data.activeProfile ?? 'Default')}</div>` +
      (data.lastError ? `<div class="warn status">${esc(data.lastError)}</div>` : '');
  }
  $<HTMLSpanElement>('blockedInfo').textContent = ` ${data.blockedCount} photo(s) hidden; ${data.historyCount} in no-repeat history.`;
}

const activeTab = () => document.querySelector<HTMLButtonElement>('.tabs button.active')?.dataset.tab;

/** Log lines, newest first, kept in sync with main through log:line events. */
let logLines: string[] = [];
const MAX_LOG_LINES = 300;

function renderLog() {
  $<HTMLPreElement>('log').textContent = logLines.join('\n') || 'Empty.';
}

async function showTab(name: string) {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll<HTMLDivElement>('.pane').forEach(p => p.classList.toggle('active', p.id === `pane-${name}`));
  if (name === 'log') {
    logLines = (await window.api.log()).slice().reverse();
    renderLog();
  }
  if (name === 'current') { data = await window.api.load(); renderCurrent(); }
}

function onLogLine(line: string) {
  logLines.unshift(line);
  if (logLines.length > MAX_LOG_LINES) logLines.length = MAX_LOG_LINES;
  if (activeTab() === 'log') renderLog();
}

async function onStateChanged() {
  if (activeTab() === 'current') { data = await window.api.load(); renderCurrent(); }
}

function renderAbout() {
  const a = data.about;
  $<HTMLSpanElement>('aboutVersion').textContent = `v${a.version}`;
  $<HTMLDivElement>('aboutDescription').textContent = a.description;
  const link = (id: string, url: string) => {
    const el = $<HTMLAnchorElement>(id);
    el.textContent = url.replace(/^https:\/\//, '');
    el.href = url;
    el.onclick = e => { e.preventDefault(); void window.api.openExternal(url); };
  };
  link('aboutRepo', a.homepage);
  link('aboutReleases', `${a.homepage}/releases`);
  $<HTMLElement>('aboutData').textContent = data.dataDir;
  $<HTMLElement>('aboutElectron').textContent = a.electron;
}

// ---------- save ----------
async function save(changeNow: boolean) {
  const cfg = readForm();
  if (!cfg.server) { setStatus($('saveStatus'), 'Server URL is required', 'err'); return; }
  await window.api.save(cfg, typedKey());
  dirty = false;
  if (typedKey()) { $('apikey').value = ''; }
  data = await window.api.load();
  $('apikey').placeholder = data.hasKey ? `saved (${data.keyHint}) — type to replace` : 'paste the API key';
  setStatus($('saveStatus'), changeNow ? 'Saved, changing…' : 'Saved', 'ok');
  if (changeNow) {
    await window.api.next();
    data = await window.api.load();
    setStatus($('saveStatus'), data.lastError ? `Saved; ${data.lastError}` : 'Saved, wallpaper changed', data.lastError ? 'warn' : 'ok');
    renderCurrent();
  }
}

// ---------- init ----------
async function init() {
  data = await window.api.load();
  fillForm(data.cfg);
  $('apikey').placeholder = data.hasKey ? `saved (${data.keyHint}) — type to replace` : 'paste the API key';
  const mons = data.monitors.length ? data.monitors.map(m => `${m.label} (auto = ${m.orientation})`).join('; ') : `Primary screen ${data.screen.width}×${data.screen.height}`;
  $<HTMLDivElement>('screenHint').textContent = `${mons}. Min size is compared long side to long side, in real pixels.`;
  $<HTMLDivElement>('autostartHint').textContent = data.packaged ? '' : 'Takes effect only in the built app (npm run dist), not in dev mode.';
  renderCurrent();
  renderAbout();

  document.querySelectorAll('input, select').forEach(el => el.addEventListener('change', markDirty));
  $<HTMLSelectElement>('setSelect').onchange = e => switchSet(+(e.target as HTMLSelectElement).value);
  $('setAdd').onclick = addSet;
  $('setDelete').onclick = deleteSet;
  for (const id of ['setName', 'setEnabled', 'setFrom', 'setTo']) $(id).addEventListener('change', () => { storeSet(); loadSet(); });
  $<HTMLDivElement>('setDays').addEventListener('change', () => { storeSet(); loadSet(); });
  $('check').onclick = () => void checkConnection();
  $('preview').onclick = () => void preview();
  $('save').onclick = () => void save(false);
  $('saveNext').onclick = () => void save(true);
  $('blockedClear').onclick = async () => { await window.api.clearBlocked(); data = await window.api.load(); renderCurrent(); };
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach(b => { b.onclick = () => void showTab(b.dataset.tab!); });
  window.api.onLogLine(onLogLine);
  window.api.onStateChanged(() => void onStateChanged());

  if (data.hasKey && data.cfg.server) { void loadLists(); void preview(); }
  else setStatus($<HTMLDivElement>('checkStatus'), 'Enter the server URL and API key, then check the connection.', 'warn');
}

void init();
