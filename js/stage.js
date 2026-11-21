// Phaser host: owns the WebGL canvas, the sound manager, the play scene and the editor scene.
// Game rules live in world.js; this module reads the world state each frame and draws it, adding
// engine-side effects (particles, camera shake/flash, tweens, sound).
import * as Phaser from '../vendor/phaser-4.2.1.esm.min.js';
import { U, TILE, UNIT, MODES, ENEMY_TYPES, SCORE, ITEM_IDS, LIVES } from './config.js';
import { loadImage, rasterize } from './assets.js';
import { HUD_SIDE, HUD_TOP } from './layout.js';
import { EditorScene } from './editorscene.js';

const STEP = 1 / 120;
const MAX_TEX = 4096;
const FONT = '"Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif';
const MONO = '"Menlo","SF Mono","Courier New",monospace';
const ANGLE = { up: 0, right: 90, down: 180, left: 270 };
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const quant = v => Math.floor(v * 4) / 4;
const hex = s => parseInt(s.slice(1), 16);
export const SFX = ['fire_classic', 'fire_ancient', 'fire_space', 'fire_halloween', 'hit', 'brick', 'steel', 'ricochet', 'explode', 'explodeBig',
  'explode_ancient', 'explode_space', 'explode_halloween', 'spawn', 'item', 'pickup', 'life', 'pause', 'select', 'move', 'stageStart', 'gameOver',
  'win', 'tick', 'shield', 'shovel', 'freeze', 'stun', 'score', 'land', 'beam', 'phase'];

/* ---------- procedural fx textures ---------- */
function canvasTexture(scene, key, w, h, draw) {
  if (scene.textures.exists(key)) return;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  scene.textures.addCanvas(key, c);
}
const radial = stops => (ctx, w, h) => {
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
};
function makeFxTextures(scene) {
  canvasTexture(scene, 'fx-dot', 32, 32, radial([[0, '#fff'], [0.35, 'rgba(255,255,255,.9)'], [1, 'rgba(255,255,255,0)']]));
  canvasTexture(scene, 'fx-puff', 64, 64, radial([[0, 'rgba(255,255,255,.85)'], [0.6, 'rgba(255,255,255,.35)'], [1, 'rgba(255,255,255,0)']]));
  canvasTexture(scene, 'fx-glow', 128, 128, radial([[0, 'rgba(255,255,255,.9)'], [0.4, 'rgba(255,255,255,.35)'], [1, 'rgba(255,255,255,0)']]));
  canvasTexture(scene, 'fx-ring', 96, 96, (ctx, w) => { ctx.strokeStyle = '#fff'; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(w / 2, w / 2, w / 2 - 4, 0, Math.PI * 2); ctx.stroke(); });
  canvasTexture(scene, 'fx-star', 96, 96, (ctx, w) => {
    ctx.fillStyle = '#fff'; ctx.beginPath();
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, r = i % 2 ? 10 : 46; ctx.lineTo(w / 2 + Math.cos(a) * r, w / 2 + Math.sin(a) * r); }
    ctx.closePath(); ctx.fill();
  });
  canvasTexture(scene, 'fx-chip', 10, 8, ctx => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 10, 8); ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, 5, 10, 3); });
  canvasTexture(scene, 'fx-beam', 8, 8, (ctx) => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 8, 8); });
}

/* ---------- scenes ---------- */
class BootScene extends Phaser.Scene {
  constructor() { super('boot'); }
  preload() { for (const n of SFX) this.load.audio(n, `sfx/${n}.wav`); }
  create() { makeFxTextures(this); this.game.events.emit('tank-ready'); }
}

// Rasterizes the theme's SVG sheets at the screen scale and registers frames. Shared by both scenes.
export async function loadSheets(scene, theme, px) {
  const base = theme.base, cell = theme.cell, k0 = clamp(px, 1, 3);
  // SVG sheets rasterize at the screen scale; PNG sheets are already drawn at theme.scales[n] px per logical px
  const sheet = async (url, want, fixed) => {
    const img = await loadImage(url);
    const k = fixed || Math.max(0.5, quant(Math.min(want, MAX_TEX / Math.max(img.naturalWidth, img.naturalHeight))));
    const r = await rasterize(url, fixed ? 1 : k), key = `${url}@${k}`;
    if (!scene.textures.exists(key)) scene.textures.addCanvas(key, r.canvas);
    return { key, k, tex: scene.textures.get(key) };
  };
  const names = Object.keys(theme.sheets);
  const loaded = await Promise.all(names.map(n => sheet(base + theme.sheets[n], k0, theme.scales?.[n])));
  const out = {};
  names.forEach((n, i) => {
    const s = loaded[i], c = cellOf(theme, n);
    s.cell = c;
    const add = (name, x, y, w, h) => { if (!s.tex.has(name)) s.tex.add(name, 0, x * s.k, y * s.k, w * s.k, h * s.k); };
    for (const [name, idx] of Object.entries(theme.frames[n])) {
      const list = Array.isArray(idx) ? idx : [idx];
      list.forEach((i, j) => {
        const fname = Array.isArray(idx) ? `${name}_${j}` : name;
        add(fname, i * c, 0, c, c);
        // tiles also get their four half-cell quadrants
        if (n === 'tiles') for (const qx of [0, 1]) for (const qy of [0, 1]) add(`${name}_${qx}${qy}`, i * c + qx * U, qy * U, U, U);
      });
    }
    out[n] = s;
  });
  return out;
}

// logical cell size of a sheet (units and the base may use bigger cells than the 32px tile)
export const cellOf = (theme, n) => theme.cells?.[n] ?? (n === 'shot' ? theme.shotCell : theme.cell);

class PlayScene extends Phaser.Scene {
  constructor() { super('play'); }

  // data: { world, theme, view: {w, h, orientation}, readInputs(), onPhase(phase), stageName, stageIndex }
  init(data) {
    Object.assign(this, { world: data.world, theme: data.theme, view: data.view, readInputs: data.readInputs, onPhase: data.onPhase || (() => {}), stageName: data.stageName, stageIndex: data.stageIndex ?? 0 });
    this.ready = false; this.acc = 0; this.t = 0; this.gridDirty = true; this.waterPhase = 0; this.tickSoundT = 0;
    this.unitSprites = new Map(); this.shotSprites = new Map(); this.itemSprites = new Map(); this.texts = [];
    this.lastPhase = 'play'; this.curtainT = 0; this.resultShown = false;
    this.beams = []; this.tally = null; this.loadToken = (this.loadToken || 0) + 1;
  }

  create() {
    const cam = this.cameras.main;
    cam.setOrigin(0, 0).setBackgroundColor(this.theme.palette.bg);
    this.fitCamera();
    this.scale.on('resize', this.fitCamera, this);
    this.events.once('shutdown', () => { this.scale.off('resize', this.fitCamera, this); });
    const land = this.view.orientation === 'landscape';
    this.mapX = 0; this.mapY = land ? 0 : HUD_TOP;
    this.hudRect = land ? { x: this.world.grid.width, y: 0, w: HUD_SIDE, h: this.view.h } : { x: 0, y: 0, w: this.view.w, h: HUD_TOP };
    const token = this.loadToken;
    loadSheets(this, this.theme, this.scale.width / this.view.w).then(sheets => {
      if (token !== this.loadToken || (!this.sys.isActive() && !this.sys.isPaused())) return;   // a restart overtook this load
      this.sheets = sheets; this.build(); this.ready = true;
    }).catch(e => window.__fatal?.(`sheets: ${e?.stack || e}`));
  }

  fitCamera() {
    const z = this.scale.width / this.view.w;
    this.cameras.main.setSize(this.scale.width, this.scale.height).setZoom(z);
    for (const t of this.texts) t.setResolution(Math.min(3, z));
  }

  text(x, y, str, size, color = '#fff', extra = {}) {
    const t = this.add.text(x, y, str, { fontFamily: FONT, fontSize: `${size}px`, fontStyle: '800', color, ...extra }).setDepth(50).setResolution(Math.min(3, this.cameras.main.zoom));
    this.texts.push(t);
    return t;
  }

  build() {
    const { grid } = this.world, sh = this.sheets, th = this.theme;
    this.mapLayer = this.add.container(this.mapX, this.mapY).setDepth(1);
    // ground: dark field with a faint grid
    const g = this.add.graphics();
    g.fillStyle(hex(th.palette.bg), 1).fillRect(0, 0, grid.width, grid.height);
    g.lineStyle(1, 0xffffff, 0.035);
    for (let x = 0; x <= grid.width; x += TILE) g.lineBetween(x, 0, x, grid.height);
    for (let y = 0; y <= grid.height; y += TILE) g.lineBetween(0, y, grid.width, y);
    this.mapLayer.add(g);
    // half-cell tiles (floor layer: water/ice; wall layer: brick/steel; canopy: bush above units)
    this.tiles = [];
    for (let cy = 0; cy < grid.rows; cy++) for (let cx = 0; cx < grid.cols; cx++) {
      const img = this.add.image(cx * U, cy * U, sh.tiles.key, 'brick_00').setOrigin(0).setScale(1 / sh.tiles.k).setVisible(false);
      this.mapLayer.add(img);
      this.tiles.push(img);
    }
    // bases
    this.baseSprites = grid.bases.map(b => { const s = this.add.image(b.cx * U + U, b.cy * U + U, sh.base.key, 'alive').setScale(1 / sh.base.k); this.mapLayer.add(s); return s; });
    this.unitLayer = this.add.container(this.mapX, this.mapY).setDepth(5);
    this.shotLayer = this.add.container(this.mapX, this.mapY).setDepth(6);
    this.canopy = this.add.container(this.mapX, this.mapY).setDepth(8);
    this.fxLayer = this.add.container(this.mapX, this.mapY).setDepth(9);
    this.beamGfx = this.add.graphics().setDepth(7); this.shotLayer.add(this.beamGfx);
    this.shadowGfx = this.add.graphics().setDepth(4); this.unitLayer.add(this.shadowGfx);
    this.canopyTiles = new Map();
    const P = (cfg) => { const e = this.add.particles(0, 0, cfg.texture || 'fx-dot', { emitting: false, ...cfg }); this.fxLayer.add(e); return e; };
    const ex = th.palette.explosion.map(hex);
    this.fx = {
      spark: P({ lifespan: { min: 150, max: 400 }, speed: { min: 60, max: 220 }, scale: { start: 0.35, end: 0 }, blendMode: 'ADD', tint: ex }),
      smoke: P({ texture: 'fx-puff', lifespan: { min: 400, max: 900 }, speed: { min: 10, max: 50 }, scale: { start: 0.3, end: 1.1 }, alpha: { start: 0.6, end: 0 }, tint: [ex[3], 0x333333] }),
      chips: P({ texture: 'fx-chip', lifespan: { min: 300, max: 700 }, speed: { min: 60, max: 180 }, scale: { start: 0.9, end: 0.3 }, rotate: { start: 0, end: 360 }, alpha: { start: 1, end: 0 }, tint: [hex(th.palette.brick), 0x7a3a16] }),
      steel: P({ lifespan: { min: 120, max: 260 }, speed: { min: 80, max: 260 }, scale: { start: 0.25, end: 0 }, blendMode: 'ADD', tint: [0xffffff, 0xcfe8ff] }),
      trail: P({ lifespan: 220, speed: { min: 2, max: 12 }, scale: { start: 0.22, end: 0 }, blendMode: 'ADD', alpha: { start: 0.9, end: 0 }, tint: [0xffffff, ex[1]] }),
      glow: P({ texture: 'fx-glow', lifespan: 600, speed: { min: 5, max: 20 }, scale: { start: 0.15, end: 0.5 }, blendMode: 'ADD', alpha: { start: 0.8, end: 0 }, tint: [hex(th.palette.accent)] }),
      wisp: P({ lifespan: { min: 300, max: 700 }, speed: { min: 10, max: 40 }, scale: { start: 0.3, end: 0 }, blendMode: 'ADD', tint: [0xb46bff, 0xffffff] })
    };
    // dim + banner above everything
    this.dim = this.add.rectangle(0, 0, this.view.w, this.view.h, 0x000000).setOrigin(0).setDepth(40).setAlpha(0);
    this.curtains = [0, 1].map(i => this.add.rectangle(0, i ? this.view.h : 0, this.view.w, 0, hex(th.palette.hud)).setOrigin(0, i).setDepth(45));
    // metal shutter slats drawn over the curtains
    this.shutter = this.add.graphics().setDepth(45.5);
    this.banner = this.text(this.view.w / 2, this.view.h / 2, '', 30, th.palette.text, { stroke: '#000', strokeThickness: 5 }).setOrigin(0.5).setDepth(46);
    this.bannerSub = this.text(this.view.w / 2, this.view.h / 2 + 34, '', 16, th.palette.accent, { stroke: '#000', strokeThickness: 4 }).setOrigin(0.5).setDepth(46);
    this.buildHud();
    this.refreshTiles();
    this.curtainT = 1.6;
    this.sfx('stageStart', { volume: 0.5 });
  }

  /* ---------- HUD ---------- */
  buildHud() {
    const { x, y, w, h } = this.hudRect, th = this.theme, sh = this.sheets, land = this.view.orientation === 'landscape';
    this.hudBg = this.add.graphics().setDepth(20);
    this.hudBg.fillStyle(hex(th.palette.hud), 1).fillRect(x, y, w, h);
    this.hudBg.fillStyle(0x000000, 0.25).fillRect(x, y, w, h);
    // bevel: accent line along the map edge, three inset panels (enemies / players / stage)
    const acc = hex(th.palette.accent);
    if (land) {
      this.hudBg.fillStyle(acc, 0.8).fillRect(x, y, 2, h).fillStyle(0xffffff, 0.08).fillRect(x + 2, y, 1, h);
      for (const [py, ph] of [[8, h * 0.5], [h * 0.5 + 16, h * 0.22], [h * 0.74 + 8, h * 0.26 - 16]]) this.hudBg.fillStyle(0x000000, 0.22).fillRoundedRect(x + 8, y + py, w - 14, ph, 4).lineStyle(1, 0xffffff, 0.08).strokeRoundedRect(x + 8, y + py, w - 14, ph, 4);
    } else {
      this.hudBg.fillStyle(acc, 0.8).fillRect(x, y + h - 2, w, 2).fillStyle(0xffffff, 0.08).fillRect(x, y + h - 3, w, 1);
      for (const [px, pw] of [[6, 176], [188, 110], [w - 160, 154]]) this.hudBg.fillStyle(0x000000, 0.22).fillRoundedRect(x + px, y + 6, pw, h - 14, 4).lineStyle(1, 0xffffff, 0.08).strokeRoundedRect(x + px, y + 6, pw, h - 14, 4);
    }
    this.gauges = this.add.graphics().setDepth(22);
    const c = n => this.add.container(0, 0).setDepth(21);
    this.hud = { enemies: c(), lives: c(), stage: c(), score: c() };
    this.hudEnemyIcons = [];
    const n = this.world.wave.length;
    for (let i = 0; i < n; i++) {
      const s = this.add.image(0, 0, sh.units.key, 'basic_0').setScale(16 / sh.units.cell / sh.units.k);
      this.hud.enemies.add(s); this.hudEnemyIcons.push(s);
    }
    const ps = this.world.players;
    this.hudLives = ps.map((p, i) => {
      const icon = this.add.image(0, 0, sh.units.key, `p${i + 1}_0`).setScale(16 / sh.units.cell / sh.units.k);
      const t = this.text(0, 0, '', 13, th.palette.text).setOrigin(0, 0.5);
      this.hud.lives.add([icon, t]);
      return { icon, t };
    });
    this.hudFlag = this.add.image(0, 0, sh.fx.key, 'flag').setScale(0.9 / sh.fx.k);
    this.hudStage = this.text(0, 0, '', 13, th.palette.text).setOrigin(0.5, 0);
    this.hud.stage.add([this.hudFlag, this.hudStage]);
    this.hudScore = ps.map((p, i) => this.text(0, 0, '', 12, i ? th.palette.p2 : th.palette.p1, { fontFamily: MONO }).setOrigin(land ? 0.5 : 0, 0));
    this.hudTime = this.text(0, 0, '', 14, th.palette.accent, { fontFamily: MONO }).setOrigin(0.5, 0).setDepth(21);
    this.hud.score.add(this.hudScore);
    this.layoutHud();
  }

  layoutHud() {
    const { x, y, w, h } = this.hudRect, land = this.view.orientation === 'landscape', versus = this.world.mode === 'versus';
    const icons = this.hudEnemyIcons;
    if (land) {
      icons.forEach((s, i) => s.setPosition(x + 24 + (i % 2) * 20, y + 20 + Math.floor(i / 2) * 18));
      this.hudLives.forEach(({ icon, t }, i) => { icon.setPosition(x + 22, y + h - 118 + i * 26); t.setPosition(x + 36, y + h - 118 + i * 26); });
      this.hudFlag.setPosition(x + 30, y + h - 56); this.hudStage.setPosition(x + 50, y + h - 66);
      this.hudScore.forEach((t, i) => t.setPosition(x + w / 2, y + h - 36 + i * 15));
      this.hudTime.setPosition(x + w / 2, y + 8);
    } else {
      // top strip: enemies left (10 columns), lives + score in the middle, flag right; the pause
      // buttons (DOM) take the right-most 60 units
      icons.forEach((s, i) => s.setPosition(x + 14 + Math.floor(i / 2) * 17, y + 18 + (i % 2) * 20));
      this.hudLives.forEach(({ icon, t }, i) => { icon.setPosition(x + 200 + i * 56, y + 18); t.setPosition(x + 212 + i * 56, y + 18); });
      this.hudFlag.setPosition(x + w - 90, y + 20); this.hudStage.setPosition(x + w - 72, y + 12);
      this.hudScore.forEach((t, i) => t.setPosition(x + 190 + i * 70, y + 36));
      this.hudTime.setPosition(x + w - 100, y + 24);
    }
    if (versus) { icons.forEach(s => s.setVisible(false)); this.hudFlag.setVisible(false); this.hudStage.setVisible(false); }
  }

  updateHud() {
    const w = this.world;
    const left = w.enemiesLeft;
    this.hudEnemyIcons.forEach((s, i) => s.setVisible(w.mode === 'coop' && i < left));
    this.hudLives.forEach(({ t }, i) => t.setText(w.players[i].lives === Infinity ? '×∞' : `×${Math.max(0, w.players[i].lives)}`));
    this.hudStage.setText(`${this.stageIndex + 1}`);
    this.hudScore.forEach((t, i) => t.setText(String(w.players[i].score).padStart(6, '0')));
    // status gauges under each life counter: laser heat (space), shield time, ghost phase timer
    this.gauges.clear();
    this.hudLives.forEach(({ icon }, i) => {
      const u = w.players[i].unit;
      if (!u) return;
      let frac = 0, col = 0xffffff;
      if (this.theme.rules.kind === 'beam') { const left = (u.heatUntil || 0) - w.time; frac = clamp(left / (this.theme.rules.overheat || 0.5), 0, 1); col = 0xff6a3a; }
      if (u.shieldT > 0) { frac = clamp(u.shieldT / 10, 0, 1); col = 0x9fe0ff; }
      if (frac <= 0) return;
      const gx = icon.x - 8, gy = icon.y + 11, gw = 44;
      this.gauges.fillStyle(0x000000, 0.45).fillRoundedRect(gx, gy, gw, 4, 2).fillStyle(col, 0.95).fillRoundedRect(gx, gy, gw * frac, 4, 2);
    });
    if (w.mode === 'versus') this.hudTime.setText(w.timeLeft > 0 ? `${Math.floor(w.timeLeft / 60)}:${String(Math.ceil(w.timeLeft % 60)).padStart(2, '0')}` : '∞');
    else this.hudTime.setText('');
  }

  /* ---------- tiles ---------- */
  refreshTiles() {
    const { grid } = this.world, sh = this.sheets;
    for (let cy = 0; cy < grid.rows; cy++) for (let cx = 0; cx < grid.cols; cx++) {
      const v = grid.cellAt(cx, cy), img = this.tiles[cy * grid.cols + cx];
      if (!v) { img.setVisible(false); continue; }
      const name = v === 'water' ? `water${this.waterPhase}` : v;
      img.setFrame(`${name}_${cx & 1}${cy & 1}`).setVisible(v !== 'bush');
      img.setDepth(v === 'brick' || v === 'steel' ? 3 : 1);
      // bushes live in the canopy container above the units
      const key = `${cx},${cy}`;
      if (v === 'bush' && !this.canopyTiles.has(key)) {
        const b = this.add.image(cx * U, cy * U, sh.tiles.key, `bush_${cx & 1}${cy & 1}`).setOrigin(0).setScale(1 / sh.tiles.k);
        this.canopy.add(b); this.canopyTiles.set(key, b);
      } else if (v !== 'bush' && this.canopyTiles.has(key)) { this.canopyTiles.get(key).destroy(); this.canopyTiles.delete(key); }
    }
    for (const [key, b] of this.canopyTiles) { const [cx, cy] = key.split(',').map(Number); if (grid.cellAt(cx, cy) !== 'bush') { b.destroy(); this.canopyTiles.delete(key); } }
    this.gridDirty = false;
  }

  /* ---------- the loop ---------- */
  update(time, delta) {
    if (!this.ready) return;
    try { this.step(delta); } catch (e) { if (!this.reported) { this.reported = true; console.error(e); window.__fatal?.(`play: ${e?.stack || e}`); } }
  }

  step(delta) {
    const dt = Math.min(0.05, delta / 1000);
    this.t += dt;
    if (this.curtainT > 0) { this.curtainT -= dt; this.drawCurtain(); if (this.curtainT > 0.9) { this.syncAll(dt); return; } }
    this.acc += dt;
    while (this.acc >= STEP) {
      this.world.tick(STEP, this.readInputs());
      this.acc -= STEP;
      this.handleEvents();
    }
    const wp = Math.floor(this.t * 2) % 2;
    if (wp !== this.waterPhase) { this.waterPhase = wp; this.gridDirty = true; }
    if (this.gridDirty) this.refreshTiles();
    this.syncAll(dt);
    if (this.world.phase !== this.lastPhase) { this.lastPhase = this.world.phase; this.onPhaseChange(); }
    if (this.world.phase !== 'play') this.drawResult(dt);
  }

  drawCurtain() {
    const k = clamp(this.curtainT / 1.6, 0, 1);
    // closes fast, holds, opens: height goes 0→full in the first 0.3s, full until 0.9, then opens
    const h = k > 0.8 ? (1 - k) / 0.2 : k > 0.45 ? 1 : k / 0.45;
    this.curtains.forEach(c => c.setSize(this.view.w, h * this.view.h / 2));
    this.shutter.clear();
    const ch = h * this.view.h / 2, acc = hex(this.theme.palette.accent);
    for (let yy = 0; yy < ch; yy += 14) { this.shutter.fillStyle(0x000000, 0.22).fillRect(0, yy, this.view.w, 3).fillStyle(0xffffff, 0.06).fillRect(0, yy + 3, this.view.w, 1); this.shutter.fillStyle(0x000000, 0.22).fillRect(0, this.view.h - yy - 3, this.view.w, 3); }
    if (ch > 2) { this.shutter.fillStyle(acc, 0.9).fillRect(0, ch - 2, this.view.w, 2).fillRect(0, this.view.h - ch, this.view.w, 2); }
    const show = h > 0.5;
    this.banner.setText(show ? `${this.theme.labels.stage} ${this.stageIndex + 1}` : '').setAlpha(show ? 1 : 0);
    this.bannerSub.setText(show ? (this.stageName || this.theme.labels.title || '') : '');
    if (this.curtainT <= 0) { this.curtains.forEach(c => c.setSize(this.view.w, 0)); this.shutter.clear(); this.banner.setText(''); this.bannerSub.setText(''); }
  }

  onPhaseChange() {
    const w = this.world;
    if (w.phase === 'clear') { this.sfx('win', { volume: 0.6 }); }
    if (w.phase === 'over') { this.sfx('gameOver', { volume: 0.6 }); }
    if (w.phase === 'win') { this.sfx('win', { volume: 0.6 }); }
    this.onPhase(w.phase);
  }

  // stage result / game over overlay drawn in the scene so it scales with the view
  drawResult(dt) {
    const w = this.world, th = this.theme, t = w.phaseT;
    this.dim.setAlpha(Math.min(0.72, t * 1.2));
    if (w.phase === 'clear') {
      if (!this.tally) {
        this.tally = this.add.container(0, 0).setDepth(48);
        const cx = this.view.w / 2, y0 = this.view.h / 2 - 90;
        this.tally.add(this.text(cx, y0, `${th.labels.stage} ${this.stageIndex + 1} 클리어`, 22, th.palette.accent, { stroke: '#000', strokeThickness: 4 }).setOrigin(0.5));
        const ps = w.players;
        ENEMY_TYPES.forEach((type, i) => {
          const y = y0 + 40 + i * 24;
          const icon = this.add.image(cx, y, this.sheets.units.key, `${type}_0`).setScale(20 / this.sheets.units.cell / this.sheets.units.k).setAngle(90);
          this.tally.add(icon);
          ps.forEach((p, pi) => {
            const side = ps.length === 1 ? -1 : pi === 0 ? -1 : 1;
            const txt = this.text(cx + side * 40, y, `${p.kills[type]} × ${SCORE[type]}`, 14, pi ? th.palette.p2 : th.palette.p1, { fontFamily: MONO }).setOrigin(side < 0 ? 1 : 0, 0.5);
            this.tally.add(txt);
          });
        });
        ps.forEach((p, pi) => {
          const side = ps.length === 1 ? -1 : pi === 0 ? -1 : 1;
          const total = ENEMY_TYPES.reduce((a, t) => a + p.kills[t], 0);
          this.tally.add(this.text(cx + side * 40, y0 + 40 + 4 * 24, `합계 ${total}`, 14, th.palette.text, { fontFamily: MONO }).setOrigin(side < 0 ? 1 : 0, 0.5));
        });
        this.tally.add(this.text(cx, y0 + 40 + 5 * 24 + 6, 'Ⓐ · 발사 버튼으로 계속', 12, th.palette.text).setOrigin(0.5).setAlpha(0.8));
      }
      this.tally.setAlpha(Math.min(1, t * 2));
    } else if (w.phase === 'over' || w.phase === 'win') {
      const label = w.phase === 'over' ? 'GAME OVER' : w.winner === null ? '무승부' : `P${w.winner + 1} 승리`;
      this.banner.setText(label).setAlpha(Math.min(1, t)).setY(this.view.h / 2 + 40 - Math.min(40, t * 60));
      this.bannerSub.setText(t > 1.2 ? 'Ⓐ · 발사 버튼으로 계속' : '').setY(this.view.h / 2 + 40);
    }
  }

  /* ---------- sync sprites to the world ---------- */
  syncAll(dt) {
    const w = this.world, sh = this.sheets, th = this.theme;
    // units
    const seen = new Set();
    for (const u of w.units) {
      seen.add(u);
      let s = this.unitSprites.get(u);
      if (!s) {
        const role = u.role;
        const spr = this.add.sprite(u.x, u.y, sh.units.key, `${role}_0`).setScale(1 / sh.units.k);
        const star = this.add.image(u.x, u.y, sh.fx.key, 'spawn0').setScale(1 / sh.fx.k).setVisible(false);
        const ring = this.add.image(u.x, u.y, sh.fx.key, 'shield0').setScale(1 / sh.fx.k).setVisible(false);
        this.unitLayer.add([spr, star, ring]);
        s = { spr, star, ring, px: u.x, py: u.y, anim: 0, animT: 0, angle: ANGLE[u.dir] };
        spr.setAngle(s.angle);
        this.unitSprites.set(u, s);
      }
      const { spr, star, ring } = s;
      const moving = Math.abs(u.x - s.px) + Math.abs(u.y - s.py) > 0.01;
      s.px = u.x; s.py = u.y;
      spr.setPosition(u.x, u.y);
      // rotate the short way, quickly
      const target = ANGLE[u.dir];
      let diff = ((target - s.angle + 540) % 360) - 180;
      s.angle += Math.abs(diff) < 1 ? diff : Math.sign(diff) * Math.min(Math.abs(diff), dt * 1400);
      spr.setAngle(s.angle);
      if (moving) { s.animT += dt; if (s.animT > 0.06) { s.animT = 0; s.anim ^= 1; } }
      spr.setFrame(`${u.role}_${s.anim}`);
      const spawning = u.spawnT > 0;
      spr.setVisible(!spawning);
      star.setVisible(spawning);
      if (spawning) star.setPosition(u.x, u.y).setFrame(`spawn${Math.floor(this.t * 12) % 4}`).setAngle(this.t * 90);
      // tints: armor hp, flashing item carrier, frozen, stunned
      let tint = 0xffffff, alpha = 1;
      if (u.role === 'armor') tint = [0xff8a8a, 0xffd27a, 0xd8ffd0, 0xffffff][clamp(u.hp - 1, 0, 3)];
      if (u.flash && Math.floor(this.t * 6) % 2) tint = 0xff6a6a;
      if (u.enemy && w.frozenT > 0) tint = 0x8fa0b8;
      if (u.stunT > 0) tint = 0x9a9aa8;
      if (u.phased) alpha = 0.35;
      spr.setTint(tint).setAlpha(alpha);
      ring.setVisible(u.shieldT > 0).setPosition(u.x, u.y).setFrame(`shield${Math.floor(this.t * 8) % 2}`).setAngle(-this.t * 120);
      if (u.phasing && !u.phased && Math.random() < dt * 4) this.fx.wisp.explode(1, u.x + rnd(-10, 10), u.y + rnd(-10, 10));
    }
    for (const [u, s] of this.unitSprites) if (!seen.has(u)) { s.spr.destroy(); s.star.destroy(); s.ring.destroy(); this.unitSprites.delete(u); }

    // shots
    const seenShots = new Set();
    this.beamGfx.clear();
    this.shadowGfx.clear();
    for (const p of w.shots) {
      seenShots.add(p);
      if (p.kind === 'beam') { this.drawBeam(p); continue; }
      let s = this.shotSprites.get(p);
      if (!s) { s = this.add.image(p.x, p.y, sh.shot.key, 's0').setScale(1 / sh.shot.k); this.shotLayer.add(s); this.shotSprites.set(p, s); }
      if (p.kind === 'arc') {
        const k = clamp(p.t / p.flight, 0, 1), x = p.fromX + (p.toX - p.fromX) * k, y = p.fromY + (p.toY - p.fromY) * k;
        const hgt = Math.sin(k * Math.PI) * (28 + Math.hypot(p.toX - p.fromX, p.toY - p.fromY) * 0.25);
        s.setPosition(x, y - hgt).setScale((1 + hgt / 60) / sh.shot.k).setAngle(this.t * 300).setFrame(Math.floor(this.t * 8) % 2 ? 's1' : 's0');
        this.shadowGfx.fillStyle(0x000000, 0.35).fillEllipse(x, y, 10, 6);
      } else {
        s.setPosition(p.x, p.y).setFrame(Math.floor(this.t * 20) % 2 ? 's1' : 's0');
        s.setAngle(p.kind === 'homing' ? p.angle * 180 / Math.PI + 90 : ANGLE[p.dir]);
        if (Math.random() < 0.6) this.fx.trail.explode(1, p.x, p.y);
      }
    }
    for (const [p, s] of this.shotSprites) if (!seenShots.has(p)) { s.destroy(); this.shotSprites.delete(p); }
    for (const p of this.beams || []) this.drawBeam(p);

    // items
    const seenItems = new Set();
    for (const it of w.items) {
      seenItems.add(it);
      let s = this.itemSprites.get(it);
      if (!s) { s = this.add.image(it.x, it.y, sh.items.key, it.id).setScale(1 / sh.items.k); this.fxLayer.add(s); this.itemSprites.set(it, s); }
      const blink = it.t < 4 ? (Math.floor(this.t * 8) % 2 ? 0.3 : 1) : 1;
      s.setAlpha(blink).setY(it.y + Math.sin(this.t * 4) * 2);
      if (Math.random() < dt * 3) this.fx.glow.explode(1, it.x + rnd(-8, 8), it.y + rnd(-8, 8));
    }
    for (const [it, s] of this.itemSprites) if (!seenItems.has(it)) { s.destroy(); this.itemSprites.delete(it); }

    // bases
    w.bases.forEach((b, i) => this.baseSprites[i].setFrame(b.alive ? 'alive' : 'dead'));
    // frozen: tick sound in the last 3 seconds
    if (w.frozenT > 0 && w.frozenT < 3) { this.tickSoundT -= dt; if (this.tickSoundT <= 0) { this.tickSoundT = 0.5; this.sfx('tick', { volume: 0.4 }); } }
    this.updateHud();
  }

  drawBeam(p) {
    if (!p.segments) return;
    const a = clamp(1 - p.t / p.life, 0, 1), col = hex(this.theme.palette.accent);
    for (const sgm of p.segments) {
      this.beamGfx.lineStyle(7, col, 0.25 * a).lineBetween(sgm.x0, sgm.y0, sgm.x1, sgm.y1);
      this.beamGfx.lineStyle(3, col, 0.8 * a).lineBetween(sgm.x0, sgm.y0, sgm.x1, sgm.y1);
      this.beamGfx.lineStyle(1.2, 0xffffff, a).lineBetween(sgm.x0, sgm.y0, sgm.x1, sgm.y1);
    }
  }

  /* ---------- world events → effects ---------- */
  sfx(key, cfg) { if (this.game.sound.locked || !this.cache.audio.exists(key)) return; this.sound.play(key, { volume: 0.5, ...cfg }); }
  flashStar(x, y, s, tint) {
    const img = this.add.image(x, y, 'fx-star').setBlendMode(Phaser.BlendModes.ADD).setTint(tint).setScale(0.2 * s).setRotation(rnd(0, 1));
    this.fxLayer.add(img);
    this.tweens.add({ targets: img, scale: 0.75 * s, alpha: 0, duration: 220, ease: 'Cubic.easeOut', onComplete: () => img.destroy() });
  }
  ring(x, y, tint, s = 1) {
    const img = this.add.image(x, y, 'fx-ring').setTint(tint).setScale(0.15 * s).setBlendMode(Phaser.BlendModes.ADD);
    this.fxLayer.add(img);
    this.tweens.add({ targets: img, scale: 0.8 * s, alpha: 0, duration: 320, ease: 'Cubic.easeOut', onComplete: () => img.destroy() });
  }
  popText(str, x, y, color, size = 14) {
    const t = this.text(x + this.mapX, y + this.mapY, str, size, color, { stroke: '#000', strokeThickness: 3 }).setOrigin(0.5).setDepth(30);
    this.tweens.add({ targets: t, y: t.y - 26, alpha: { from: 1, to: 0 }, duration: 700, ease: 'Quad.easeOut', onComplete: () => { t.destroy(); this.texts = this.texts.filter(x => x !== t); } });
  }
  recoil(unit) {
    const s = this.unitSprites.get(unit);
    if (!s) return;
    const d = { up: [0, 2], down: [0, -2], left: [2, 0], right: [-2, 0] }[unit.dir];
    this.tweens.add({ targets: s.spr, x: unit.x + d[0], y: unit.y + d[1], duration: 40, yoyo: true });
  }

  handleEvents() {
    const w = this.world, cam = this.cameras.main, th = this.theme, ex = th.palette.explosion.map(hex);
    for (const e of w.events) {
      switch (e.type) {
        case 'fire': {
          const u = e.unit, d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[u.dir];
          this.flashStar(u.x + d[0] * 18, u.y + d[1] * 18, 0.5, ex[0]);
          this.recoil(u);
          if (e.shot.kind === 'beam') { this.beams = [...(this.beams || []).filter(b => b.alive), e.shot]; this.sfx('beam', { volume: 0.5 }); }
          else this.sfx(th.sfx.fire, { volume: u.player !== undefined ? 0.5 : 0.3, rate: rnd(0.95, 1.08) });
          break;
        }
        case 'hitWall': case 'land': case 'crush': {
          this.gridDirty = true;
          const n = e.cells.length;
          if (e.type === 'land') { this.sfx('land', { volume: 0.6 }); this.fx.smoke.explode(6, e.x, e.y); this.ring(e.x, e.y, ex[1], 0.8); cam.shake(90, 0.004); }
          if (n) { this.fx.chips.explode(Math.min(14, 4 + n * 2), e.x, e.y); this.sfx('brick', { volume: 0.45, rate: rnd(0.9, 1.1) }); }
          else if (e.type !== 'land') { this.fx.steel.explode(10, e.x, e.y); this.flashStar(e.x, e.y, 0.5, 0xffffff); this.sfx('steel', { volume: 0.4 }); }
          break;
        }
        case 'cancel': this.fx.spark.explode(8, e.x, e.y); this.flashStar(e.x, e.y, 0.5, 0xffffff); this.sfx('hit', { volume: 0.35 }); break;
        case 'damage': this.fx.spark.explode(10, e.x, e.y); this.flashStar(e.x, e.y, 0.6, 0xffe0a0); this.sfx('hit', { volume: 0.5 }); cam.shake(60, 0.003); break;
        case 'ricochet': this.fx.steel.explode(10, e.x, e.y); this.ring(e.unit.x, e.unit.y, 0x9fe0ff, 0.9); this.sfx('ricochet', { volume: 0.5 }); break;
        case 'stun': this.popText('!', e.unit.x, e.unit.y - 20, '#ffd27a', 16); this.sfx('stun', { volume: 0.5 }); break;
        case 'explode': {
          const big = e.big;
          this.fx.spark.explode(big ? 40 : 22, e.x, e.y);
          this.fx.smoke.explode(big ? 14 : 6, e.x, e.y);
          this.flashStar(e.x, e.y, big ? 2.2 : 1.3, ex[0]);
          this.ring(e.x, e.y, ex[1], big ? 2 : 1.2);
          if (big) this.time.delayedCall(120, () => this.ring(e.x, e.y, ex[2], 2.6));
          cam.shake(big ? 320 : 140, big ? 0.012 : 0.006);
          if (e.score) this.popText(`${e.score}`, e.x, e.y - 10, '#fff', 15);
          this.sfx(big ? th.sfx.explodeBig : th.sfx.explode, { volume: big ? 0.7 : 0.5, rate: rnd(0.92, 1.08) });
          break;
        }
        case 'baseHit': {
          cam.flash(260, 255, 230, 180); cam.shake(700, 0.02);
          this.fx.spark.explode(60, e.x, e.y); this.fx.smoke.explode(30, e.x, e.y);
          this.flashStar(e.x, e.y, 3, ex[0]);
          for (const k of [1, 1.8, 2.6]) this.time.delayedCall(k * 90, () => this.ring(e.x, e.y, ex[1], k * 1.4));
          this.sfx('explodeBig', { volume: 0.9 });
          break;
        }
        case 'spawn': if (e.unit.enemy) this.sfx('spawn', { volume: 0.25 }); break;
        case 'respawn': this.sfx('shield', { volume: 0.4 }); break;
        case 'item': this.flashStar(e.item.x, e.item.y, 1.2, hex(th.palette.accent)); this.sfx('item', { volume: 0.6 }); break;
        case 'pickup': {
          const u = w.players[e.player]?.unit;
          if (u) { this.ring(u.x, u.y, hex(th.palette.accent), 1.4); this.fx.glow.explode(8, u.x, u.y); this.popText({ grenade: '폭파!', helmet: '보호막', clock: '정지', shovel: '요새 강화', star: '강화!', tank: '목숨 +1' }[e.id], u.x, u.y - 24, '#fff', 13); }
          this.sfx(e.id === 'tank' ? 'life' : e.id === 'helmet' ? 'shield' : e.id === 'shovel' ? 'shovel' : e.id === 'clock' ? 'freeze' : 'pickup', { volume: 0.6 });
          if (e.id === 'grenade') { cam.flash(200, 255, 255, 255); cam.shake(300, 0.01); }
          break;
        }
        case 'shovel': this.gridDirty = true; break;
        case 'phase': case 'solidify': this.fx.wisp.explode(10, e.unit.x, e.unit.y); this.sfx('phase', { volume: 0.3, rate: e.type === 'phase' ? 1 : 0.7 }); break;
        case 'playerDie': cam.flash(120, 255, 120, 120); break;
        case 'playerHit': {
          const s = this.unitSprites.get(e.unit);
          this.fx.spark.explode(16, e.x, e.y); this.flashStar(e.x, e.y, 1.0, 0xffb0a0); this.ring(e.unit.x, e.unit.y, 0xff5a3a, 1.2);
          cam.shake(160, 0.008); cam.flash(90, 255, 80, 60);
          if (s) this.tweens.add({ targets: s.spr, alpha: 0.25, duration: 70, yoyo: true, repeat: 5 });
          this.popText('-1', e.unit.x, e.unit.y - 22, '#ff8a7a', 15);
          this.sfx('hit', { volume: 0.7, rate: 0.8 });
          break;
        }
      }
    }
  }
}

/* ---------- host ---------- */
export class Stage {
  constructor(parent) {
    this.parent = parent;
    this.ready = new Promise(resolve => {
      this.game = new Phaser.Game({
        type: Phaser.WEBGL, parent, width: 512, height: 416, backgroundColor: '#000000', banner: false,
        scale: { mode: Phaser.Scale.NONE, autoCenter: Phaser.Scale.NO_CENTER },
        input: { keyboard: false, mouse: false, touch: false, gamepad: false },
        render: { antialias: true, powerPreference: 'high-performance' },
        scene: [BootScene, PlayScene, EditorScene]
      });
      this.game.events.once('tank-ready', resolve);
    });
    this.muted = false;
  }

  resize(pw, ph) { if (this.game.scale.width !== pw || this.game.scale.height !== ph) this.game.scale.resize(pw, ph); }
  startPlay(data) { this.stopAll(); this.current = 'play'; this.game.scene.start('play', data); }
  startEditor(data) { this.stopAll(); this.current = 'editor'; this.game.scene.start('editor', data); }
  stopAll() { this.current = null; for (const k of ['play', 'editor']) if (this.game.scene.isActive(k) || this.game.scene.isPaused(k)) this.game.scene.stop(k); }
  // pauses the running scene; a scene that was just started pauses as soon as it has been created
  pause() {
    const k = this.current;
    if (!k) return;
    if (this.game.scene.isActive(k)) this.game.scene.pause(k);
    else this.game.scene.getScene(k)?.events.once('create', () => { if (this.current === k && !this.game.scene.isPaused(k)) this.game.scene.pause(k); });
    this.game.sound.pauseAll();
  }
  resume() { for (const k of ['play', 'editor']) if (this.game.scene.isPaused(k)) this.game.scene.resume(k); this.game.sound.resumeAll(); }
  setMuted(v) { this.muted = v; this.game.sound.mute = v; }
  play(key, cfg) { if (!this.game.sound.locked && this.game.cache.audio.exists(key)) this.game.sound.play(key, { volume: 0.5, ...cfg }); }
}
