// Map editor model (cursor, brush, protected cells) and the localStorage map store.
import { Grid } from './grid.js';
import { MODES, UNIT, TILE } from './config.js';
import { cellsAt } from './units.js';

export const TOOLS = ['brick', 'steel', 'water', 'bush', 'ice', 'erase', 'start', 'spawn'];
export const MAX_MAPS = 50;
export const STORE_KEY = 'tank.maps.v1';

function emptyMap(mode) {
  const [tw, th] = MODES[mode].tiles;
  const rows = Array.from({ length: th }, () => '.'.repeat(tw)).map(r => [...r]);
  if (mode === 'coop') { rows[12][6] = 'E'; }
  else { rows[6][0] = 'E'; rows[6][tw - 1] = 'E'; }
  return rows.map(r => r.join('')).join('\n');
}

export class EditorModel {
  constructor(mode = 'coop', grid = null) {
    this.mode = mode;
    this.grid = grid || Grid.parse(emptyMap(mode), mode);
    if (!grid) this.grid.buildFortress(false);
    this.cursor = { cx: Math.floor(this.grid.cols / 2), cy: Math.floor(this.grid.rows / 2) };
    this.brush = 'half';
    this.tool = 'brick';
    const m = MODES[mode];
    // player starts and enemy spawns (tile coords) are part of the map; the 'start' tool alternates P1/P2,
    // the 'spawn' tool replaces the oldest of the three
    this.starts = (this.grid.starts || m.starts).map(t => [...t]);
    this.spawns = (this.grid.spawns || m.spawns).map(t => [...t]);
    this.startNext = 0; this.spawnOrder = this.spawns.map((_, i) => i);
    this.markVersion = 0;
  }

  // base cells and the current start/spawn tiles can't be painted
  get protected() {
    const s = new Set();
    for (const [tx, ty] of [...this.spawns, ...this.starts]) for (const [cx, cy] of cellsAt(tx * TILE + TILE / 2, ty * TILE + TILE / 2, UNIT, UNIT)) s.add(`${cx},${cy}`);
    for (const b of this.grid.bases) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) s.add(`${b.cx + dx},${b.cy + dy}`);
    return s;
  }

  // put a marker on the tile under (cx, cy); the tile is cleared of terrain so a unit can appear there
  placeMarker(cx, cy) {
    const tx = cx >> 1, ty = cy >> 1;
    const base = this.grid.bases.some(b => (b.cx >> 1) === tx && (b.cy >> 1) === ty);
    if (base || !this.grid.inside(cx, cy)) return false;
    const taken = [...this.starts, ...this.spawns].some(([x, y]) => x === tx && y === ty);
    if (taken) return false;
    if (this.tool === 'start') { this.starts[this.startNext] = [tx, ty]; this.startNext ^= 1; }
    else { const i = this.spawnOrder.shift(); this.spawns[i] = [tx, ty]; this.spawnOrder.push(i); }
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) this.grid.set(tx * 2 + dx, ty * 2 + dy, null);
    this.markVersion++; this.version = (this.version || 0) + 1;
    return true;
  }

  static fromDef(def) {
    const bases = Grid.parse(emptyMap(def.mode), def.mode).bases;
    return new EditorModel(def.mode, Grid.parseHalf(def.tiles, bases, def));
  }

  isProtected(cx, cy) { return this.protected.has(`${cx},${cy}`); }

  cellsUnderBrush(cx = this.cursor.cx, cy = this.cursor.cy) {
    if (this.brush === 'tile') { const x = cx & ~1, y = cy & ~1; return [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]; }
    return [[cx, cy]];
  }

  paint(cx = this.cursor.cx, cy = this.cursor.cy) {
    if (this.tool === 'start' || this.tool === 'spawn') return this.placeMarker(cx, cy);
    let changed = false;
    const prot = this.protected;
    for (const [x, y] of this.cellsUnderBrush(cx, cy)) {
      if (!this.grid.inside(x, y) || prot.has(`${x},${y}`)) continue;
      const v = this.tool === 'erase' ? null : this.tool;
      if (this.grid.cellAt(x, y) !== v) { this.grid.set(x, y, v); changed = true; }
    }
    if (changed) this.version = (this.version || 0) + 1;
    return changed;
  }

  move(dir) {
    const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
    if (!d) return;
    this.cursor.cx = Math.max(0, Math.min(this.grid.cols - 1, this.cursor.cx + d[0]));
    this.cursor.cy = Math.max(0, Math.min(this.grid.rows - 1, this.cursor.cy + d[1]));
  }

  nextTool() { this.tool = TOOLS[(TOOLS.indexOf(this.tool) + 1) % TOOLS.length]; }
  toggleBrush() { this.brush = this.brush === 'tile' ? 'half' : 'tile'; }

  toDef(name = '') { return { mode: this.mode, name, tiles: this.grid.serialize(), starts: this.starts.map(t => [...t]), spawns: this.spawns.map(t => [...t]) }; }
}

export class MapStore {
  constructor(storage = (() => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } })()) {
    this.storage = storage;
    this.cache = null;
  }

  read() {
    if (this.cache) return this.cache;
    try { this.cache = JSON.parse(this.storage?.getItem(STORE_KEY) || '[]'); } catch { this.cache = []; }
    if (!Array.isArray(this.cache)) this.cache = [];
    return this.cache;
  }

  write(list) {
    this.cache = list;
    try { this.storage?.setItem(STORE_KEY, JSON.stringify(list)); } catch { /* storage unavailable: keep the in-memory copy */ }
  }

  list() { return this.read().map(m => ({ ...m })); }
  get(id) { const m = this.read().find(m => m.id === id); return m ? { ...m } : null; }

  // def: { id?, name, mode, tiles } → id
  save(def) {
    const list = this.read().slice();
    const i = def.id ? list.findIndex(m => m.id === def.id) : -1;
    const now = Date.now();
    if (i >= 0) list[i] = { ...list[i], ...def, updatedAt: now };
    else {
      if (list.length >= MAX_MAPS) throw new Error(`맵은 최대 ${MAX_MAPS}개까지 저장할 수 있습니다`);
      def = { ...def, id: def.id || `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: now, updatedAt: now };
      list.push(def);
    }
    this.write(list);
    return (i >= 0 ? list[i] : def).id;
  }

  remove(id) { this.write(this.read().filter(m => m.id !== id)); }
  rename(id, name) { this.write(this.read().map(m => m.id === id ? { ...m, name, updatedAt: Date.now() } : m)); }
  duplicate(id) {
    const m = this.get(id);
    if (!m) return null;
    const { id: _, createdAt, updatedAt, ...rest } = m;
    return this.save({ ...rest, name: `${m.name} 복사` });
  }
}
