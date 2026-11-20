// Unit bodies on the grid: lane snapping (the original's 8px alignment, here 16px) and blocked movement.
import { U, UNIT } from './config.js';

const HALF = UNIT / 2, EPS = 1e-6;
export const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const vertical = d => d === 'up' || d === 'down';

export function makeUnit(o) {
  return { role: 'basic', x: 0, y: 0, dir: 'up', w: UNIT, h: UNIT, ...o };
}

export const laneSnap = v => Math.round(v / U) * U;

export function overlaps(a, b) {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 - EPS && Math.abs(a.y - b.y) < (a.h + b.h) / 2 - EPS;
}

// half cells the body at (x, y) covers
export function cellsAt(x, y, w = UNIT, h = UNIT) {
  const out = [];
  const x0 = Math.floor((x - w / 2 + EPS) / U), x1 = Math.ceil((x + w / 2 - EPS) / U) - 1;
  const y0 = Math.floor((y - h / 2 + EPS) / U), y1 = Math.ceil((y + h / 2 - EPS) / U) - 1;
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) out.push([cx, cy]);
  return out;
}
export const unitCells = u => cellsAt(u.x, u.y, u.w, u.h);

export function freeAt(unit, x, y, grid, others, blocks = (cx, cy) => grid.blocksUnit(cx, cy)) {
  for (const [cx, cy] of cellsAt(x, y, unit.w, unit.h)) if (blocks(cx, cy) || grid.isBase(cx, cy)) return false;
  const probe = { x, y, w: unit.w, h: unit.h };
  for (const o of others) if (o !== unit && overlaps(probe, o)) return false;
  return true;
}

// Face dir, snap the cross-axis coordinate to a lane when the axis changes, then advance up to dist px.
// opts.blocks(cx, cy) overrides what terrain blocks (ghosts pass bricks).
export function tryMove(unit, dir, dist, grid, others = [], opts = {}) {
  const blocks = opts.blocks || ((cx, cy) => grid.blocksUnit(cx, cy));
  let snapped = false;
  if (dir !== unit.dir) {
    const turn = vertical(dir) !== vertical(unit.dir);
    unit.dir = dir;
    if (turn) {
      const nx = vertical(dir) ? laneSnap(unit.x) : unit.x, ny = vertical(dir) ? unit.y : laneSnap(unit.y);
      if ((nx !== unit.x || ny !== unit.y) && freeAt(unit, nx, ny, grid, others, blocks)) { unit.x = nx; unit.y = ny; snapped = true; }
    }
  }
  const [dx, dy] = DIRS[dir];
  let moved = 0, blocked = false;
  while (moved < dist - EPS) {
    const step = Math.min(1, dist - moved);
    const nx = unit.x + dx * step, ny = unit.y + dy * step;
    if (!freeAt(unit, nx, ny, grid, others, blocks)) {
      // close the remaining gap to the obstacle (sub-pixel) by aligning to the cell edge
      const ax = dx ? laneSnap(unit.x) : unit.x, ay = dy ? laneSnap(unit.y) : unit.y;
      if ((ax !== unit.x || ay !== unit.y) && Math.abs(ax - unit.x) <= step && Math.abs(ay - unit.y) <= step && freeAt(unit, ax, ay, grid, others, blocks)) { unit.x = ax; unit.y = ay; }
      blocked = true; break;
    }
    unit.x = nx; unit.y = ny; moved += step;
  }
  return { moved, snapped, blocked };
}
