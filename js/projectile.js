// Projectiles: straight (classic shells), arc (catapult stones), beam (lasers), homing (will-o'-wisps).
// fire() checks the shooter's limits and creates one; stepProjectile() advances it and returns events
// for the world to apply (it never mutates the grid or units itself).
import { U, SHOT, UNIT, BULLET, MAX_LEVEL } from './config.js';
import { DIRS, cellsAt, overlaps } from './units.js';

export const STAR_DEFAULT = {
  straight: { 1: { speed: 1.5 }, 2: { cooldownMul: 0.5 }, 3: { steel: true, depth: 2 } },
  homing:   { 1: { speed: 1.5 }, 2: { shots: 2 }, 3: { steel: true, depth: 2 } },
  arc:      { 1: { cooldownMul: 0.6 }, 2: { rangeBonus: 2, splash: 3 }, 3: { steel: true } },
  beam:     { 1: { overheat: 0.3 }, 2: { burst: 2 }, 3: { steel: true, pierce: true } }
};
const RANGE = { arc: 8, beam: 7, homing: 10 };   // half cells
const BEAM_LIFE = 0.12;
const ANGLE = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };
const CW = { up: 'right', right: 'down', down: 'left', left: 'up' };
const EPS = 1e-6;

export function makeRules(o = {}) {
  return { kind: 'straight', speed: 1, cooldown: 0, cancel: true, range: null, overheat: 0.5, reflect: false, homing: 10, star: {}, ...o };
}

// merged star effects for a shooter level, theme overrides on top of the defaults
export function starEffects(rules, level = 0) {
  const out = {};
  for (let l = 1; l <= Math.min(level, MAX_LEVEL); l++) Object.assign(out, STAR_DEFAULT[rules.kind]?.[l], rules.star?.[l]);
  return out;
}

const front = u => ({ x: u.x + DIRS[u.dir][0] * UNIT / 2, y: u.y + DIRS[u.dir][1] * UNIT / 2 });
const lattice = v => Math.round(v / U) * U;
const hostile = (a, b) => a !== b && a.team !== b.team && !b.dead;
const baseRect = b => ({ x: b.cx * U + U, y: b.cy * U + U, w: UNIT, h: UNIT });

// Walk the shooter's lane from its front in half-cell steps.
// opts: { ignoreWalls, target(unit) → bool, base: whether bases count as targets, fortressWalls: stop at fortress walls even when ignoring }
export function raycast(grid, units, from, dir, maxCells, opts = {}) {
  const [dx, dy] = DIRS[dir];
  for (let k = 1; k <= maxCells; k++) {
    const x = from.x + dx * k * U, y = from.y + dy * k * U;
    const cells = cellsAt(x, y, dx ? 1 : SHOT, dy ? 1 : SHOT);
    const wall = cells.find(([cx, cy]) => grid.blocksShot(cx, cy));
    if (wall && (!opts.ignoreWalls || (opts.fortressWalls && grid.inFortress(wall[0], wall[1])))) return { kind: 'wall', cx: wall[0], cy: wall[1], x, y, dist: k * U };
    if (opts.target) {
      const probe = { x, y, w: SHOT, h: SHOT };
      const unit = units.find(u => opts.target(u) && overlaps(probe, u));
      if (unit) return { kind: 'unit', unit, x, y, dist: k * U };
      if (opts.base) {
        const bi = grid.bases.findIndex((b, i) => overlaps(probe, baseRect(b)) && (opts.base === true || opts.base(i)));
        if (bi >= 0) return { kind: 'base', base: bi, x, y, dist: k * U };
      }
    }
    if (!grid.inside(...cells[0])) return { kind: 'edge', x, y, dist: k * U };
  }
  const x = from.x + dx * maxCells * U, y = from.y + dy * maxCells * U;
  return { kind: 'range', x, y, dist: maxCells * U };
}

function canFire(unit, rules, world, fx) {
  if (unit.dead || unit.spawnT > 0 || unit.stunT > 0 || unit.noFire) return false;
  const now = world.time;
  if ((unit.cooldownUntil || 0) > now + EPS) return false;
  if (rules.kind === 'beam') {
    if ((unit.heatUntil || 0) > now + EPS) return false;
    return true;
  }
  if (rules.kind === 'straight') return true;   // shells fire at a fixed interval (the cooldown), however many are flying
  const max = fx.shots || 1;
  const inFlight = world.shots.filter(s => s.owner === unit && s.alive).length;
  return inFlight < max;
}

export function fire(unit, rules, world) {
  const fx = starEffects(rules, unit.level || 0);
  if (!canFire(unit, rules, world, fx)) return null;
  const f = front(unit);
  const p = {
    kind: rules.kind, owner: unit, team: unit.team, dir: unit.dir, x: f.x, y: f.y, w: SHOT, h: SHOT,
    alive: true, t: 0, steel: !!fx.steel, depth: fx.depth || 1, cancel: rules.cancel, level: unit.level || 0
  };
  const cooldown = (rules.cooldown || 0) * (fx.cooldownMul ?? 1) * (unit.enemy ? 2 : 1);
  if (cooldown) unit.cooldownUntil = world.time + cooldown;
  const fast = unit.role === 'power' || fx.speed;
  p.speed = (fast ? BULLET.fast : BULLET.normal) * (rules.speed || 1);
  const target = u => hostile(unit, u);
  if (rules.kind === 'arc') {
    const range = (rules.range || RANGE.arc) + (fx.rangeBonus || 0);
    // first hostile unit (or, for enemies, the base) regardless of walls; fortress walls always stop it
    // the base of another team is a target (coop: enemies only; versus: the other player's)
    const hostileBase = i => (world.bases?.[i]?.team ?? 0) !== unit.team;
    let hit = raycast(world.grid, world.units, f, unit.dir, range, { ignoreWalls: true, fortressWalls: true, target, base: hostileBase });
    if (hit.kind === 'range' || hit.kind === 'edge') hit = raycast(world.grid, world.units, f, unit.dir, range, {});
    const [dx, dy] = DIRS[unit.dir];
    if (hit.kind === 'wall') {
      // far edge of the wall cell along the lane; the lane coordinate across
      p.toX = dx ? (dx > 0 ? hit.cx + 1 : hit.cx) * U : lattice(f.x);
      p.toY = dy ? (dy > 0 ? hit.cy + 1 : hit.cy) * U : lattice(f.y);
    } else if (hit.kind === 'unit') { p.toX = lattice(hit.unit.x); p.toY = lattice(hit.unit.y); }
    else if (hit.kind === 'base') { const b = baseRect(world.grid.bases[hit.base]); p.toX = lattice(b.x); p.toY = lattice(b.y); }
    else { p.toX = lattice(hit.x); p.toY = lattice(hit.y); }
    p.fromX = f.x; p.fromY = f.y;
    const dist = Math.hypot(p.toX - f.x, p.toY - f.y);
    p.flight = 0.12 + dist / UNIT * 0.07;
    p.splash = fx.splash || 2;
  } else if (rules.kind === 'beam') {
    p.range = rules.range || RANGE.beam;
    p.reflect = !!rules.reflect;
    p.pierce = !!fx.pierce;
    p.life = BEAM_LIFE;
    const burst = fx.burst || 1;
    unit.burstLeft = (unit.burstLeft ?? burst) - 1;
    if (unit.burstLeft <= 0) { unit.heatUntil = world.time + (fx.overheat ?? rules.overheat ?? 0.5); unit.burstLeft = burst; }
  } else if (rules.kind === 'homing') {
    p.angle = ANGLE[unit.dir];
    p.rate = (rules.homing ?? 10) * Math.PI / 180;
    p.range = (rules.range || RANGE.homing) * U;
    p.travelled = 0;
  }
  return p;
}

// brick strip a shot breaks when it meets a wall at (cx, cy): 2 across the lane, `depth` deep
function wallStrip(p, grid, hitCells) {
  const [dx, dy] = DIRS[p.dir];
  // the two cells across the lane (the shot sits on a lane boundary), then `depth` cells deep
  const across = [...new Set(cellsAt(p.x, p.y, dy ? SHOT + 8 : 1, dx ? SHOT + 8 : 1).map(c => dy ? c[0] : c[1]))];
  const row = hitCells[0];
  const out = [];
  for (let d = 0; d < p.depth; d++) for (const a of across) {
    const cx = dx ? row[0] + dx * d : a, cy = dy ? row[1] + dy * d : a;
    const v = grid.cellAt(cx, cy);
    if (v === 'brick' || (v === 'steel' && p.steel)) out.push([cx, cy]);
  }
  return out;
}

function hitSomething(p, world) {
  const { grid, units, shots } = world;
  const cells = cellsAt(p.x, p.y, SHOT, SHOT);
  const walls = cells.filter(([cx, cy]) => grid.blocksShot(cx, cy));
  if (walls.length) {
    p.alive = false;
    return [{ type: 'hitWall', x: p.x, y: p.y, cells: wallStrip(p, grid, walls), steel: p.steel, shot: p }];
  }
  const bi = grid.bases.findIndex(b => overlaps(p, baseRect(b)));
  if (bi >= 0) { p.alive = false; return [{ type: 'hitBase', base: bi, x: p.x, y: p.y, shot: p }]; }
  // enemy shots pass other enemies (as in the original); players are hit by anything
  const unit = units.find(u => u !== p.owner && !u.dead && overlaps(p, u) && !(u.spawnT > 0) && !u.phased && (u.team !== p.team || u.player !== undefined));
  if (unit) {
    p.alive = false;
    return [{ type: unit.team === p.team ? 'hitFriend' : 'hitUnit', unit, x: p.x, y: p.y, shot: p }];
  }
  if (p.cancel) {
    const other = shots.find(s => s !== p && s.alive && s.team !== p.team && s.cancel && (s.kind === 'straight' || s.kind === 'homing') && overlaps(p, s));
    if (other) { p.alive = false; other.alive = false; return [{ type: 'cancel', x: p.x, y: p.y, shot: p, other }]; }
  }
  return null;
}

function stepStraight(p, dt, world) {
  const [dx, dy] = DIRS[p.dir];
  const d = p.speed * dt;
  // sub-step so a fast shot can't skip a half cell
  const n = Math.max(1, Math.ceil(d / (U / 2)));
  for (let i = 0; i < n; i++) {
    p.x += dx * d / n; p.y += dy * d / n;
    const ev = hitSomething(p, world);
    if (ev) return ev;
  }
  if (p.x < -U || p.y < -U || p.x > world.grid.width + U || p.y > world.grid.height + U) { p.alive = false; return [{ type: 'expire', shot: p }]; }
  return [];
}

function stepHoming(p, dt, world) {
  // steer toward the nearest hostile inside the ±45° cone ahead
  let best = null, bd = Infinity;
  for (const u of world.units) {
    if (u.team === p.team || u.dead) continue;
    const ang = Math.atan2(u.y - p.y, u.x - p.x);
    let diff = ang - p.angle;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    const d = Math.hypot(u.x - p.x, u.y - p.y);
    if (Math.abs(diff) <= Math.PI / 4 && d < bd) { bd = d; best = diff; }
  }
  if (best !== null) p.angle += Math.sign(best) * Math.min(Math.abs(best), p.rate * dt);
  const d = p.speed * dt, n = Math.max(1, Math.ceil(d / (U / 2)));
  for (let i = 0; i < n; i++) {
    p.x += Math.cos(p.angle) * d / n; p.y += Math.sin(p.angle) * d / n;
    p.dir = Math.abs(Math.cos(p.angle)) > Math.abs(Math.sin(p.angle)) ? (Math.cos(p.angle) > 0 ? 'right' : 'left') : (Math.sin(p.angle) > 0 ? 'down' : 'up');
    const ev = hitSomething(p, world);
    if (ev) return ev;
  }
  p.travelled += d;
  if (p.travelled >= p.range || p.x < -U || p.y < -U || p.x > world.grid.width + U || p.y > world.grid.height + U) { p.alive = false; return [{ type: 'expire', shot: p }]; }
  return [];
}

function stepArc(p, dt, world) {
  p.t += dt;
  if (p.t < p.flight) return [];
  p.alive = false;
  const s = p.splash, size = s * U - 2;
  const cx0 = p.toX / U, cy0 = p.toY / U;
  // 2×2 around the lattice point, 3×3 extends one more cell down/right
  const cells = [];
  for (let cy = cy0 - 1; cy < cy0 - 1 + s; cy++) for (let cx = cx0 - 1; cx < cx0 - 1 + s; cx++) {
    const v = world.grid.cellAt(cx, cy);
    if (v === 'brick' || (v === 'steel' && p.steel)) cells.push([cx, cy]);
  }
  const rect = { x: p.toX + (s - 2) * U / 2, y: p.toY + (s - 2) * U / 2, w: size, h: size };
  const ev = [{ type: 'land', x: p.toX, y: p.toY, t: p.t, cells, steel: p.steel, shot: p, splash: s }];
  for (const u of world.units) if (u !== p.owner && !u.dead && !(u.spawnT > 0) && !u.phased && overlaps(rect, u)) ev.push({ type: u.team === p.team ? 'hitFriend' : 'hitUnit', unit: u, x: p.toX, y: p.toY, shot: p });
  world.grid.bases.forEach((b, i) => { if (overlaps(rect, baseRect(b))) ev.push({ type: 'hitBase', base: i, x: p.toX, y: p.toY, shot: p }); });
  return ev;
}

function stepBeam(p, dt, world) {
  if (!p.segments) {
    const { grid, units } = world;
    const hitUnits = new Set();
    const target = u => u !== p.owner && !u.dead && !(u.spawnT > 0) && !u.phased && !hitUnits.has(u) && (u.team !== p.team || u.player !== undefined);
    const ev = [];
    p.segments = [];
    let from = { x: p.x, y: p.y }, dir = p.dir, left = p.range, bounced = false;
    while (left > 0) {
      const hit = raycast(grid, units, from, dir, left, { target, base: true });
      const [dx, dy] = DIRS[dir];
      const end = hit.kind === 'wall' ? { x: hit.x - dx * U / 2, y: hit.y - dy * U / 2 } : { x: hit.x, y: hit.y };
      p.segments.push({ x0: from.x, y0: from.y, x1: end.x, y1: end.y, dir });
      if (hit.kind === 'unit') { hitUnits.add(hit.unit); ev.push({ type: hit.unit.team === p.team ? 'hitFriend' : 'hitUnit', unit: hit.unit, x: hit.x, y: hit.y, shot: p }); if (!p.pierce) break; }
      else if (hit.kind === 'base') { ev.push({ type: 'hitBase', base: hit.base, x: hit.x, y: hit.y, shot: p }); break; }
      else if (hit.kind === 'wall') {
        const steel = grid.cellAt(hit.cx, hit.cy) === 'steel';
        const strip = { ...p, dir, x: hit.x, y: hit.y, depth: 1 };
        ev.push({ type: 'hitWall', x: hit.x, y: hit.y, cells: wallStrip(strip, grid, [[hit.cx, hit.cy]]), steel: p.steel, shot: p });
        if (steel && p.reflect && !bounced && !grid.inFortress(hit.cx, hit.cy) && !p.steel) {
          bounced = true;
          from = { x: hit.x - dx * U, y: hit.y - dy * U };   // the last free step
          dir = CW[dir];
          left -= Math.round(hit.dist / U);
          continue;
        }
        break;
      } else break;
      left -= Math.round(hit.dist / U);
      from = end;
    }
    p.events = ev;
    p.t = 0;
    return ev;
  }
  p.t += dt;
  if (p.t >= p.life) { p.alive = false; return [{ type: 'expire', shot: p }]; }
  return [];
}

export function stepProjectile(p, dt, world) {
  if (!p.alive) return [];
  switch (p.kind) {
    case 'arc': return stepArc(p, dt, world);
    case 'beam': return stepBeam(p, dt, world);
    case 'homing': return stepHoming(p, dt, world);
    default: return stepStraight(p, dt, world);
  }
}
