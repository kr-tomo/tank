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
const RANGE = { arc: 8 };   // half cells
// Will-o'-wisp: weaves along its lane, flies straight for `straight` tiles, then homes on the nearest hostile
// inside a ±cone, turning at most `turn` deg/s, and fades after `range` tiles.
export const WISP = { amp: 5, period: 32, straight: 2, cone: 45, turn: 150, range: 8 };
// Laser: a bolt that crosses 4 tiles in 0.5 s, cancels against other lasers, and reflects off hull plating
// (steel outside the fortress) up to `bounces` times, each reflection giving `legAfter` tiles of reach.
export const BEAM = { speed: 768, range: 4, legAfter: 3, bounces: 2, width: 10 };
const ANGLE = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };
const CW = { up: 'right', right: 'down', down: 'left', left: 'up' };
const CCW = { up: 'left', left: 'down', down: 'right', right: 'up' };
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
        const bi = grid.bases.findIndex((b, i) => overlaps(probe, baseRect(b)) && (opts.base === true || opts.base(i)) && (opts.alive ? opts.alive(i) : true));
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
    const hostileBase = i => (world.bases?.[i]?.team ?? 0) !== unit.team && (world.bases?.[i]?.alive ?? true);
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
    p.speed = BEAM.speed * (fx.speed || 1);
    p.left = (rules.range || BEAM.range) * UNIT;    // reach of the current leg, px
    p.reflect = !!rules.reflect;
    p.pierce = !!fx.pierce;
    p.bounces = 0; p.dirs = [unit.dir]; p.path = [{ x: f.x, y: f.y }]; p.hitUnits = new Set();   // path: muzzle, every corner; the head is p.x/p.y
    p.w = p.h = BEAM.width;
    p.x = f.x; p.y = f.y;
    const burst = fx.burst || 1;
    unit.burstLeft = (unit.burstLeft ?? burst) - 1;
    if (unit.burstLeft <= 0) { unit.heatUntil = world.time + (fx.overheat ?? rules.overheat ?? 0.5); unit.burstLeft = burst; }
  } else if (rules.kind === 'homing') {
    p.angle = ANGLE[unit.dir];
    p.rate = (rules.homing || WISP.turn) * Math.PI / 180;
    p.range = (rules.range || WISP.range) * UNIT;
    p.travelled = 0; p.cx = f.x; p.cy = f.y; p.target = null;
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
  const bi = grid.bases.findIndex((b, i) => overlaps(p, baseRect(b)) && (world.bases?.[i]?.alive ?? true));
  if (bi >= 0) { p.alive = false; return [{ type: 'hitBase', base: bi, x: p.x, y: p.y, shot: p }]; }
  // enemy shots pass other enemies (as in the original); players are hit by anything
  const unit = units.find(u => u !== p.owner && !u.dead && overlaps(p, u) && !(u.spawnT > 0) && !u.phased && (u.team !== p.team || u.player !== undefined));
  if (unit) {
    p.alive = false;
    return [{ type: unit.team === p.team ? 'hitFriend' : 'hitUnit', unit, x: p.x, y: p.y, shot: p }];
  }
  if (p.cancel) {
    const other = shots.find(s => s !== p && s.alive && s.team !== p.team && s.cancel && (s.kind === 'straight' || s.kind === 'homing' || s.kind === 'beam') && overlaps(p, s));
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
  // after the straight run, home on the nearest hostile inside the cone; the lock drops when it leaves the cone
  if (p.travelled >= WISP.straight * UNIT) {
    const cone = WISP.cone * Math.PI / 180;
    const bearing = u => { let d = Math.atan2(u.y - p.cy, u.x - p.cx) - p.angle; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
    if (p.target && (p.target.dead || Math.abs(bearing(p.target)) > cone)) p.target = null;
    if (!p.target) {
      let best = null, bd = Infinity;
      for (const u of world.units) {
        if (u.team === p.team || u.dead || u.spawnT > 0) continue;
        const d = Math.hypot(u.x - p.cx, u.y - p.cy);
        if (Math.abs(bearing(u)) <= cone && d < bd) { bd = d; best = u; }
      }
      p.target = best;
    }
    if (p.target) { const diff = bearing(p.target); p.angle += Math.sign(diff) * Math.min(Math.abs(diff), p.rate * dt); }
  } else p.target = null;
  const d = p.speed * dt, n = Math.max(1, Math.ceil(d / (U / 2)));
  for (let i = 0; i < n; i++) {
    p.cx += Math.cos(p.angle) * d / n; p.cy += Math.sin(p.angle) * d / n; p.travelled += d / n;
    // the weave: a sine offset across the heading
    const off = Math.sin(p.travelled / WISP.period * 2 * Math.PI) * WISP.amp;
    p.x = p.cx - Math.sin(p.angle) * off; p.y = p.cy + Math.cos(p.angle) * off;
    p.dir = Math.abs(Math.cos(p.angle)) > Math.abs(Math.sin(p.angle)) ? (Math.cos(p.angle) > 0 ? 'right' : 'left') : (Math.sin(p.angle) > 0 ? 'down' : 'up');
    const ev = hitSomething(p, world);
    if (ev) return ev;
  }
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
  world.grid.bases.forEach((b, i) => { if ((world.bases?.[i]?.alive ?? true) && overlaps(rect, baseRect(b))) ev.push({ type: 'hitBase', base: i, x: p.toX, y: p.toY, shot: p }); });
  return ev;
}

// axis-aligned rect of a path segment, `w` wide
function segRect(a, b, w) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, w: Math.abs(b.x - a.x) + w, h: Math.abs(b.y - a.y) + w };
}
// every segment of a laser (path corners + the head)
export function beamSegments(p) {
  const pts = [...p.path, { x: p.x, y: p.y }], out = [];
  for (let i = 1; i < pts.length; i++) out.push([pts[i - 1], pts[i]]);
  return out;
}
// cut a laser at point c on its segment i: everything past the crossing is voided
function cutBeam(p, i, c) {
  p.path = p.path.slice(0, i + 1);
  p.x = c.x; p.y = c.y;
  p.alive = false;
}

function stepBeam(p, dt, world) {
  const { grid, units, shots } = world;
  const d = p.speed * dt, n = Math.max(1, Math.ceil(d / 4));
  const ev = [];
  const target = u => u !== p.owner && !u.dead && !p.hitUnits.has(u) && !(u.spawnT > 0) && !u.phased && (u.team !== p.team || u.player !== undefined);
  for (let i = 0; i < n; i++) {
    const [dx, dy] = DIRS[p.dir], step = d / n;
    p.x += dx * step; p.y += dy * step; p.left -= step;
    // walls at the head
    const cells = cellsAt(p.x, p.y, p.w, p.h);
    const walls = cells.filter(([cx, cy]) => grid.blocksShot(cx, cy));
    if (walls.length) {
      const [cx, cy] = walls[0];
      const steel = grid.cellAt(cx, cy) === 'steel';
      ev.push({ type: 'hitWall', x: p.x, y: p.y, cells: wallStrip({ ...p, depth: 1 }, grid, walls), steel: p.steel, shot: p });
      if (steel && p.reflect && !p.steel && p.bounces < BEAM.bounces && grid.inside(cx, cy) && !grid.inFortress(cx, cy)) {
        // Reflect toward the side of the 32px block the bolt is offset to (right-positive across the
        // heading); a dead-center hit alternates. The bolt backs out of the wall and leaves along the face.
        const bx = (cx >> 1) * UNIT + UNIT / 2, by = (cy >> 1) * UNIT + UNIT / 2;
        const rx = -dy, ry = dx;
        const off = (p.x - bx) * rx + (p.y - by) * ry;
        let side;
        if (Math.abs(off) < 1) { world.beamFlip = !world.beamFlip; side = world.beamFlip ? 1 : -1; } else side = Math.sign(off);
        const turned = side > 0 ? CW[p.dir] : CCW[p.dir];
        p.x -= dx * step; p.y -= dy * step;
        p.dir = turned; p.dirs.push(turned); p.bounces++; p.left = BEAM.legAfter * UNIT; p.side = side; p.off = Math.abs(off);
        p.path.push({ x: p.x, y: p.y });
        ev.push({ type: 'reflect', x: p.x, y: p.y, dir: turned, shot: p });
        continue;
      }
      p.alive = false; return ev;
    }
    // another laser's trail: both are voided past the crossing
    const head = { x: p.x, y: p.y, w: p.w, h: p.h };
    for (const s of shots) {
      if (s === p || !s.alive || s.kind !== 'beam' || s.team === p.team) continue;
      const segs = beamSegments(s);
      for (let k = 0; k < segs.length; k++) {
        const [a, b] = segs[k];
        if (!overlaps(head, segRect(a, b, s.w))) continue;
        // crossing point: the head projected onto that segment
        const c = a.x === b.x ? { x: a.x, y: p.y } : { x: p.x, y: a.y };
        cutBeam(s, k, c);
        p.alive = false;
        ev.push({ type: 'cancel', x: c.x, y: c.y, shot: p, other: s });
        return ev;
      }
    }
    // the base and units: at the head and anywhere along the trail
    const bi = grid.bases.findIndex((b, i) => (world.bases?.[i]?.alive ?? true) && (overlaps(head, baseRect(b)) || beamSegments(p).some(([a, c]) => overlaps(segRect(a, c, p.w), baseRect(b)))));
    if (bi >= 0) { p.alive = false; ev.push({ type: 'hitBase', base: bi, x: p.x, y: p.y, shot: p }); return ev; }
    const rects = [head, ...beamSegments(p).map(([a, c]) => segRect(a, c, p.w))];
    for (const u of units) {
      if (!target(u)) continue;
      const r = rects.find(rc => overlaps(rc, u));
      if (!r) continue;
      p.hitUnits.add(u);
      ev.push({ type: u.team === p.team ? 'hitFriend' : 'hitUnit', unit: u, x: u.x, y: u.y, shot: p });
      if (!p.pierce && r === head) { p.alive = false; return ev; }
    }
    if (p.left <= 0 || p.x < -U || p.y < -U || p.x > grid.width + U || p.y > grid.height + U) { p.alive = false; ev.push({ type: 'expire', shot: p }); return ev; }
  }
  return ev;
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
