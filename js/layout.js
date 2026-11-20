// Screen size → main view rect + touch button positions (ported from versus, generalized to any view aspect).
// 'side' puts each touch player's cluster beside the view; 'bottom' puts the clusters under it.
// One touch player: D-pad left, fire right. Two: P1 cluster left, P2 cluster right.
import { MODES, TILE } from './config.js';

export const SIDE_MIN_RATIO = 0.75;
export const HUD_SIDE = 96, HUD_TOP = 64;   // HUD strip: right of the map in landscape, above it in portrait

export function viewSize(mode, orientation) {
  const [tw, th] = MODES[mode].tiles, mw = tw * TILE, mh = th * TILE;
  return orientation === 'landscape' ? { w: mw + HUD_SIDE, h: mh } : { w: mw, h: mh + HUD_TOP };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function metrics(W, H) {
  // portrait screens have room under the view, so the buttons grow
  const btn = Math.round(clamp(Math.min(W, H) * (H > W ? 0.17 : 0.13), 44, 92));
  const gap = Math.round(btn * 0.22);
  const margin = Math.max(8, Math.round(btn * 0.18));
  return { btn, gap, margin, sep: Math.round(btn * 0.6) };
}
const padR = m => m.btn * 0.95;

// one column: [fire] above [D-pad], bottom aligned; parts picks which of the two to place
function sideCluster(cx, bottom, m, player, parts) {
  const { btn, gap } = m, r = btn / 2, rs = padR(m);
  const out = [];
  let y = bottom;
  if (parts.includes('move')) { out.push({ player, action: 'dpad', x: cx, y: y - rs, r: rs }); y -= 2 * rs + gap; }
  if (parts.includes('fire')) out.push({ player, action: 'fire', x: cx, y: y - r, r });
  return out;
}

function sideLayout(W, H, n, m, aspect) {
  const gutter = 2 * padR(m) + 2 * m.margin;
  const clusterH = 2 * padR(m) + m.btn + m.gap + 2 * m.margin;
  const vw = Math.min(W - 2 * gutter, H * aspect);
  if (vw <= 0 || clusterH > H) return null;
  const vh = vw / aspect;
  const view = { x: (W - vw) / 2, y: (H - vh) / 2, w: vw, h: vh };
  const leftCx = view.x / 2, rightCx = W - view.x / 2, bottom = H - m.margin;
  const buttons = n === 2
    ? [...sideCluster(leftCx, bottom, m, 0, ['move', 'fire']), ...sideCluster(rightCx, bottom, m, 1, ['move', 'fire'])]
    : [...sideCluster(leftCx, bottom, m, 0, ['move']), ...sideCluster(rightCx, bottom, m, 0, ['fire'])];
  return { mode: 'side', view, btn: m.btn, buttons };
}

function bottomLayout(W, H, n, m0, aspect) {
  let m = { ...m0 };
  const half = n === 2 ? W / 2 - m.margin * 1.5 : W - m.margin * 2;
  const rowW = mm => 2 * padR(mm) + mm.sep + mm.btn;     // [D-pad] sep [fire]
  let twoRows = false;
  if (n === 2 && rowW(m) > half) {
    twoRows = true;
    if (2 * padR(m) > half) { const btn = Math.floor(half / 1.9); m = { ...m, btn, gap: Math.round(btn * 0.22), sep: Math.round(btn * 0.6) }; }
  }
  const rs = padR(m), r = m.btn / 2;
  const ch = (twoRows ? 2 * rs + m.gap + m.btn : 2 * rs) + 2 * m.margin;
  const vh = Math.min(H - ch, W / aspect), vw = vh * aspect;
  // portrait: the view sits at the top and the controls take the middle of what is left;
  // otherwise the view is centered in the space above the control row
  const portrait = H > W;
  const view = { x: (W - vw) / 2, y: portrait ? 0 : (H - ch - vh) / 2, w: vw, h: vh };
  const rowH = ch - 2 * m.margin;
  const yPad = portrait ? vh + (H - vh - rowH) / 2 + rowH - rs : H - m.margin - rs;
  const buttons = [];
  const clusterW = twoRows ? 2 * rs : rowW(m);
  const cluster = (x0, player) => {
    buttons.push({ player, action: 'dpad', x: x0 + rs, y: yPad, r: rs });
    if (twoRows) buttons.push({ player, action: 'fire', x: x0 + rs, y: yPad - rs - m.gap - r, r });
    else buttons.push({ player, action: 'fire', x: x0 + 2 * rs + m.sep + r, y: yPad, r });
  };
  if (n === 2) { cluster(m.margin, 0); cluster(W - m.margin - clusterW, 1); }
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
  const L = side && (force === 'side' || side.view.w >= bottom.view.w * SIDE_MIN_RATIO) ? side : bottom;
  if (n === 1) L.buttons.forEach(b => { b.player = touch[0]; });
  return L;
}
