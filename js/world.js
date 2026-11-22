// The whole match state and its fixed-step tick. Pure: no DOM, no Phaser. The renderer reads the
// state and the per-tick `events` list; theme rules (projectile kind, enemy traits) are injected.
import { U, TILE, UNIT, MODES, SPEED, ENEMY_HP, SCORE, ITEM_IDS, ITEM_TIME, LIVES, MAX_LEVEL, MAX_ENEMIES, SPAWN_INTERVAL,
  SPAWN_TIME, RESPAWN_TIME, RESPAWN_SHIELD, FLASH_INDEX, STUN_TIME, CLEAR_DELAY, ICE_SLIDE, MUD_SPEED, VERSUS_ITEM_INTERVAL, BASE_RESPAWN, VERSUS_MAX_ENEMIES, VERSUS_WAVE, VERSUS_CLOCK } from './config.js';
import { makeUnit, tryMove, overlaps, unitCells, freeAt } from './units.js';
import { fire, stepProjectile, makeRules } from './projectile.js';
import { decide } from './enemy.js';

const DIR_OF = { up: 'up', down: 'down', left: 'left', right: 'right' };
const TYPE_OF = { b: 'basic', f: 'fast', p: 'power', a: 'armor' };
const FIRE_REPEAT = 0.15;
const PHASE_PERIOD = 2;
const CRUSH_TIME = 0.5;
const HIT_GRACE = 1;        // damage mode: seconds of invulnerability after a hit
const FRIENDLY_STREAK = 3;  // friendly hits in one stun that destroy the tank
const STUCK_TIME = 8;       // a last enemy that has not moved this long is removed so the stage can end
const LINGER_TIME = 60;
const RELOCATE_RADIUS = 8;  // tiles searched for a free spot when a ghost solidifies inside a wall     // …or any leftover enemies this long after the wave ran out
const tileCenter = ([tx, ty]) => ({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });

// mulberry32
export function rng(seed = Date.now() % 2147483647) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export class World {
  // { mode, grid, players, wave:'bbff…', rules, traits, timeLimit, seed, stage }
  // lives: 3..10 or Infinity; hitMode: 'destroy' (a hit blows the tank up, the next one rolls in) | 'damage' (a hit costs a life, the tank stays)
  constructor({ mode = 'coop', grid, players = 1, wave = '', rules = makeRules(), traits = {}, timeLimit = 0, seed, stage = 1, carry = null, lives = LIVES, hitMode = 'destroy', baseWins = 1 }) {
    Object.assign(this, { mode, grid, rules, traits, stage, hitMode, time: 0, phase: 'play', phaseT: 0, winner: null, events: [] });
    this.rand = rng(seed);
    this.starts = grid.starts || MODES[mode].starts;
    this.spawns = grid.spawns || MODES[mode].spawns;
    this.units = []; this.shots = []; this.items = [];
    // versus: neutral enemies (team 2) keep coming for the whole match; they hunt both players but can't hurt bases
    this.wave = [...(mode === 'versus' ? VERSUS_WAVE : wave)].map(c => TYPE_OF[c] || 'basic');
    this.enemiesLeft = mode === 'versus' ? Infinity : this.wave.length; this.spawnIndex = 0; this.spawnT = 0; this.spawnSlot = 0;
    this.frozenT = 0; this.shovelT = grid.bases.map(() => 0); this.itemT = VERSUS_ITEM_INTERVAL;   // shovel timer per base
    this.timeLeft = timeLimit || 0;
    this.bases = grid.bases.map((b, i) => ({ cx: b.cx, cy: b.cy, team: mode === 'versus' ? i : 0, alive: true, respawnT: 0 }));
    this.baseWins = baseWins; this.baseKills = [0, 0];   // versus: bases destroyed by each team
    this.initialCells = grid.cells.slice();               // the map as loaded: a rebuilt base restores its surroundings from this
    this.players = Array.from({ length: players }, (_, i) => ({ index: i, unit: null, lives: carry?.[i]?.lives ?? lives, score: carry?.[i]?.score ?? 0, level: carry?.[i]?.level ?? 0, kills: { basic: 0, fast: 0, power: 0, armor: 0 }, respawnT: 0, fireT: 0 }));
    this.players.forEach(p => { if (p.lives > 0) { this.spawnPlayer(p.index, true); p.unit.level = p.level; } });
  }

  emit(type, data = {}) { this.events.push({ type, ...data }); }

  // what the next stage inherits: lives, score and the star level the player still holds
  static carryFrom(w) { return w.players.map(p => ({ lives: p.lives, score: p.score, level: p.unit ? (p.unit.level || 0) : 0 })); }

  /* ---------- spawning ---------- */
  spawnPlayer(i, first = false) {
    const p = this.players[i], start = tileCenter(this.starts[i]);
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
    const cap = this.mode === 'versus' ? VERSUS_MAX_ENEMIES : MAX_ENEMIES;
    if (this.enemiesLeft <= 0 || this.units.filter(u => u.enemy).length >= cap) return;
    if (this.spawnT > 0) return;
    const spawns = this.spawns;
    for (let k = 0; k < spawns.length; k++) {
      const slot = (this.spawnSlot + k) % spawns.length, at = tileCenter(spawns[slot]);
      const probe = { ...at, w: UNIT, h: UNIT };
      if (this.units.some(u => overlaps(probe, u))) continue;
      const type = this.wave[this.spawnIndex % this.wave.length];
      const flash = this.mode === 'versus' ? this.spawnIndex % 7 === 3 : FLASH_INDEX.includes(this.spawnIndex);
      this.spawnEnemy(type, { ...at, dir: at.y > this.grid.height / 2 ? 'up' : 'down', flash });
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
    // the life item is pointless with infinite lives
    const ids = this.players.every(p => p.lives === Infinity) ? ITEM_IDS.filter(i => i !== 'tank') : ITEM_IDS;
    const item = { id: ids[Math.floor(this.rand() * ids.length)], x: at.x, y: at.y, w: UNIT, h: UNIT, t: ITEM_TIME.item };
    this.items.push(item);
    this.emit('item', { item });
    return item;
  }

  applyItem(id, playerIndex) {
    const p = this.players[playerIndex], u = p.unit;
    this.emit('pickup', { id, player: playerIndex });
    switch (id) {
      case 'grenade':
        for (const e of this.units.filter(x => x.enemy)) this.destroyEnemy(e, null);   // versus: the opponent is untouched
        break;
      case 'helmet': if (u) u.shieldT = ITEM_TIME.helmet; break;
      case 'clock':   // versus: the opponent is frozen as well
        const clock = this.mode === 'versus' ? VERSUS_CLOCK : ITEM_TIME.clock;
        this.frozenT = clock;
        if (this.mode === 'versus') for (const o of this.players) if (o.index !== playerIndex) o.frozenT = clock;
        this.emit('freeze');
        break;
      case 'shovel': {   // versus: only the picker's own base is fortified
        const bi = this.mode === 'versus' ? Math.min(playerIndex, this.bases.length - 1) : 0;
        this.shovelT[bi] = ITEM_TIME.shovel; this.grid.buildFortress(true, bi); this.emit('shovel', { steel: true, base: bi });
        break;
      }
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
    if (this.mode !== 'versus') { this.finish('over'); return; }
    // versus: count the kill for the other team; the base rebuilds unless that was the deciding one
    const killer = 1 - b.team;
    this.baseKills[killer]++;
    if (this.baseKills[killer] >= this.baseWins) this.finish(killer);
    else b.respawnT = BASE_RESPAWN;
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
        case 'hitBase': if (!ev.shot?.owner?.enemy || this.mode !== 'versus') this.destroyBase(ev.base); break;   // neutral enemies can't hurt bases
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
    const p = this.players[u.player];
    if (shot.team === u.team) {
      // a streak of friendly hits before the stun wears off: the third one counts as a real hit
      u.stunHits = u.stunT > 0 ? (u.stunHits || 0) + 1 : 1;
      u.stunT = STUN_TIME;
      this.emit('stun', { unit: u, streak: u.stunHits });
      if (u.stunHits < FRIENDLY_STREAK) return;
      u.stunHits = 0; u.stunT = 0;
    }
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
        const start = tileCenter(this.starts[p.index]), probe = { ...start, w: UNIT, h: UNIT };
        if (!this.units.some(u => overlaps(probe, u))) { this.spawnPlayer(p.index); this.emit('respawn', { player: p.index }); }
      }
      return;
    }
    const u = p.unit;
    if (u.shieldT > 0) u.shieldT -= dt;
    if (u.stunT > 0) { u.stunT -= dt; return; }
    if (p.frozenT > 0) { p.frozenT -= dt; u.frozen = p.frozenT > 0; return; }   // frozen by the opponent's clock
    u.frozen = false;
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
    if (!e.phased && e.spawnT <= 0 && unitCells(e).some(([cx, cy]) => this.grid.blocksUnit(cx, cy))) { this.unstick(e); if (e.dead) return; }
    const d = decide(e, this, dt);
    const px = e.x, py = e.y;
    const r = this.moveUnit(e, d.dir, dt);
    e.idleT = Math.abs(e.x - px) + Math.abs(e.y - py) > 0.01 ? 0 : (e.idleT || 0) + dt;
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

  // A rebuilt base brings the 8 tiles around it back to the map's initial terrain; any unit standing
  // on a cell that became solid is pushed to the nearest free spot.
  rebuildAround(b) {
    const cells = [];
    for (let cy = b.cy - 2; cy <= b.cy + 3; cy++) for (let cx = b.cx - 2; cx <= b.cx + 3; cx++) {
      if (!this.grid.inside(cx, cy) || this.grid.isBase(cx, cy)) continue;
      const i = cy * this.grid.cols + cx;
      if (this.grid.cells[i] !== this.initialCells[i]) { this.grid.cells[i] = this.initialCells[i]; cells.push([cx, cy]); }
    }
    this.emit('rebuild', { base: this.bases.indexOf(b), cells, x: b.cx * U + U, y: b.cy * U + U });
    for (const u of [...this.units]) if (unitCells(u).some(([cx, cy]) => this.grid.blocksUnit(cx, cy))) this.unstick(u, false);
  }

  // A ghost that turns solid inside terrain (or on another unit) moves to the nearest free lane spot;
  // with nothing free within RELOCATE_RADIUS it is removed so the wave can go on.
  unstick(e, removeIfStuck = true) {
    const others = this.units.filter(u => u !== e);
    if (freeAt(e, e.x, e.y, this.grid, others)) return;
    const sx = Math.round(e.x / U) * U, sy = Math.round(e.y / U) * U, R = RELOCATE_RADIUS * UNIT;
    let best = null, bd = Infinity;
    for (let y = sy - R; y <= sy + R; y += U) for (let x = sx - R; x <= sx + R; x += U) {
      const d = Math.hypot(x - e.x, y - e.y);
      if (d >= bd || x < UNIT / 2 || y < UNIT / 2 || x > this.grid.width - UNIT / 2 || y > this.grid.height - UNIT / 2) continue;
      if (freeAt(e, x, y, this.grid, others)) { best = [x, y]; bd = d; }
    }
    if (best) { e.x = best[0]; e.y = best[1]; this.emit('relocate', { unit: e }); }
    else if (removeIfStuck && e.enemy) { this.emit('guard', { unit: e }); this.destroyEnemy(e, null); }
  }

  /* ---------- the tick ---------- */
  tick(dt, inputs = []) {
    this.events = [];
    if (this.phase !== 'play') { this.phaseT += dt; return; }
    this.time += dt;
    if (this.frozenT > 0) this.frozenT -= dt;
    this.shovelT.forEach((t, bi) => { if (t > 0) { this.shovelT[bi] = t - dt; if (this.shovelT[bi] <= 0) { this.grid.buildFortress(false, bi); this.emit('shovel', { steel: false, base: bi }); } } });
    if (this.spawnT > 0) this.spawnT -= dt;
    this.trySpawnWave();
    if (this.mode === 'versus') {
      for (const b of this.bases) if (!b.alive && b.respawnT > 0) { b.respawnT -= dt; if (b.respawnT <= 0) { b.alive = true; this.rebuildAround(b); this.emit('baseUp', { base: this.bases.indexOf(b), x: b.cx * U + U, y: b.cy * U + U }); } }
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
      if (this.mode === 'coop' && this.wave.length && this.enemiesLeft <= 0) {
        // guard: leftover enemies that are stuck (or linger far too long) are blown up so the stage can end
        this.lingerT = (this.lingerT || 0) + dt;
        const left = this.units.filter(u => u.enemy);
        if (left.length && (left.every(e => (e.idleT || 0) > STUCK_TIME) || this.lingerT > LINGER_TIME)) for (const e of left) { this.emit('guard', { unit: e }); this.destroyEnemy(e, null); }
      }
      if (this.wave.length && this.enemiesLeft <= 0 && !this.units.some(u => u.enemy)) { this.clearT = (this.clearT || 0) + dt; if (this.clearT >= CLEAR_DELAY) this.finish('clear'); }
      if (this.players.every(p => !p.unit && p.lives <= 0)) this.finish('over');
    } else {
      const out = this.players.findIndex(p => !p.unit && p.lives <= 0);
      if (out >= 0) this.finish(1 - out);
    }
  }
}
