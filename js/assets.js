// Theme loading. Sprite sheets (SVG or PNG) are rasterized once per scale
// into canvases so drawImage with source rects is fast and crisp.

export async function loadTheme(id = 'classic') {
  const base = `themes/${id}/`;
  const theme = await (await fetch(base + 'theme.json')).json();
  theme.base = base;
  return theme;
}

const images = new Map();
const LOAD_TIMEOUT = 8000;
function loadOnce(url, timeout = LOAD_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => { img.src = ''; reject(new Error(`image load timed out: ${url}`)); }, timeout);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error(`image load failed: ${url}`)); };
    img.src = url;
  });
}
// A load that hangs or fails is retried once past the caches; a failed promise is not kept, so the next
// scene start tries again instead of failing forever.
export function loadImage(url) {
  if (!images.has(url)) {
    const p = loadOnce(url).catch(() => loadOnce(`${url}${url.includes('?') ? '&' : '?'}retry=${Date.now()}`));
    p.catch(() => images.delete(url));
    images.set(url, p);
  }
  return images.get(url);
}

const rasters = new Map();
export function rasterize(url, scale) {
  const key = `${url}@${scale}`;
  if (!rasters.has(key)) {
    rasters.set(key, loadImage(url).then(img => {
      const c = document.createElement('canvas');
      c.width = Math.ceil(img.naturalWidth * scale);
      c.height = Math.ceil(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return { canvas: c, scale };
    }));
  }
  return rasters.get(key);
}
