// Precache the whole app per version and serve only from that cache, so files of two versions
// never mix. A new version arrives by changing CACHE (kept equal to js/version.js APP_VERSION by a test).
const CACHE = 'tank-v1';
const THEMES = ['classic', 'ancient', 'space', 'halloween'];
const SHEETS = ['tiles', 'units', 'shot', 'items', 'base', 'fx'];
const SFX = ['fire_classic', 'fire_ancient', 'fire_space', 'fire_halloween', 'hit', 'brick', 'steel', 'ricochet', 'explode', 'explodeBig',
  'explode_ancient', 'explode_space', 'explode_halloween', 'spawn', 'item', 'pickup', 'life', 'pause', 'select', 'move', 'stageStart', 'gameOver',
  'win', 'tick', 'shield', 'shovel', 'freeze', 'stun', 'score', 'land', 'beam', 'phase'];
const JS = ['version', 'config', 'layout', 'input', 'menu', 'grid', 'units', 'projectile', 'world', 'enemy', 'stages', 'editor', 'assets', 'stage', 'editorscene', 'main'];
const PRECACHE = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png',
  ...JS.map(m => `js/${m}.js`),
  'vendor/phaser-4.2.1.esm.min.js',
  ...SFX.map(n => `sfx/${n}.wav`),
  ...THEMES.flatMap(t => [`themes/${t}/theme.json`, ...SHEETS.map(s => `themes/${t}/sheets/${s}.svg`)])
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    // only the app's own entry falls back to the cached shell; other paths go to the network
    const entry = req.mode === 'navigate' && /\/(index\.html)?$/.test(new URL(req.url).pathname);
    const hit = await cache.match(req, { ignoreSearch: true }) || (entry ? await cache.match('index.html') : null);
    return hit || fetch(req);
  }));
});
