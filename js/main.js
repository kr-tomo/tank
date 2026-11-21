import { APP_VERSION } from './version.js';
import { VERSUS_TIMES } from './config.js';
import { computeLayout, viewSize } from './layout.js';
import { loadTheme } from './assets.js';
import { InputManager } from './input.js';
import { MenuNav, pickNext } from './menu.js';
import { Grid } from './grid.js';
import { World } from './world.js';
import { makeRules } from './projectile.js';
import { STAGES, VERSUS_MAPS, parseStage } from './stages.js';
import { EditorModel, MapStore, TOOLS } from './editor.js';
import { Stage } from './stage.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const stageEl = $('#stage'), controls = $('#controls'), pauseBtn = $('#pauseBtn'), exitBtn = $('#exitBtn'), editorBar = $('#editorBar');
const DPAD_HTML = '<i class="arm u">▲</i><i class="arm d">▼</i><i class="arm l">◀</i><i class="arm r">▶</i><i class="hub"></i>';
const THEME_IDS = ['classic', 'ancient', 'space', 'halloween'];
const MODE_LABEL = { '1p': '1인 플레이', coop: '2인 협동', versus: '2인 대전', editor: '맵 편집' };
const TOOL_NAMES = { brick: '벽돌', steel: '강철', water: '물', bush: '수풀', ice: '얼음', erase: '지우개' };
const SCREENS = {
  title: { focus: '#title [data-mode]', back: null },
  setup: { focus: '#startBtn', back: () => show('title') },
  maps: { focus: '#newCoopBtn', back: () => show('title') },
  pickMap: { focus: '#pickCancelBtn', back: () => closePick() },
  pause: { focus: '#resumeBtn', back: () => setPaused(false) },
  confirm: { focus: '#cancelQuitBtn', back: () => setPaused(false) },
  textbox: { focus: '#textboxCancel', back: () => $('#textboxCancel').click() }
};

const store = {
  load() { try { return JSON.parse(localStorage.getItem('tank.settings')) || {}; } catch { return {}; } },
  save(v) { try { localStorage.setItem('tank.settings', JSON.stringify(v)); } catch { /* storage unavailable */ } }
};
// lives: 3..10, or 0 for ∞; hitMode: 'destroy' | 'damage'
const settings = Object.assign({ mode: '1p', theme: 'classic', stage: 1, versusMap: 0, versusTime: 0, sound: true, customMap: null, lives: 3, hitMode: 'destroy' }, store.load());
const LIVES_STEPS = [3, 4, 5, 6, 7, 8, 9, 10, 0];
const mapStore = new MapStore();

let themes = {}, stage, input, nav, world = null, paused = false, activeScreen = 'title', playing = false, editing = false;
let editor = null, editorId = null, lastOrientation = null, layoutKey = '';
const focused = new Map();

/* ---------- screens ---------- */
function show(id) {
  activeScreen = id;
  for (const s of $$('.screen')) s.hidden = s.id !== id;
  const onStage = id === null || id === 'pause' || id === 'confirm' || id === 'textbox' || id === 'pickMap';
  stageEl.hidden = !(onStage && (playing || editing));
  controls.hidden = !(onStage && playing);
  editorBar.hidden = !(editing && (id === null || id === 'textbox'));
  pauseBtn.hidden = exitBtn.hidden = !(playing && id === null);
  document.body.classList.toggle('editing', editing && id === null);
  if (id) setFocus(focused.get(id)?.isConnected && !focused.get(id).hidden ? focused.get(id) : defaultFocus(id));
  nav?.sync(input.pads());
  updateHints();
}
function defaultFocus(id) { const f = SCREENS[id]?.focus; return f ? $(typeof f === 'function' ? f() : f) : null; }
function setFocus(el) { if (!el) return; el.focus({ preventScroll: true }); focused.set(activeScreen, el); }
function focusables() {
  const root = activeScreen && $(`#${activeScreen}`);
  if (!root) return [];
  return $$(`#${activeScreen} button, #${activeScreen} .theme`).filter(b => !b.hidden && !b.disabled && b.offsetParent !== null);
}

// gamepad / keyboard navigation on the DOM screens
function onNav(action, src, repeat) {
  if (!activeScreen) {
    if ((action === 'start' || action === 'back') && !repeat && (playing || editing)) { setPaused(true); return true; }
    return false;
  }
  document.body.classList.add('nav');
  const items = focusables();
  if (!items.length) return false;
  let cur = items.indexOf(document.activeElement);
  if (cur < 0) { setFocus(items[0]); return true; }
  if (['up', 'down', 'left', 'right'].includes(action)) {
    const rects = items.map(b => { const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const next = pickNext(rects, cur, action);
    if (next !== cur) { setFocus(items[next]); stage.play('move', { volume: 0.25 }); }
    return true;
  }
  if (repeat) return false;
  if (action === 'ok' || action === 'start') { items[cur].click(); return true; }
  if (action === 'back') { SCREENS[activeScreen]?.back?.(); return true; }
  return false;
}

function updateHints() {
  const pads = input.pads().length;
  $('#padHint').textContent = pads ? `컨트롤러 ${pads}개 연결됨 · Ⓐ 선택` : (matchMedia('(pointer: coarse)').matches ? '컨트롤러를 연결하면 가상 패드가 사라집니다' : '키보드: WASD + F · 방향키 + K · Esc 일시정지');
}

/* ---------- title / setup ---------- */
function buildTitle() {
  for (const b of $$('#title [data-mode]')) b.onclick = () => {
    settings.mode = b.dataset.mode;
    stage.play('select', { volume: 0.4 });
    if (settings.mode === 'editor') { refreshMaps(); show('maps'); } else { refreshSetup(); show('setup'); }
  };
}

// one frame of a theme sheet as a DOM crop (PNG sheets are drawn at theme.scales[sheet] px per logical px)
function frameImg(t, sheetName, i, size = null) {
  const cell = t.cells?.[sheetName] ?? (sheetName === 'shot' ? t.shotCell : t.cell), k = t.scales?.[sheetName] || 1, z = size ? size / cell : 1;
  return `<span class="fr" style="width:${cell * z}px;height:${cell * z}px"><img src="themes/${t.id}/${t.sheets[sheetName]}" alt="" style="object-fit:none;object-position:-${i * cell * k}px 0;width:${cell * k}px;height:${cell * k}px;transform:scale(${z / k});transform-origin:0 0"></span>`;
}

// theme card: a mini diorama (bricks, steel, the base, P1) over the theme's colors, plus its rule badge
function themeCard(id) {
  const t = themes[id], fr = t.frames;
  return `<button class="theme" data-theme="${id}" style="--tbg:${t.palette.bg};--thud:${t.palette.hud};--tacc:${t.palette.accent}">
    <span class="dio">${frameImg(t, 'tiles', fr.tiles.brick)}${frameImg(t, 'tiles', fr.tiles.steel)}${frameImg(t, 'base', fr.base.alive, 36)}${frameImg(t, 'units', fr.units.p1[0], 36)}${frameImg(t, 'tiles', fr.tiles.bush)}</span>
    <b>${t.name}</b><small>${t.desc}</small><span class="badge">${t.labels.rule || t.rules.kind}</span></button>`;
}

// the selected theme's palette drives the whole UI (borders, focus rings, backgrounds)
function applyPalette(id) {
  const p = themes[id]?.palette;
  if (!p) return;
  const r = document.documentElement.style;
  r.setProperty('--bg', p.bg); r.setProperty('--hud', p.hud); r.setProperty('--accent', p.accent); r.setProperty('--p1', p.p1); r.setProperty('--p2', p.p2); r.setProperty('--text', p.text);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', p.bg);
}

function buildSetup() {
  $('.themes').innerHTML = THEME_IDS.map(themeCard).join('');
  for (const b of $$('.theme')) b.onclick = () => { settings.theme = b.dataset.theme; applyPalette(settings.theme); refreshSetup(); stage.play('select', { volume: 0.4 }); };
  $('#stagePrev').onclick = () => { settings.stage = (settings.stage + STAGES.length - 2) % STAGES.length + 1; settings.customMap = null; refreshSetup(); };
  $('#stageNext').onclick = () => { settings.stage = settings.stage % STAGES.length + 1; settings.customMap = null; refreshSetup(); };
  $('#customBtn').onclick = () => openPick('coop');
  $('#mapPrev').onclick = () => { settings.versusMap = (settings.versusMap + VERSUS_MAPS.length - 1) % VERSUS_MAPS.length; settings.customMap = null; refreshSetup(); };
  $('#mapNext').onclick = () => { settings.versusMap = (settings.versusMap + 1) % VERSUS_MAPS.length; settings.customMap = null; refreshSetup(); };
  $('#timeBtn').onclick = () => { settings.versusTime = VERSUS_TIMES[(VERSUS_TIMES.indexOf(settings.versusTime) + 1) % VERSUS_TIMES.length]; refreshSetup(); };
  $('#soundBtn').onclick = () => { settings.sound = !settings.sound; stage.setMuted(!settings.sound); refreshSetup(); };
  $('#livesBtn').onclick = () => { settings.lives = LIVES_STEPS[(LIVES_STEPS.indexOf(settings.lives) + 1) % LIVES_STEPS.length]; refreshSetup(); };
  $('#hitBtn').onclick = () => { settings.hitMode = settings.hitMode === 'damage' ? 'destroy' : 'damage'; refreshSetup(); };
  $('#startBtn').onclick = () => startGame();
  for (const b of $$('.back')) b.onclick = () => show('title');
}

function refreshSetup() {
  $('#setup .mode-label').textContent = MODE_LABEL[settings.mode];
  for (const b of $$('.theme')) b.classList.toggle('on', b.dataset.theme === settings.theme);
  const versus = settings.mode === 'versus';
  $('#stageRow').hidden = versus; $('#versusRow').hidden = !versus;
  const custom = settings.customMap && mapStore.get(settings.customMap);
  if (custom && custom.mode !== (versus ? 'versus' : 'coop')) settings.customMap = null;
  $('#stageNum').textContent = settings.customMap ? '—' : settings.stage;
  $('#customBtn').textContent = custom && !versus ? `내 맵: ${custom.name}` : '내 맵: 없음';
  $('#mapName').textContent = custom && versus ? custom.name : VERSUS_MAPS[settings.versusMap].name;
  $('#timeBtn').textContent = `제한 시간: ${settings.versusTime ? settings.versusTime / 60 + '분' : '없음'}`;
  $('#soundBtn').textContent = settings.sound ? '소리 켜짐' : '소리 꺼짐';
  $('#livesBtn').textContent = `목숨: ${settings.lives === 0 ? '∞' : settings.lives}`;
  $('#hitBtn').textContent = settings.hitMode === 'damage' ? '피격: 데미지' : '피격: 파괴';
  store.save(settings);
}

/* ---------- my maps ---------- */
function mapItem(m, actions) {
  return `<div class="item" data-id="${m.id}"><b>${escapeHtml(m.name || '(이름 없음)')}</b><small>${m.mode === 'versus' ? '대전' : '협동'}</small>${actions}</div>`;
}
const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function refreshMaps() {
  const list = mapStore.list();
  const el = $('#maps .maplist');
  el.innerHTML = list.length ? list.map(m => mapItem(m, '<button data-act="open">열기</button><button data-act="play">플레이</button><button data-act="rename">이름</button><button data-act="dup">복제</button><button data-act="export">내보내기</button><button data-act="del">삭제</button>')).join('') : '<div class="empty">저장된 맵이 없습니다. 새 맵을 만들어 보세요.</div>';
  for (const b of el.querySelectorAll('button')) b.onclick = () => mapAction(b.dataset.act, b.closest('.item').dataset.id);
  $('#maps .mode-label').textContent = `${list.length} / 50`;
}

function mapAction(act, id) {
  const m = mapStore.get(id);
  if (!m) return;
  stage.play('select', { volume: 0.4 });
  if (act === 'open') openEditor(EditorModel.fromDef(m), id, m.name);
  else if (act === 'play') { settings.mode = m.mode === 'versus' ? 'versus' : '1p'; settings.customMap = id; refreshSetup(); show('setup'); }
  else if (act === 'rename') textbox('맵 이름', m.name, v => { if (v.trim()) { mapStore.rename(id, v.trim().slice(0, 20)); refreshMaps(); } });
  else if (act === 'dup') { try { mapStore.duplicate(id); } catch (e) { report('duplicate', e); } refreshMaps(); }
  else if (act === 'export') textbox('맵 데이터 (복사해서 공유)', JSON.stringify({ name: m.name, mode: m.mode, tiles: m.tiles }), null);
  else if (act === 'del') { if (confirmDelete(m)) { mapStore.remove(id); refreshMaps(); } }
}
// a soft confirm: the second tap within 3 s deletes
let delArm = null;
function confirmDelete(m) {
  if (delArm === m.id) { delArm = null; return true; }
  delArm = m.id; setTimeout(() => { delArm = null; }, 3000);
  const item = $(`#maps .item[data-id="${m.id}"] [data-act="del"]`);
  if (item) item.textContent = '정말 삭제?';
  return false;
}

function buildMaps() {
  $('#newCoopBtn').onclick = () => openEditor(new EditorModel('coop'), null, '');
  $('#newVersusBtn').onclick = () => openEditor(new EditorModel('versus'), null, '');
  $('#importBtn').onclick = () => textbox('맵 데이터 붙여넣기', '', v => {
    try {
      const d = JSON.parse(v);
      if (!d.tiles || !['coop', 'versus'].includes(d.mode)) throw new Error('형식이 맞지 않습니다');
      EditorModel.fromDef(d); // validates the tile text
      mapStore.save({ name: String(d.name || '가져온 맵').slice(0, 20), mode: d.mode, tiles: d.tiles });
      refreshMaps();
    } catch (e) { report('import', e); }
  });
  $('#pickNoneBtn').onclick = () => { settings.customMap = null; closePick(); };
  $('#pickCancelBtn').onclick = closePick;
}

function openPick(mode) {
  const list = mapStore.list().filter(m => m.mode === mode);
  const el = $('#pickMap .maplist');
  el.innerHTML = list.length ? list.map(m => mapItem(m, '<button data-act="pick">선택</button>')).join('') : '<div class="empty">저장된 맵이 없습니다.</div>';
  for (const b of el.querySelectorAll('button')) b.onclick = () => { settings.customMap = b.closest('.item').dataset.id; closePick(); };
  show('pickMap');
}
function closePick() { refreshSetup(); show('setup'); }

let textboxCb = null;
function textbox(title, value, cb) {
  $('#textboxTitle').textContent = title;
  $('#textboxArea').value = value;
  $('#textboxArea').readOnly = !cb;
  textboxCb = cb;
  const prev = activeScreen;
  show('textbox');
  $('#textboxOk').onclick = () => { $('#textbox').hidden = true; show(prev); cb?.($('#textboxArea').value); };
  $('#textboxCancel').onclick = () => { $('#textbox').hidden = true; show(prev); };
}

/* ---------- game ---------- */
function orientation() { return innerWidth >= innerHeight ? 'landscape' : 'portrait'; }
function currentView() { const mode = settings.mode === 'versus' || (editing && editor?.mode === 'versus') ? 'versus' : 'coop'; return { ...viewSize(mode, orientation()), orientation: orientation() }; }
function readInputs() { return Array.from({ length: input.players }, (_, i) => input.read(i)); }

let stageIndex = 0, customDef = null, carry = null;
function startGame() {
  playing = true; editing = false;
  input.players = settings.mode === '1p' ? 1 : 2;
  customDef = settings.customMap ? mapStore.get(settings.customMap) : null;
  stageIndex = customDef ? 0 : settings.stage - 1;
  carry = null;
  store.save(settings);
  enterFullscreen();
  show(null);
  onResize();
  startStage();
}

function buildWorld() {
  const theme = themes[settings.theme];
  const versus = settings.mode === 'versus';
  let grid, wave = '', name = '';
  if (customDef) { grid = Grid.parseHalf(customDef.tiles, Grid.parse(STAGES[0].map, 'coop').bases); if (customDef.mode === 'versus') grid = Grid.parseHalf(customDef.tiles, Grid.parse(VERSUS_MAPS[0].map, 'versus').bases); wave = versus ? '' : STAGES[Math.min(stageIndex, STAGES.length - 1)].wave; name = customDef.name; }
  else if (versus) { const m = VERSUS_MAPS[settings.versusMap]; grid = parseStage(m, 'versus').grid; name = m.name; }
  else { const s = STAGES[stageIndex % STAGES.length]; ({ grid, wave } = parseStage(s, 'coop')); name = ''; }
  world = new World({ mode: versus ? 'versus' : 'coop', grid, players: input.players, wave, rules: makeRules(theme.rules), traits: theme.traits || {}, timeLimit: versus ? settings.versusTime : 0, carry, lives: settings.lives === 0 ? Infinity : settings.lives, hitMode: settings.hitMode });
  return { world, theme, name };
}

function startStage() {
  const { theme, name } = buildWorld();
  stage.startPlay({ world, theme, view: currentView(), readInputs, stageName: name, stageIndex: customDef ? stageIndex : stageIndex % STAGES.length, onPhase });
}

// a finished stage: fire/A continues (next stage, or back to the menu after a game over)
let phaseFireArmed = false;
function onPhase(phase) { phaseFireArmed = false; }
function pollPhase() {
  if (!world || !playing || paused || world.phase === 'play') return;
  const fire = readInputs().some(i => i.fire || i.a || i.start);
  if (world.phaseT < 1.5) { phaseFireArmed = !fire; return; }
  if (!fire) { phaseFireArmed = true; return; }
  if (!phaseFireArmed) return;
  phaseFireArmed = false;
  if (world.phase === 'clear') {
    if (customDef && !editorId) { quitToMenu(); return; }
    if (customDef) { quitToEditor(); return; }
    carry = World.carryFrom(world);
    stageIndex++;
    settings.stage = stageIndex % STAGES.length + 1; store.save(settings);
    startStage();
  } else if (editorId) quitToEditor();
  else quitToMenu();
}

function setPaused(v, screen = 'pause') {
  if (!(playing || editing)) return;
  paused = v;
  if (v) { stage.pause(); stage.play('pause', { volume: 0.4 }); show(screen); }
  else { show(null); stage.resume(); input.pointers.clear(); input.dpads.clear(); }
}

function quitToMenu() {
  stage.stopAll();
  playing = false; editing = false; paused = false; world = null; editorId = null;
  input.players = 1;
  show('title');
}

/* ---------- editor ---------- */
function openEditor(model, id, name) {
  editor = model; editorId = id || 'new'; editing = true; playing = false; paused = false;
  input.players = 1;
  $('#mapNameInput').value = name || '';
  buildEditorBar();
  show(null);
  onResize();
  stage.startEditor({ model: editor, theme: themes[settings.theme], view: currentView(), readInputs, onAction: a => { if (a === 'menu') setPaused(true); else refreshEditorBar(); } });
}

function buildEditorBar() {
  const theme = themes[settings.theme];
  $('#editorBar .tools').innerHTML = TOOLS.map(t => `<button data-tool="${t}" title="${TOOL_NAMES[t]}">${t === 'erase' ? '✕' : frameImg(theme, 'tiles', theme.frames.tiles[t === 'water' ? 'water0' : t])}</button>`).join('');
  for (const b of $$('#editorBar .tools button')) b.onclick = () => { editor.tool = b.dataset.tool; refreshEditorBar(); };
  $('#brushBtn').onclick = () => { editor.toggleBrush(); refreshEditorBar(); };
  $('#saveMapBtn').onclick = saveMap;
  $('#testMapBtn').onclick = () => { saveMap(); if (!editorId || editorId === 'new') return; settings.mode = editor.mode === 'versus' ? 'versus' : '1p'; settings.customMap = editorId; startGame(); };
  $('#clearMapBtn').onclick = () => { const fresh = new EditorModel(editor.mode); editor.grid.cells.set(fresh.grid.cells); editor.version = (editor.version || 0) + 1; };
  $('#exitEditorBtn').onclick = () => setPaused(true, 'confirm');
  refreshEditorBar();
}
function refreshEditorBar() {
  for (const b of $$('#editorBar .tools button')) b.classList.toggle('on', b.dataset.tool === editor.tool);
  $('#brushBtn').textContent = editor.brush === 'tile' ? '큰 붓' : '작은 붓';
}
function saveMap() {
  const name = $('#mapNameInput').value.trim().slice(0, 20) || `맵 ${new Date().toLocaleDateString('ko-KR')}`;
  $('#mapNameInput').value = name;
  try {
    const id = mapStore.save({ ...(editorId && editorId !== 'new' ? { id: editorId } : {}), ...editor.toDef(name) });
    editorId = id;
    stage.play('pickup', { volume: 0.4 });
    $('#saveMapBtn').textContent = '저장됨 ✓';
    setTimeout(() => { $('#saveMapBtn').textContent = '저장'; }, 1200);
  } catch (e) { report('save', e); }
}
function quitToEditor() {
  const m = mapStore.get(editorId);
  stage.stopAll(); playing = false; world = null; paused = false;
  if (m) openEditor(EditorModel.fromDef(m), editorId, m.name); else quitToMenu();
}

// painting with a pointer on the canvas: client → map half cells
function bindEditorPointer() {
  let down = false;
  const cellOf = e => {
    const r = stageEl.getBoundingClientRect(), v = currentView();
    const x = (e.clientX - r.left) / r.width * v.w, y = (e.clientY - r.top) / r.height * v.h;
    const mapY = v.orientation === 'landscape' ? 0 : 64;
    return [Math.floor(x / 16), Math.floor((y - mapY) / 16)];
  };
  const paint = e => {
    if (!editing || activeScreen) return;
    const [cx, cy] = cellOf(e);
    if (!editor.grid.inside(cx, cy)) return;
    editor.cursor = { cx, cy };
    editor.paint(cx, cy);
  };
  stageEl.addEventListener('pointerdown', e => { down = true; e.preventDefault(); paint(e); });
  stageEl.addEventListener('pointermove', e => { if (down) paint(e); });
  for (const ev of ['pointerup', 'pointercancel']) addEventListener(ev, () => { down = false; });
}

// the fire button projects the current theme's shot sprite over its label
function fireHtml(r) {
  const t = themes[settings.theme], size = Math.max(28, Math.round(r * 0.9));
  return `<span class="shot">${frameImg(t, 'shot', 0, size)}</span><span class="lbl">발사</span>`;
}

/* ---------- layout ---------- */
function safeInsets() {
  const cs = getComputedStyle($('#safe'));
  return ['Top', 'Right', 'Bottom', 'Left'].map(k => parseFloat(cs[`padding${k}`]) || 0);
}
function touchPlayers() {
  if (editing) return [];
  const pads = new Set(input.padPlayers());
  return Array.from({ length: input.players }, (_, i) => i).filter(i => !pads.has(i));
}

function onResize() {
  const [it, ir, ib, il] = safeInsets();
  const barH = editing && !editorBar.hidden ? editorBar.offsetHeight : 0;
  const W = innerWidth - il - ir, H = innerHeight - it - ib - barH;
  const touch = touchPlayers();
  const view = currentView();
  layoutKey = `${W}x${H}:${input.players}:${touch}:${view.orientation}`;
  const layout = computeLayout(W, H, { players: input.players, touch, view });
  const v = layout.view, dpr = Math.min(devicePixelRatio || 1, 3);
  Object.assign(stageEl.style, { left: `${il + v.x}px`, top: `${it + v.y}px`, width: `${v.w}px`, height: `${v.h}px` });
  try { stage.resize(Math.round(v.w * dpr), Math.round(v.h * dpr)); } catch (e) { report('resize', e); }
  controls.classList.toggle('overlay', layout.mode === 'side');   // side clusters may ride over the view's edge
  controls.innerHTML = layout.buttons.map(b =>
    `<div class="pad p${b.player} a-${b.action}" data-player="${b.player}" data-action="${b.action}" style="left:${il + b.x - b.r}px;top:${it + b.y - b.r}px;width:${b.r * 2}px;height:${b.r * 2}px;font-size:${Math.round(b.r * 0.5)}px">${b.action === 'dpad' ? DPAD_HTML : fireHtml(b.r)}</div>`).join('');
  // pause / exit buttons live in the HUD strip: stacked mid-right in landscape, side by side at the
  // right end of the top strip in portrait
  const hudRight = view.orientation === 'landscape', k = v.w / view.w;
  const ps = Math.round(hudRight ? Math.max(28, v.h * 0.07) : Math.min(Math.max(26, 64 * k * 0.6), 48)), gap = Math.round(ps * 0.25);
  if (hudRight) {
    const bx = il + v.x + v.w - (96 * k) / 2 - ps / 2, by = it + v.y + v.h / 2 - ps - gap / 2;
    Object.assign(pauseBtn.style, { left: `${bx}px`, top: `${by}px`, width: `${ps}px`, height: `${ps}px`, fontSize: `${ps * 0.42}px` });
    Object.assign(exitBtn.style, { left: `${bx}px`, top: `${by + ps + gap}px`, width: `${ps}px`, height: `${ps}px`, fontSize: `${ps * 0.42}px` });
  } else {
    const by = it + v.y + (64 * k - ps) / 2, bx = il + v.x + v.w - 2 * ps - 2 * gap;
    Object.assign(pauseBtn.style, { left: `${bx}px`, top: `${by}px`, width: `${ps}px`, height: `${ps}px`, fontSize: `${ps * 0.42}px` });
    Object.assign(exitBtn.style, { left: `${bx + ps + gap}px`, top: `${by}px`, width: `${ps}px`, height: `${ps}px`, fontSize: `${ps * 0.42}px` });
  }
  input.pointers.clear(); input.dpads.clear();
  // an orientation change while playing rebuilds the scene around the same world
  if (lastOrientation && lastOrientation !== view.orientation) {
    if (playing && world) stage.startPlay({ world, theme: themes[settings.theme], view, readInputs, stageName: '', stageIndex: stageIndex % STAGES.length, onPhase });
    if (editing && editor) stage.startEditor({ model: editor, theme: themes[settings.theme], view, readInputs, onAction: a => { if (a === 'menu') setPaused(true); else refreshEditorBar(); } });
    if (paused) stage.pause();   // a paused game stays paused through the rebuild
  }
  lastOrientation = view.orientation;
  updateHints();
}

let padKey = '';
function updatePadUI() {
  const [it, ir, ib, il] = safeInsets();
  if (layoutKey !== `${innerWidth - il - ir}x${innerHeight - it - ib}:${input.players}:${touchPlayers()}:${orientation()}`) onResize();
  else updateHints();
}

/* ---------- loop ---------- */
let last = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (ts - last) / 1000 || 0);
  last = ts;
  input.pollPads();
  nav.poll(dt, input.pads());
  pollPhase();
}

const report = (where, e) => { console.error(where, e); window.__fatal?.(`${where}: ${e?.stack || e?.message || e}`); };

/* ---------- platform ---------- */
function preventZoom() {
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick', 'contextmenu']) document.addEventListener(ev, e => { if (!e.target.closest?.('input, textarea')) e.preventDefault(); }, { passive: false });
  document.addEventListener('touchmove', e => { if (e.touches.length > 1 || (e.scale && e.scale !== 1)) e.preventDefault(); }, { passive: false });
  let lastEnd = 0;
  document.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastEnd < 350 && !e.target.closest('button, input, textarea')) e.preventDefault();
    lastEnd = now;
  }, { passive: false });
}

async function enterFullscreen() {
  if (!matchMedia('(pointer: coarse)').matches) return;
  try { await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }); } catch { /* not supported */ }
  if (settings.mode === 'versus') { try { await screen.orientation?.lock?.('landscape'); } catch { /* not supported */ } }
}

async function boot() {
  $('#version').textContent = `v${APP_VERSION}`;
  window.__fatal = msg => { const f = $('#fatal'); f.hidden = false; f.querySelector('pre').textContent = msg; };
  $('#reloadBtn').onclick = async () => {
    try { const regs = await navigator.serviceWorker?.getRegistrations?.() || []; await Promise.all(regs.map(r => r.unregister())); const keys = await caches?.keys?.() || []; await Promise.all(keys.map(k => caches.delete(k))); } catch { /* ignore */ }
    location.reload();
  };
  stage = new Stage(stageEl);
  const loaded = await Promise.all([...THEME_IDS.map(id => loadTheme(id)), stage.ready]);
  THEME_IDS.forEach((id, i) => { themes[id] = loaded[i]; });
  stage.setMuted(!settings.sound);
  input = new InputManager();
  input.onPadsChanged = updatePadUI;
  input.bindTouch(controls);
  nav = new MenuNav(onNav);
  requestAnimationFrame(frame);
  buildTitle(); buildSetup(); buildMaps(); bindEditorPointer();
  applyPalette(settings.theme);
  refreshSetup();
  preventZoom();
  pauseBtn.onclick = () => setPaused(true);
  exitBtn.onclick = () => setPaused(true, 'confirm');
  $('#resumeBtn').onclick = () => setPaused(false);
  $('#quitBtn').onclick = () => setPaused(true, 'confirm');
  $('#confirmQuitBtn').onclick = quitToMenu;
  $('#cancelQuitBtn').onclick = () => setPaused(false);
  addEventListener('pointerdown', () => document.body.classList.remove('nav'));
  addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', () => { if (document.hidden && playing && !paused) setPaused(true); });
  $('#loading').hidden = true;
  window.tank = { stage, input, mapStore, get world() { return world; }, settings };
  show('title');
  onResize();
  registerServiceWorker();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
  const sw = navigator.serviceWorker;
  let reloading = false;
  if (sw.controller) sw.addEventListener('controllerchange', () => { if (!reloading && !playing && !editing) { reloading = true; location.reload(); } });
  sw.register('sw.js').catch(e => console.warn('service worker', e));
}

boot().catch(e => { $('#loading').hidden = true; report('boot', e); });
