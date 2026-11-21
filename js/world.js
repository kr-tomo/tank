// The whole match state and its fixed-step tick. Pure: no DOM, no Phaser. The renderer reads the
// state and the per-tick `events` list; theme rules (projectile kind, enemy traits) are injected.
import { U, TILE, UNIT, MODES, SPEED, ENEMY_HP, SCORE, ITEM_IDS, ITEM_TIME, LIVES, MAX_LEVEL, MAX_ENEMIES, SPAWN_INTERVAL,
  SPAWN_TIME, RESPAWN_TIME, RESPAWN_SHIELD, FLASH_INDEX, STUN_TIME, CLEAR_DELAY, ICE_SLIDE, MUD_SPEED, VERSUS_ITEM_INTERVAL } from './config.js';
import { makeUnit, tryMove, overlaps, unitCells, freeAt } from './units.js';
import { fire, stepProjectile, makeRules } from './projectile.js';
import { decide } from './enemy.js';

const DIR_OF = { up: 'up', down: 'down', left: 'left', right: 'right' };
const TYPE_OF = { b: 'basic', f: 'fast', p: 'power', a: 'armor' };
const FIRE_REPEAT = 0.15;
const PHASE_PERIOD = 2;
const CRUSH_TIME = 0.5;
const HIT_GRACE = 1;        // damage mode: seconds of invulnerability after a hit
const tileCenter = ([tx, ty]) => ({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });

// mulberry32
export function rng(seed = Date.now() % 2147483647) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export class World {
  // { mode, grid, players, wave:'bbff…', rules, traits, timeLimit, seed, stage }
  // lives: 3..10 or Infinity; hitMode: 'destroy' (a hit blows the tank up, the next one rolls in) | 'damage' (a hit costs a life, the tank stays)
  constructor({ mode = 'coop', grid, players = 1, wave = '', rules = makeRules(), traits = {}, timeLimit = 0, seed, stage = 1, carry = null, lives = LIVES, hitMode = 'destroy' }) {
    Object.assign(this, { mode, grid, rules, traits, stage, hitMode, time: 0, phase: 'play', phaseT: 0, winner: null, events: [] });
    this.rand = rng(seed);
    this.units = []; this.shots = []; this.items = [];
    this.wave = [...wave].map(c => TYPE_OF[c] || 'basic');
    this.enemiesLeft = this.wave.length; this.spawnIndex = 0; this.spawnT = 0; this.spawnSlot = 0;
    this.frozenT = 0; this.shovelT = 0; this.itemT = VERSUS_ITEM_INTERVAL;
    this.timeLeft = timeLimit || 0;
    this.bases = grid.bases.map((b, i) => ({ cx: b.cx, cy: b.cy, team: mode === 'versus' ? i : 0, alive: true }));
    this.players = Array.from({ length: players }, (_, i) => ({ index: i, unit: null, lives: carry?.[i]?.lives ?? lives, score: carry?.[i]?.score ?? 0, level: carry?.[i]?.level ?? 0, kills: { basic: 0, fast: 0, power: 0, armor: 0 }, respawnT: 0, fireT: 0 }));
    this.players.forEach(p => { if (p.lives > 0) { this.spawnPlayer(p.index, true); p.unit.level = p.level; } });
  }

  emit(type, data = {}) { this.events.push({ type, ...data }); }

  // what the next stage inherits: lives, score and the star level the player still holds
  static carryFrom(w) { return w.players.map(p => ({ lives: p.lives, score: p.score, level: p.unit ? (p.unit.level || 0) : 0 })); }

  /* ---------- spawning ---------- */
  spawnPlayer(i, first = false) {
    const p = this.players[i], start = tileCenter(MODES[this.mode].starts[i]);
    const u = makeUnit({ role: i === 0 ? 'p1' : 'p2', player: i, team: this.mode === 'versus' ? i : 0, x: start.x, y: start.y, dir: 'up',
      level: 0, shieldT: RESPAWN_SHIELD, stunT: 0, spawnT: first ? 0 : 0, slideT: 0 });
    p.unit = u;
    this.units.push(u);
    this.emit('spawn', { unit: u });
    return u;
  }

  spawnEnemy(type, at) {
    const u = makeUnit({ role: type, enemy: true, team: this.mode === 'versus' ? 2 : 1, hp: ENEMY_HP[type], x: at.x, y: at.y, dir: at.dir || 'down',
      spawnT: SPAWN_TIME, flash: !!at.flash, level: 0, shieldT: 0, stunT: 0, slideT: 0,
      ai: { turnT: 0, fireT: 1 + this.rand() * 1.5 }, phased: false, phaseT: PHASE_PERIOD, crushT: 0 });
    if (this.traits[type] === 'phase') { u.phasing = true; }
    this.units.push(u);
    this.emit('spawn', { unit: u });
    return u;
  }

  trySpawnWave() {
    if (this.enemiesLeft <= 0 || this.units.filter(u => u.enemy).length >= MAX_ENEMIES) return;
    if (this.spawnT > 0) return;
    const spawns = MODES[this.mode].spawns;
    for (let k = 0; k < spawns.length; k++) {
      const slot = (this.spawnSlot + k) % spawns.length, at = tileCenter(spawns[slot]);
      const probe = { ...at, w: UNIT, h: UNIT };
      if (this.units.some(u => overlaps(probe, u))) continue;
      const type = this.wave[this.spawnIndex];
      this.spawnEnemy(type, { ...at, dir: 'down', flash: FLASH_INDEX.includes(this.spawnIndex) });
      this.spawnIndex++; this.enemiesLeft--; this.spawnSlot = (slot + 1) % spawns.length; this.spawnT = SPAWN_INTERVAL;
      return;
    }
  }

  /* ---------- items ---------- */
  freeTile(region) {
    const [tw, th] = MODES[this.mode].tiles;
    for (let tries = 0; tries < 60; tries++) {
      const tx = region ? region.x0 + Math.floor(this.rand() * (region.x1 - region.x0 + 1)) : Math.floor(this.rand() * tw);
      const ty = Math.floor(this.rand() * th);
      const c = tileCenter([tx, ty]), probe = { ...c, w: UNIT, h: UNIT };
      if (unitCells(probe).some(([cx, cy]) => this.grid.blocksUnit(cx, cy) || this.grid.isBase(cx, cy))) continue;
      if (this.units.some(u => overlaps(probe, u))) continue;
      return c;
    }
    return null;
  }

  dropItem(region) {
    const at = this.freeTile(region);
    if (!at) return null;
    const item = { id: ITEM_IDS[Math.floor(this.rand() * ITEM_IDS.length)], x: at.x, y: at.y, w: UNIT, h: UNIT, t: ITEM_TIME.item };
    this.items.push(item);
    this.emit('item', { item });
    return item;
  }

  applyItem(id, playerIndex) {
    const p = this.players[playerIndex], u = p.unit;
    this.emit('pickup', { id, player: playerIndex });
    switch (id) {
      case 'grenade':
        if (this.mode === 'versus') { const o = this.players[1 - playerIndex]; if (o?.unit) this.killPlayer(o.index); }
        else for (const e of this.units.filter(x => x.enemy)) this.destroyEnemy(e, null);
        break;
      case 'helmet': if (u) u.shieldT = ITEM_TIME.helmet; break;
      case 'clock': this.frozenT = ITEM_TIME.clock; this.emit('freeze'); break;
      case 'shovel': this.shovelT = ITEM_TIME.shovel; this.grid.buildFortress(true); this.emit('shovel', { steel: true }); break;
      case 'star': if (u) u.level = Math.min(MAX_LEVEL, (u.level || 0) + 1); break;
      case 'tank': p.lives++; break;
    }
  }

  /* ---------- deaths ---------- */
  destroyEnemy(e, byPlayer) {
    if (e.dead) return;
    e.dead = true;
    this.units = this.units.filter(u => u !== e);
    if (byPlayer !== null && byPlayer !== undefined) {
      const p = this.players[byPlayer];
      if (p) { p.score += SCORE[e.role]; p.kills[e.role]++; }
    }
    this.emit('explode', { x: e.x, y: e.y, unit: e, big: false, score: byPlayer != null ? SCORE[e.role] : 0 });
    if (e.flash && byPlayer != null) this.dropItem();
  }

  killPlayer(i) {
    const p = this.players[i], u = p.unit;
    if (!u) return;
    u.dead = true;
    this.units = this.units.filter(x => x !== u);
    p.unit = null; p.lives--; p.respawnT = RESPAWN_TIME;
    this.emit('explode', { x: u.x, y: u.y, unit: u, big: true });
    this.emit('playerDie', { player: i });
  }

  destroyBase(i) {
    const b = this.bases[i];
    if (!b.alive) return;
    b.alive = false;
    this.emit('baseHit', { base: i, x: b.cx * U + U, y: b.cy * U + U });
    if (this.mode === 'versus') this.finish(1 - b.team);
    else this.finish('over');
  }

  finish(result) {
    if (this.phase !== 'play') return;
    if (result === 'over' || result === 'clear') { this.phase = result; }
    else { this.phase = 'win'; this.winner = result; }
    this.phaseT = 0;
    this.emit(this.phase, { winner: this.winner });
  }

  /* ---------- firing ---------- */
  fire(u) {
    const p = fire(u, this.rules, this);
    if (!p) return null;
    this.shots.push(p);
    this.emit('fire', { unit: u, shot: p });
    return p;
  }

  applyShotEvents(evs) {
    for (const ev of evs) {
      switch (ev.type) {
        case 'hitWall': case 'land':
          for (const [cx, cy] of ev.cells) this.grid.set(cx, cy, null);
          this.emit(ev.type === 'land' ? 'land' : 'hitWall', ev);
          break;
        case 'hitUnit': case 'hitFriend': this.damage(ev.unit, ev.shot, ev); break;
        case 'hitBase': this.destroyBase(ev.base); break;
        case 'cancel': this.emit('cancel', ev); break;
        default: this.emit(ev.type, ev);
      }
    }
  }

  damage(u, shot, ev) {
    if (u.dead) return;
    if (u.enemy) {
      if (shot.team === u.team) return;   // enemy shots pass other enemies
      u.hp--;
      if (u.hp <= 0) this.destroyEnemy(u, shot.owner.player ?? null);
      else this.emit('damage', { unit: u, x: ev.x, y: ev.y });
      return;
    }
    if (u.shieldT > 0) { this.emit('ricochet', { unit: u, x: ev.x, y: ev.y }); return; }
    if (shot.team === u.team) { u.stunT = STUN_TIME; this.emit('stun', { unit: u }); return; }
    const p = this.players[u.player];
    if (this.hitMode === 'damage' && (p.lives === Infinity || p.lives > 1)) {
      if (p.lives !== Infinity) p.lives--;
      u.shieldT = HIT_GRACE;
      this.emit('playerHit', { unit: u, player: u.player, x: ev.x, y: ev.y });
      return;
    }
    this.killPlayer(u.player);
  }

  /* ---------- movement ---------- */
  blocksFor(u) {
    if (u.phased) return (cx, cy) => { const c = this.grid.cellAt(cx, cy); return !this.grid.inside(cx, cy) || c === 'steel' || c === 'water'; };
    return null;
  }

  moveUnit(u, dir, dt) {
    const base = SPEED[u.role] || 100;
    const onIce = unitCells(u).some(([cx, cy]) => this.grid.cellAt(cx, cy) === 'ice');
    const iceSlot = this.traits.ice || 'slide';
    let mult = 1;
    if (onIce && iceSlot === 'mud') mult = MUD_SPEED;
    const others = this.units;
    const opts = {}; const b = this.blocksFor(u); if (b) opts.blocks = b;
    if (dir) {
      const r = tryMove(u, dir, base * mult * dt, this.grid, others, opts);
      u.blocked = r.blocked;
      u.slideT = onIce && iceSlot !== 'mud' ? ICE_SLIDE[iceSlot] : 0;
      u.slideDir = dir;
      return r;
    }
    if (u.slideT > 0) {
      u.slideT -= dt;
      const r = tryMove(u, u.slideDir, base * dt * 0.7, this.grid, others, opts);
      if (r.blocked) u.slideT = 0;
      return r;
    }
    u.blocked = false;
    return null;
  }

  tickPlayer(p, inp, dt) {
    if (!p.unit) {
      if (p.lives <= 0) return;
      p.respawnT -= dt;
      if (p.respawnT <= 0) {
        const start = tileCenter(MODES[this.mode].starts[p.index]), probe = { ...start, w: UNIT, h: UNIT };
        if (!this.units.some(u => overlaps(probe, u))) { this.spawnPlayer(p.index); this.emit('respawn', { player: p.index }); }
      }
      return;
    }
    const u = p.unit;
    if (u.shieldT > 0) u.shieldT -= dt;
    if (u.stunT > 0) { u.stunT -= dt; return; }
    const dir = inp.up ? 'up' : inp.down ? 'down' : inp.left ? 'left' : inp.right ? 'right' : null;
    this.moveUnit(u, dir, dt);
    p.fireT -= dt;
    if (inp.fire && p.fireT <= 0) { if (this.fire(u)) p.fireT = FIRE_REPEAT; }
    for (const item of this.items) if (!item.taken && overlaps(u, item)) { item.taken = true; this.applyItem(item.id, p.index); }
  }

  tickEnemy(e, dt) {
    if (e.spawnT > 0) { e.spawnT -= dt; return; }
    if (this.frozenT > 0) return;
    // halloween ghosts: alternate solid / phased every PHASE_PERIOD; solid inside the fortress
    if (e.phasing) {
      const inFort = unitCells(e).some(([cx, cy]) => this.grid.inFortress(cx, cy));
      e.phaseT -= dt;
      if (inFort) { if (e.phased) this.emit('solidify', { unit: e }); e.phased = false; e.phaseT = PHASE_PERIOD; }
      else if (e.phaseT <= 0) { e.phased = !e.phased; e.phaseT = PHASE_PERIOD; this.emit(e.phased ? 'phase' : 'solidify', { unit: e }); }
      if (!e.phased) this.unstick(e);
    }
    const d = decide(e, this, dt);
    const r = this.moveUnit(e, d.dir, dt);
    // siege towers crush the brick they push against (outside the fortress)
    if (this.traits[e.role] === 'crush') {
      if (r?.blocked) {
        e.crushT += dt;
        if (e.crushT >= CRUSH_TIME - 1e-9) {
          e.crushT = 0;
          const cells = this.frontCells(e).filter(([cx, cy]) => this.grid.cellAt(cx, cy) === 'brick' && !this.grid.inFortress(cx, cy));
          if (cells.length) { for (const [cx, cy] of cells) this.grid.set(cx, cy, null); this.emit('crush', { unit: e, cells }); }
        }
      } else e.crushT = 0;
    }
    if (d.fire && !e.phased) this.fire(e);
  }

  // the two half cells directly ahead of a unit
  frontCells(u) {
    const [dx, dy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[u.dir];
    const x = u.x + dx * (UNIT / 2 + 1), y = u.y + dy * (UNIT / 2 + 1);
    return unitCells({ x: dx ? x : u.x, y: dy ? y : u.y, w: dx ? 1 : UNIT, h: dy ? 1 : UNIT });
  }

  // a ghost that turns solid inside a brick is pushed back the way it came
  unstick(e) {
    for (let k = 0; k < 8 && !freeAt(e, e.x, e.y, this.grid, this.units); k++) {
      const [dx, dy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[e.dir];
      e.x -= dx * U; e.y -= dy * U;
    }
  }

  /* ---------- the tick ---------- */
  tick(dt, inputs = []) {
    this.events = [];
    if (this.phase !== 'play') { this.phaseT += dt; return; }
    this.time += dt;
    if (this.frozenT > 0) this.frozenT -= dt;
    if (this.shovelT > 0) { this.shovelT -= dt; if (this.shovelT <= 0) { this.grid.buildFortress(false); this.emit('shovel', { steel: false }); } }
    if (this.spawnT > 0) this.spawnT -= dt;
    this.trySpawnWave();
    if (this.mode === 'versus') {
      this.itemT -= dt;
      if (this.itemT <= 0) { this.itemT = VERSUS_ITEM_INTERVAL; const [tw] = MODES.versus.tiles; this.dropItem({ x0: Math.floor(tw / 3), x1: Math.ceil(tw * 2 / 3) - 1 }); }
      if (this.timeLeft > 0) { this.timeLeft -= dt; if (this.timeLeft <= 0) { this.timeLeft = 0; this.finish(null); return; } }
    }
    this.players.forEach((p, i) => this.tickPlayer(p, inputs[i] || {}, dt));
    for (const e of [...this.units]) if (e.enemy && !e.dead) this.tickEnemy(e, dt);
    for (const s of this.shots) if (s.alive) this.applyShotEvents(stepProjectile(s, dt, this));
    this.shots = this.shots.filter(s => s.alive);
    for (const it of this.items) it.t -= dt;
    this.items = this.items.filter(it => !it.taken && it.t > 0);
    if (this.phase !== 'play') return;
    // end conditions
    if (this.mode === 'coop') {
      if (this.wave.length && this.enemiesLeft <= 0 && !this.units.some(u => u.enemy)) { this.clearT = (this.clearT || 0) + dt; if (this.clearT >= CLEAR_DELAY) this.finish('clear'); }
      if (this.players.every(p => !p.unit && p.lives <= 0)) this.finish('over');
    } else {
      const out = this.players.findIndex(p => !p.unit && p.lives <= 0);
      if (out >= 0) this.finish(1 - out);
    }
  }
}
