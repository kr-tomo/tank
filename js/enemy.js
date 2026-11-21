// Enemy decisions: wander with a bias toward the base and the players, fire at what is in front.
// Theme traits hook in here: 'dodge' sidesteps incoming shots. Returns { dir, fire }.
import { U, UNIT } from './config.js';
import { raycast } from './projectile.js';
import { DIRS, freeAt } from './units.js';

const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
const SIDES = { up: ['left', 'right'], down: ['left', 'right'], left: ['up', 'down'], right: ['up', 'down'] };
const SIGHT = 10;        // half cells an enemy looks ahead before firing
// enemy fire rate tuned to 0.8× (difficulty)
const REACTION = 2.0;      // chance per second to fire at a player in sight
const BASE_REACTION = 0.64; // …and at the base (the original's enemies mostly wander and shoot at random)
const DODGE_RANGE = 6 * UNIT;

const front = u => ({ x: u.x + DIRS[u.dir][0] * UNIT / 2, y: u.y + DIRS[u.dir][1] * UNIT / 2 });

// a player in our lane, facing us, within range and with no wall between: a laser needs no flight time
function aimingPlayer(e, world) {
  return world.units.find(u => {
    if (u.player === undefined || u.team === e.team || u.dead) return false;
    const [dx, dy] = DIRS[u.dir];
    const inLane = dx ? Math.abs(u.y - e.y) < UNIT / 2 + 4 : Math.abs(u.x - e.x) < UNIT / 2 + 4;
    const d = dx ? (e.x - u.x) * dx : (e.y - u.y) * dy;
    if (!inLane || d <= 0 || d > DODGE_RANGE) return false;
    const hit = raycast(world.grid, world.units, front(u), u.dir, Math.ceil(d / U), { target: v => v === e });
    return hit.kind === 'unit';
  });
}

function incomingShot(e, world) {
  if (world.rules?.kind === 'beam' && aimingPlayer(e, world)) return true;
  return world.shots.find(s => {
    if (!s.alive || s.team === e.team || (s.kind !== 'straight' && s.kind !== 'homing')) return false;
    const [dx, dy] = DIRS[s.dir];
    if (dx && Math.abs(s.y - e.y) < UNIT / 2 + 4) { const d = (e.x - s.x) * dx; return d > 0 && d < DODGE_RANGE; }
    if (dy && Math.abs(s.x - e.x) < UNIT / 2 + 4) { const d = (e.y - s.y) * dy; return d > 0 && d < DODGE_RANGE; }
    return false;
  });
}

function pickDir(e, world) {
  const w = { up: 1, down: 1, left: 1, right: 1 };
  const base = world.bases.find(b => b.alive && b.team !== e.team);
  if (base) {
    const bx = base.cx * U + U, by = base.cy * U + U;
    if (Math.abs(bx - e.x) > U) w[bx > e.x ? 'right' : 'left'] += 3;
    if (Math.abs(by - e.y) > U) w[by > e.y ? 'down' : 'up'] += 3;
  }
  const target = world.units.filter(u => u.player !== undefined && u.team !== e.team).sort((a, b) => Math.hypot(a.x - e.x, a.y - e.y) - Math.hypot(b.x - e.x, b.y - e.y))[0];
  if (target) {
    if (Math.abs(target.x - e.x) > U) w[target.x > e.x ? 'right' : 'left'] += 2;
    if (Math.abs(target.y - e.y) > U) w[target.y > e.y ? 'down' : 'up'] += 2;
  }
  w[OPP[e.dir]] *= 0.3;
  if (e.blocked) w[e.dir] *= 0.2;
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  let r = world.rand() * total;
  for (const [d, v] of Object.entries(w)) { r -= v; if (r <= 0) return d; }
  return 'down';
}

export function decide(e, world, dt) {
  const ai = e.ai;
  if (ai.lock) return { dir: ai.lock, fire: false };
  // sidestep a shot flying up our lane
  if (world.traits[e.role] === 'dodge') {
    if (ai.dodge && world.time < ai.dodge.until) return { dir: ai.dodge.dir, fire: false };
    ai.dodge = null;
    if (incomingShot(e, world)) {
      const dir = SIDES[e.dir].find(d => freeAt(e, e.x + DIRS[d][0] * UNIT, e.y + DIRS[d][1] * UNIT, world.grid, world.units)) || SIDES[e.dir][0];
      ai.dodge = { dir, until: world.time + 0.3 };
      return { dir, fire: false };
    }
  }
  ai.turnT -= dt;
  let dir = e.dir;
  if (ai.turnT <= 0 || e.blocked) { ai.turnT = 1 + world.rand() * 2; dir = pickDir(e, world); }
  let shoot = false;
  const hit = raycast(world.grid, world.units, front(e), dir, SIGHT, { target: u => u.team !== e.team && !u.dead && u.player !== undefined, base: true });
  if (hit.kind === 'unit' || hit.kind === 'base') shoot = ai.sure || world.rand() < (hit.kind === 'base' ? BASE_REACTION : REACTION) * dt;
  else { ai.fireT -= dt; if (ai.fireT <= 0) { shoot = true; ai.fireT = 2.5 * (0.5 + world.rand()); } }
  return { dir, fire: shoot };
}
