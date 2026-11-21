// Screen size → main view rect + touch button positions (ported from versus v14, generalized to any view aspect).
// 'side' mode: the view takes the full height and each touch player's cluster sits in the gutter beside
//   it (a cluster wider than its gutter rides over the view's edge like a RetroArch overlay).
// 'bottom' mode: the clusters go under the view; in portrait the view sits at the top.
// One touch player: D-pad left, fire right. Two: P1 cluster left, P2 cluster right.
import { MODES, TILE } from './config.js';

export const HUD_SIDE = 96, HUD_TOP = 64;   // HUD strip: right of the map in landscape, above it in portrait
// Minimum control size (versus v14): buttons are 19.5% of the short side, 66..126px; the D-pad is 1.9 buttons wide.
export const BTN_RATIO = 0.195;
export const BTN_MIN = 66;
export const BTN_MAX = 126;
export const DPAD_RATIO = 0.95;
// Side mode may shrink the view until at most this share of a cluster's innermost element covers the view's edge.
export const SIDE_OVERLAP = 0.5;

export function viewSize(mode, orientation) {
  const [tw, th] = MODES[mode].tiles, mw = tw * TILE, mh = th * TILE;
  return orientation === 'landscape' ? { w: mw + HUD_SIDE, h: mh } : { w: mw, h: mh + HUD_TOP };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function metrics(W, H) {
  const btn = Math.round(clamp(Math.min(W, H) * BTN_RATIO, BTN_MIN, BTN_MAX));
  const gap = Math.round(btn * 0.22);
  const margin = Math.max(8, Math.round(btn * 0.18));
  return { btn, gap, margin, sep: Math.round(btn * 0.6), padR: btn * DPAD_RATIO };
}

// A side cluster laid out from its left edge x0: the D-pad, then the fire button to its right.
function sideCluster(x0, bottom, m, player, parts) {
  const out = [];
  let x = x0;
  if (parts.includes('move')) { out.push({ player, action: 'dpad', x: x + m.padR, y: bottom - m.padR, r: m.padR }); x += 2 * m.padR + m.gap; }
  if (parts.includes('fire')) out.push({ player, action: 'fire', x: x + m.btn / 2, y: bottom - m.btn / 2, r: m.btn / 2 });
  return out;
}
const widthOf = (m, part) => part === 'move' ? 2 * m.padR : m.btn;
const clusterW = (m, parts) => parts.reduce((w, p) => w + widthOf(m, p), 0) + (parts.length - 1) * m.gap;

function sideLayout(W, H, n, m, aspect) {
  const parts = n === 2 ? [['move', 'fire'], ['move', 'fire']] : [['move'], ['fire']];
  // the gutter a cluster needs, letting its innermost element ride over the view by SIDE_OVERLAP
  const gutter = (p, inner) => clusterW(m, p) + 2 * m.margin - SIDE_OVERLAP * widthOf(m, inner);
  const need = Math.max(gutter(parts[0], parts[0][parts[0].length - 1]), gutter(parts[1], parts[1][0]));
  const clusterH = Math.max(2 * m.padR, m.btn) + 2 * m.margin;
  if (clusterH > H) return null;
  const vw = Math.min(H * aspect, W - 2 * need);
  if (vw <= 0) return null;
  const vh = vw / aspect;
  const view = { x: (W - vw) / 2, y: (H - vh) / 2, w: vw, h: vh };
  const bottom = H - m.margin;
  const left = sideCluster(m.margin, bottom, m, 0, parts[0]);
  const right = sideCluster(W - m.margin - clusterW(m, parts[1]), bottom, m, n === 2 ? 1 : 0, parts[1]);
  return { mode: 'side', view, btn: m.btn, buttons: [...left, ...right] };
}

const padW = m => 2 * m.padR;

function bottomLayout(W, H, n, m0, aspect) {
  let m = { ...m0 };
  const half = n === 2 ? W / 2 - m.margin * 1.5 : W - m.margin * 2;
  const wide = mm => padW(mm) + mm.sep + mm.btn;     // [D-pad] sep [fire]
  let twoRows = false;
  if (n === 2 && wide(m) > half) {
    twoRows = true;
    if (padW(m) > half) { const btn = Math.floor(half / (2 * DPAD_RATIO)); m = { ...m, btn, gap: Math.round(btn * 0.22), sep: Math.round(btn * 0.6), padR: btn * DPAD_RATIO }; }
  }
  const rs = m.padR, r = m.btn / 2;
  const rowH = twoRows ? 2 * rs + m.gap + m.btn : 2 * rs;
  const ch = rowH + 2 * m.margin;
  const vh = Math.min(H - ch, W / aspect), vw = vh * aspect;
  // portrait: the view sits at the top and the controls take the middle of what is left;
  // otherwise the view is centered in the space above the control row
  const portrait = H > W;
  const view = { x: (W - vw) / 2, y: portrait ? 0 : (H - ch - vh) / 2, w: vw, h: vh };
  const yPad = portrait ? vh + (H - vh - rowH) / 2 + rowH - rs : H - m.margin - rs;
  const buttons = [];
  const cw = twoRows ? Math.max(padW(m), m.btn) : wide(m);
  const cluster = (x0, player) => {
    buttons.push({ player, action: 'dpad', x: x0 + rs, y: yPad, r: rs });
    if (twoRows) buttons.push({ player, action: 'fire', x: x0 + rs, y: yPad - rs - m.gap - r, r });
    else buttons.push({ player, action: 'fire', x: x0 + padW(m) + m.sep + r, y: yPad, r });
  };
  if (n === 2) { cluster(m.margin, 0); cluster(W - m.margin - cw, 1); }
  else {
    buttons.push({ player: 0, action: 'dpad', x: m.margin + rs, y: yPad, r: rs });
    buttons.push({ player: 0, action: 'fire', x: W - m.margin - r, y: yPad, r });
  }
  return { mode: 'bottom', view, btn: m.btn, buttons };
}

// touch: the players that need on-screen buttons (a player on a gamepad needs none);
// with nobody on touch the view takes the whole screen. view: { w, h } from viewSize().
export function computeLayout(W, H, { players = 1, touch = Array.from({ length: players }, (_, i) => i), view = viewSize('coop', 'landscape'), force = null } = {}) {
  const aspect = view.w / view.h;
  if (!touch.length) {
    const vw = Math.min(W, H * aspect), vh = vw / aspect;
    return { mode: 'none', view: { x: (W - vw) / 2, y: (H - vh) / 2, w: vw, h: vh }, btn: 0, buttons: [] };
  }
  const n = touch.length >= 2 ? 2 : 1;
  const m = metrics(W, H);
  const side = force === 'bottom' ? null : sideLayout(W, H, n, m, aspect);
  const bottom = bottomLayout(W, H, n, m, aspect);
  // side wins when its view is at least as wide (a full-height view beats a strip of buttons)
  const L = side && (force === 'side' || side.view.w >= bottom.view.w) ? side : bottom;
  if (n === 1) L.buttons.forEach(b => { b.player = touch[0]; });
  return L;
}
