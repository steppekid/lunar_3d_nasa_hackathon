// Loads the static files produced by pipeline/build.py.
const cache = new Map();

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
async function getBin(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.arrayBuffer();
}

export const loadIndex = () => getJSON('data/index.json');

export async function loadOverview(index) {
  const buf = await getBin(`data/${index.overview.file}`);
  return { ...index.overview, h: new Int16Array(buf) };
}

/** Load one evaluated point (variant directory) of a site. */
export function loadSite(dir) {
  if (!cache.has(dir)) cache.set(dir, _load(dir));
  return cache.get(dir);
}

async function _load(dir) {
  const base = `data/sites/${dir}/`;
  const meta = await getJSON(base + 'meta.json');
  const [eph, near, far] = await Promise.all([
    getBin(base + meta.ephem.file),
    getBin(base + meta.terrain.near.file),
    getBin(base + meta.terrain.far.file),
  ]);
  const n = meta.ephem.n;
  const all = new Float32Array(eph);
  const ch = {};
  meta.ephem.channels.forEach((name, k) => { ch[name] = all.subarray(k * n, (k + 1) * n); });
  return {
    dir, meta, ch, n, t0: meta.ephem.t0_unix,
    near: new Int16Array(near), far: new Int16Array(far),
  };
}
