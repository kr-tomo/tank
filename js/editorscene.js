// Phaser scene for the map editor: draws the model's grid with the theme tiles, the cursor, the
// protected cells and the spawn/start markers. Painting by pointer is wired in main.js (it calls
// model.paint directly); this scene reads the model every frame.
import * as Phaser from '../vendor/phaser-4.2.1.esm.min.js';
import { U, TILE, UNIT, MODES } from './config.js';
import { HUD_SIDE, HUD_TOP } from './layout.js';
import { loadSheets } from './stage.js';

const REPEAT_DELAY = 0.28, REPEAT_RATE = 0.09;
const hex = s => parseInt(s.slice(1), 16);

export class EditorScene extends Phaser.Scene {
  constructor() { super('editor'); }

  // data: { model, theme, view, readInputs(), onAction(name) }
  init(data) {
    Object.assign(this, { model: data.model, theme: data.theme, view: data.view, readInputs: data.readInputs, onAction: data.onAction || (() => {}) });
    this.ready = false; this.version = -1; this.held = {}; this.prev = {}; this.t = 0; this.waterPhase = 0;
  }

  create() {
    this.cameras.main.setOrigin(0, 0).setBackgroundColor(this.theme.palette.bg);
    this.fitCamera();
    this.scale.on('resize', this.fitCamera, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.fitCamera, this));
    const land = this.view.orientation === 'landscape';
    this.mapX = 0; this.mapY = land ? 0 : HUD_TOP;
    loadSheets(this, this.theme, this.scale.width / this.view.w).then(sheets => {
      if (!this.sys.isActive() && !this.sys.isPaused()) return;
      this.sheets = sheets; this.build(); this.ready = true;
    });
  }

  fitCamera() { this.cameras.main.setSize(this.scale.width, this.scale.height).setZoom(this.scale.width / this.view.w); }

  build() {
    const { grid } = this.model, sh = this.sheets, th = this.theme, m = MODES[this.model.mode];
    const layer = this.add.container(this.mapX, this.mapY);
    const g = this.add.graphics();
    g.fillStyle(hex(th.palette.bg), 1).fillRect(0, 0, grid.width, grid.height);
    g.lineStyle(1, 0xffffff, 0.08);
    for (let x = 0; x <= grid.width; x += U) g.lineBetween(x, 0, x, grid.height);
    for (let y = 0; y <= grid.height; y += U) g.lineBetween(0, y, grid.width, y);
    g.lineStyle(1, 0xffffff, 0.16);
    for (let x = 0; x <= grid.width; x += TILE) g.lineBetween(x, 0, x, grid.height);
    for (let y = 0; y <= grid.height; y += TILE) g.lineBetween(0, y, grid.width, y);
    layer.add(g);
    this.tiles = [];
    for (let cy = 0; cy < grid.rows; cy++) for (let cx = 0; cx < grid.cols; cx++) {
      const img = this.add.image(cx * U, cy * U, sh.tiles.key, 'brick_00').setOrigin(0).setScale(1 / sh.tiles.k).setVisible(false);
      layer.add(img); this.tiles.push(img);
    }
    for (const b of grid.bases) layer.add(this.add.image(b.cx * U + U, b.cy * U + U, sh.base.key, 'alive').setScale(1 / sh.base.k));
    // markers: enemy spawns and player starts, faded
    m.spawns.forEach(([tx, ty]) => layer.add(this.add.image(tx * TILE + TILE / 2, ty * TILE + TILE / 2, sh.units.key, 'basic_0').setScale(1 / sh.units.k).setAlpha(0.35).setAngle(180)));
    m.starts.forEach(([tx, ty], i) => layer.add(this.add.image(tx * TILE + TILE / 2, ty * TILE + TILE / 2, sh.units.key, `p${i + 1}_0`).setScale(1 / sh.units.k).setAlpha(0.35)));
    // protected cells hatch
    const pg = this.add.graphics();
    pg.fillStyle(0xff5a5a, 0.12);
    for (const key of this.model.protected) { const [cx, cy] = key.split(',').map(Number); pg.fillRect(cx * U, cy * U, U, U); }
    layer.add(pg);
    this.cursor = this.add.graphics();
    layer.add(this.cursor);
    // HUD strip: tool name
    const land = this.view.orientation === 'landscape';
    const hr = land ? { x: grid.width, y: 0, w: HUD_SIDE, h: this.view.h } : { x: 0, y: 0, w: this.view.w, h: HUD_TOP };
    const hud = this.add.graphics();
    hud.fillStyle(hex(th.palette.hud), 1).fillRect(hr.x, hr.y, hr.w, hr.h);
    this.toolIcon = this.add.image(0, 0, sh.tiles.key, 'brick').setScale(1 / sh.tiles.k);
    this.toolText = this.add.text(0, 0, '', { fontFamily: '"Apple SD Gothic Neo",system-ui,sans-serif', fontSize: '12px', fontStyle: '800', color: th.palette.text }).setOrigin(0.5, 0).setResolution(3);
    this.brushText = this.add.text(0, 0, '', { fontFamily: '"Apple SD Gothic Neo",system-ui,sans-serif', fontSize: '11px', color: th.palette.text }).setOrigin(0.5, 0).setResolution(3).setAlpha(0.8);
    if (land) { this.toolIcon.setPosition(hr.x + hr.w / 2, 40); this.toolText.setPosition(hr.x + hr.w / 2, 62); this.brushText.setPosition(hr.x + hr.w / 2, 80); }
    else { this.toolIcon.setPosition(40, 32); this.toolText.setPosition(90, 16); this.brushText.setPosition(90, 34); }
    this.refreshTiles();
  }

  refreshTiles() {
    const { grid } = this.model;
    for (let cy = 0; cy < grid.rows; cy++) for (let cx = 0; cx < grid.cols; cx++) {
      const v = grid.cellAt(cx, cy), img = this.tiles[cy * grid.cols + cx];
      if (!v) { img.setVisible(false); continue; }
      img.setFrame(`${v === 'water' ? `water${this.waterPhase}` : v}_${cx & 1}${cy & 1}`).setVisible(true);
    }
    this.version = this.model.version || 0;
  }

  update(time, delta) {
    if (!this.ready) return;
    const dt = Math.min(0.05, delta / 1000), m = this.model;
    this.t += dt;
    // controller: D-pad moves the cursor with auto-repeat; A paints, B erases, Y cycles tools, X toggles the brush
    const inp = this.readInputs()[0] || {};
    for (const d of ['up', 'down', 'left', 'right']) {
      if (!inp[d]) { delete this.held[d]; continue; }
      const h = this.held[d];
      if (h === undefined) { this.held[d] = 0; m.move(d); if (inp.a) m.paint(); if (inp.b) this.erase(); continue; }
      const nh = h + dt; this.held[d] = nh;
      if (nh >= REPEAT_DELAY && Math.floor((nh - REPEAT_DELAY) / REPEAT_RATE) !== Math.floor((h - REPEAT_DELAY) / REPEAT_RATE)) { m.move(d); if (inp.a) m.paint(); if (inp.b) this.erase(); }
    }
    if (inp.a && !this.prev.a) m.paint();
    if (inp.b && !this.prev.b) this.erase();
    if (inp.y && !this.prev.y) { m.nextTool(); this.onAction('tool'); }
    if (inp.x && !this.prev.x) { m.toggleBrush(); this.onAction('brush'); }
    if (inp.start && !this.prev.start) this.onAction('menu');
    Object.assign(this.prev, { a: inp.a, b: inp.b, x: inp.x, y: inp.y, start: inp.start });
    const wp = Math.floor(this.t * 2) % 2;
    if (wp !== this.waterPhase) { this.waterPhase = wp; this.version = -1; }
    if ((m.version || 0) !== this.version) this.refreshTiles();
    // cursor
    const cells = m.cellsUnderBrush();
    const x0 = Math.min(...cells.map(c => c[0])) * U, y0 = Math.min(...cells.map(c => c[1])) * U, s = m.brush === 'tile' ? TILE : U;
    const pulse = 0.6 + 0.4 * Math.sin(this.t * 8);
    this.cursor.clear().lineStyle(2, 0xffffff, pulse).strokeRect(x0 + 1, y0 + 1, s - 2, s - 2).lineStyle(1, 0x000000, 0.6).strokeRect(x0, y0, s, s);
    const names = { brick: '벽돌', steel: '강철', water: '물', bush: '수풀', ice: '얼음', erase: '지우개' };
    this.toolIcon.setFrame(m.tool === 'erase' ? 'ice' : m.tool === 'water' ? 'water0' : m.tool).setAlpha(m.tool === 'erase' ? 0.3 : 1);
    this.toolText.setText(names[m.tool]);
    this.brushText.setText(m.brush === 'tile' ? '큰 붓' : '작은 붓');
  }

  erase() { const t = this.model.tool; this.model.tool = 'erase'; this.model.paint(); this.model.tool = t; }
}
