// Touch buttons, keyboard and gamepads merged into per-player input (ported from versus).
// Actions: up down left right fire start select.
export const DPAD_DIAGONAL = 80;
export const HAPTIC_MS = 12;           // fire tick with one player on touch
const NO_DIRS = Object.freeze({ up: false, down: false, left: false, right: false });

export function dpadSlopes(sensitivity = DPAD_DIAGONAL) {
  const f = 2 * sensitivity / (100 + sensitivity);
  const high = f * (0.375 * Math.PI) + (1 - f) * (0.25 * Math.PI);
  const low = f * (0.125 * Math.PI) + (1 - f) * (0.25 * Math.PI);
  return { low: Math.tan(low), high: Math.tan(high) };
}
const SLOPES = dpadSlopes();

export function dpadDirs(dx, dy, { low, high } = SLOPES) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (!ax && !ay) return NO_DIRS;
  const vert = ay > low * ax, horiz = ay < high * ax;
  return { up: vert && dy < 0, down: vert && dy > 0, left: horiz && dx < 0, right: horiz && dx > 0 };
}

// A finger that started on the D-pad keeps pressing until it lifts: wherever it is now, the
// direction (one or two keys) is read from its angle around the pad center. rect: the pad's box.
export function dpadAim(rect, x, y) {
  const R = rect.width / 2;
  return dpadDirs(x - rect.left - R, y - rect.top - R);
}

const blank = () => ({ up: false, down: false, left: false, right: false, fire: false, start: false, select: false, a: false, b: false, x: false, y: false });

export function readPad(pad, dead = 0.5) {
  const b = i => { const x = pad.buttons[i]; return !!x && (x.pressed || x.value > 0.5); };
  const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
  let hx = 0, hy = 0;
  if (pad.mapping !== 'standard') {
    if (pad.axes.length > 7) { hx = Math.round(pad.axes[6] || 0); hy = Math.round(pad.axes[7] || 0); }
    const hat = pad.axes[9];
    if (hat !== undefined && hat >= -1.05 && hat <= 1.05) {
      const dir = Math.round((hat + 1) / (2 / 7));
      hx = [0, 1, 1, 1, 0, -1, -1, -1][dir] ?? 0;
      hy = [-1, -1, 0, 1, 1, 1, 0, -1][dir] ?? 0;
    }
  }
  return {
    up: b(12) || ay < -dead - 0.05 || hy < 0, down: b(13) || ay > dead + 0.05 || hy > 0,
    left: b(14) || ax < -dead || hx < 0, right: b(15) || ax > dead || hx > 0,
    a: b(0), b: b(1), x: b(2), y: b(3), lb: b(4), rb: b(5), select: b(8), start: b(9)
  };
}

const KEYMAP = [
  { KeyA: 'left', KeyD: 'right', KeyW: 'up', KeyS: 'down', KeyF: 'fire', KeyG: 'fire' },
  { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', KeyK: 'fire', KeyL: 'fire' }
];
// editor keys (P1 only): Space place, Backspace erase, Tab next tool, KeyQ brush size
const EDIT_KEYS = { Space: 'a', Backspace: 'b', Tab: 'y', KeyQ: 'x' };
const GAME_KEYS = new Set([...KEYMAP.flatMap(Object.keys), 'Escape', ...Object.keys(EDIT_KEYS)]);

export class InputManager {
  constructor() {
    this.pointers = new Map(); // pointerId → { player, actions: Set }
    this.dpads = new Map();    // pointerId → { player, el, on, dirs }
    this.keys = new Set();
    this.players = 1;
    this.onPadsChanged = () => {};
    this.padCount = 0;
    addEventListener('keydown', e => { if (e.target.closest?.('input, textarea')) return; if (GAME_KEYS.has(e.code)) { this.keys.add(e.code); e.preventDefault(); } });
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.pointers.clear(); this.dpads.clear(); });
    addEventListener('gamepadconnected', () => this.pollPads());
    addEventListener('gamepaddisconnected', () => this.pollPads());
  }

  // RetroArch-style overlay D-pad: direction from the angle to the center; the press lasts until the finger lifts.
  bindTouch(layer) {
    const hit = (x, y) => {
      const el = document.elementFromPoint(x, y)?.closest('[data-action]');
      return el && !el.classList.contains('off') ? el : null;
    };
    const aim = (st, e) => {
      st.dirs = dpadAim(st.el.getBoundingClientRect(), e.clientX, e.clientY);
      st.el.dataset.dirs = Object.keys(st.dirs).filter(k => st.dirs[k]).join(' ');
    };
    layer.addEventListener('pointerdown', e => {
      e.preventDefault();
      const el = hit(e.clientX, e.clientY);
      if (!el) return;
      try { el.setPointerCapture(e.pointerId); } catch { /* not supported */ }
      if (el.dataset.action === 'dpad') {
        const st = { player: +el.dataset.player, el, on: true, dirs: NO_DIRS };
        this.dpads.set(e.pointerId, st);
        aim(st, e);
      } else {
        this.pointers.set(e.pointerId, { player: +el.dataset.player, actions: new Set([el.dataset.action]) });
        if (this.players === 1) navigator.vibrate?.(HAPTIC_MS);
      }
      this.refreshPressed(layer);
    });
    layer.addEventListener('pointermove', e => {
      const st = this.dpads.get(e.pointerId);
      if (st) { aim(st, e); this.refreshPressed(layer); }
    });
    const end = e => {
      const st = this.dpads.get(e.pointerId);
      if (st) { st.el.dataset.dirs = ''; this.dpads.delete(e.pointerId); }
      this.pointers.delete(e.pointerId);
      this.refreshPressed(layer);
    };
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) layer.addEventListener(ev, end);
  }

  refreshPressed(layer) {
    const on = new Set([...this.pointers.values()].flatMap(p => [...p.actions].map(a => `${p.player}:${a}`)));
    for (const st of this.dpads.values()) if (st.on) on.add(`${st.player}:dpad`);
    for (const el of layer.querySelectorAll('[data-action]')) el.classList.toggle('down', on.has(`${el.dataset.player}:${el.dataset.action}`));
  }

  pads() { return [...(navigator.getGamepads?.() || [])].filter(p => p && p.connected).sort((a, b) => a.index - b.index); }

  pollPads() {
    const n = this.pads().length;
    if (n !== this.padCount) { this.padCount = n; this.onPadsChanged(); }
  }

  // players currently on a gamepad (pads go to players in order)
  padPlayers() { return this.pads().slice(0, this.players).map((_, i) => i); }

  read(player) {
    const s = blank();
    for (const p of this.pointers.values()) if (p.player === player) for (const a of p.actions) s[a] = true;
    for (const st of this.dpads.values()) if (st.player === player) { s.up ||= st.dirs.up; s.down ||= st.dirs.down; s.left ||= st.dirs.left; s.right ||= st.dirs.right; }
    const maps = this.players === 1 ? KEYMAP : [KEYMAP[player]];
    for (const map of maps) for (const [code, action] of Object.entries(map)) if (this.keys.has(code)) s[action] = true;
    if (player === 0) { if (this.keys.has('Escape')) s.start = true; for (const [code, a] of Object.entries(EDIT_KEYS)) if (this.keys.has(code)) s[a] = true; }
    const pad = this.pads()[player];
    if (pad && player < this.players) {
      const p = readPad(pad);
      s.up ||= p.up; s.down ||= p.down; s.left ||= p.left; s.right ||= p.right;
      s.fire ||= p.a || p.b;
      s.start ||= p.start; s.select ||= p.select;
      s.a ||= p.a; s.b ||= p.b; s.x ||= p.x; s.y ||= p.y;
    }
    return s;
  }

  padPressed(button) { return this.pads().some(p => { const x = p.buttons[button]; return !!x && (x.pressed || x.value > 0.5); }); }
}
