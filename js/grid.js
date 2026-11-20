// The half-cell grid: terrain, bases, fortress zone. Pure data, no rendering.
import { U, MODES, FORTRESS_TILES } from './config.js';

const CODES = [null, 'brick', 'steel', 'water', 'bush', 'ice'];
const CHARS = { '.': 0, '#': 1, '@': 2, '~': 3, '*': 4, '-': 5 };
const CHAR_OF = ['.', '#', '@', '~', '*', '-'];

export class Grid {
  constructor(cols, rows) {
    this.cols = cols; this.rows = rows;
    this.cells = new Uint8Array(cols * rows);
    this.bases = [];
  }

  // 13 (or 19) × 13 tile text; '.' '#' '@' '~' '*' '-' and 'E' (base, 2×2 half cells kept empty)
  static parse(text, mode = 'coop') {
    const [tw, th] = MODES[mode].tiles;
    const lines = text.trim().split('\n').map(l => l.trim());
    if (lines.length !== th) throw new Error(`map needs ${th} rows, got ${lines.length}`);
    const g = new Grid(tw * 2, th * 2);
    lines.forEach((line, ty) => {
      if (line.length !== tw) throw new Error(`row ${ty} needs ${tw} tiles, got ${line.length}`);
      for (let tx = 0; tx < tw; tx++) {
        const ch = line[tx];
        if (ch === 'E') { g.bases.push({ cx: tx * 2, cy: ty * 2 }); continue; }
        const code = CHARS[ch];
        if (code === undefined) throw new Error(`unknown tile '${ch}' at ${tx},${ty}`);
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) g.cells[(ty * 2 + dy) * g.cols + tx * 2 + dx] = code;
      }
    });
    return g;
  }

  // half-cell text as written by serialize(); bases are passed separately
  static parseHalf(text, bases = []) {
    const lines = text.trim().split('\n');
    const g = new Grid(lines[0].length, lines.length);
    lines.forEach((line, y) => { for (let x = 0; x < g.cols; x++) g.cells[y * g.cols + x] = CHARS[line[x]] ?? 0; });
    g.bases = bases.map(b => ({ ...b }));
    return g;
  }

  serialize() {
    const out = [];
    for (let y = 0; y < this.rows; y++) {
      let s = '';
      for (let x = 0; x < this.cols; x++) s += CHAR_OF[this.cells[y * this.cols + x]];
      out.push(s);
    }
    return out.join('\n');
  }

  inside(cx, cy) { return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows; }
  cellAt(cx, cy) { return this.inside(cx, cy) ? CODES[this.cells[cy * this.cols + cx]] : null; }
  set(cx, cy, v) { if (this.inside(cx, cy)) this.cells[cy * this.cols + cx] = v ? CODES.indexOf(v) : 0; }
  blocksUnit(cx, cy) { const c = this.cellAt(cx, cy); return !this.inside(cx, cy) || c === 'brick' || c === 'steel' || c === 'water'; }
  blocksShot(cx, cy) { const c = this.cellAt(cx, cy); return !this.inside(cx, cy) || c === 'brick' || c === 'steel'; }
  isBase(cx, cy) { return this.bases.some(b => cx >= b.cx && cx <= b.cx + 1 && cy >= b.cy && cy <= b.cy + 1); }

  // the 3×3 tiles around any base
  inFortress(cx, cy) {
    const r = FORTRESS_TILES * 2;
    return this.bases.some(b => cx >= b.cx - r && cx <= b.cx + 1 + r && cy >= b.cy - r && cy <= b.cy + 1 + r);
  }

  // fill the one-tile ring around each base with steel (shovel) or brick (shovel expired)
  buildFortress(steel) {
    const r = FORTRESS_TILES * 2;
    for (const b of this.bases) {
      for (let cy = b.cy - r; cy <= b.cy + 1 + r; cy++) for (let cx = b.cx - r; cx <= b.cx + 1 + r; cx++) {
        if (!this.inside(cx, cy) || this.isBase(cx, cy)) continue;
        this.set(cx, cy, steel ? 'steel' : 'brick');
      }
    }
  }

  get width() { return this.cols * U; }
  get height() { return this.rows * U; }
}
