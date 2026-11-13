// Browser-side science. Mirrors pipeline/lunar/visibility.py and
// pipeline/build.py:interp_like_app exactly, so live values at hourly
// sample times equal the pipeline's precomputed series.

export const FULL = 0.999;           // disc fraction for "generating"
export const N_STRIPS = 64;

export function maskLookup(mask, stepDeg, azDeg) {
  const n = mask.length;
  const x = (((azDeg % 360) + 360) % 360) / stepDeg;
  const xf = Math.floor(x);
  const i0 = ((xf % n) + n) % n;
  const i1 = (i0 + 1) % n;
  const f = x - xf;
  return mask[i0] * (1 - f) + mask[i1] * f;
}

/** Visible fraction of the solar disc above the horizon mask. */
export function sunFraction(az, el, r, mask, stepDeg, n = N_STRIPS) {
  const cosEl = Math.max(Math.cos(el * Math.PI / 180), 1e-6);
  let vis = 0, tot = 0;
  for (let k = 0; k < n; k++) {
    const xs = ((k + 0.5) / n) * 2 - 1;
    const x = xs * r;
    const half = Math.sqrt(Math.max(r * r - x * x, 0));
    const m = maskLookup(mask, stepDeg, az + x / cosEl);
    const lo = el - half, hi = el + half;
    vis += Math.min(Math.max(hi - Math.max(lo, m), 0), hi - lo);
    tot += hi - lo;
  }
  return tot > 1e-12 ? vis / tot : 0;
}

export const sunState = (f) => (f >= FULL ? 2 : f > 0 ? 1 : 0);
export const SUN_STATE_LABEL = ['Dark', 'Partial', 'Generating'];

/** Interpolated sky state at unix seconds `t` for a loaded site. */
export function sample(site, t) {
  const { ch, n, t0 } = site;
  const x = (t - t0) / 3600;
  const i0 = Math.min(Math.max(Math.floor(x), 0), n - 2);
  const f = x - i0;
  const lerp = (a) => a[i0] * (1 - f) + a[i0 + 1] * f;
  const lerpAz = (a) => {
    const a0 = a[i0], a1 = a[i0 + 1];
    const d = ((a1 - a0 + 540) % 360) - 180;
    return (((a0 + f * d) % 360) + 360) % 360;
  };
  const s = {
    t,
    sunAz: lerpAz(ch.sunAz), sunEl: lerp(ch.sunEl), sunR: lerp(ch.sunR),
    earthAz: lerpAz(ch.earthAz), earthEl: lerp(ch.earthEl), earthR: lerp(ch.earthR),
  };
  const mask = site.meta.mask.el_deg, step = site.meta.mask.az_step_deg;
  s.sunFrac = sunFraction(s.sunAz, s.sunEl, s.sunR, mask, step);
  s.sunMask = maskLookup(mask, step, s.sunAz);
  s.earthMask = maskLookup(mask, step, s.earthAz);
  s.earthVis = s.earthEl > s.earthMask;
  s.sunState = sunState(s.sunFrac);
  return s;
}

const litAt = (site, t) => sample(site, t).sunFrac > 0;
const earthAt = (site, t) => sample(site, t).earthVis;

/** Next time (unix s) at which predicate changes value, or null. Uses the
 *  hourly precomputed series to find the hour, then bisects on the live
 *  interpolated model (sub-second). Changes shorter than 1 h can be missed. */
function nextChange(site, t, hourly, live) {
  const now = live(site, t);
  const { n, t0 } = site;
  let k = Math.max(Math.ceil((t - t0) / 3600), 0);
  for (; k < n; k++) if (hourly(k) !== now) break;
  if (k >= n) return null;
  let a = Math.max(t, t0 + (k - 1) * 3600), b = t0 + k * 3600;
  if (live(site, a) !== now) return a;
  for (let i = 0; i < 24; i++) {
    const m = (a + b) / 2;
    if (live(site, m) === now) a = m; else b = m;
  }
  return b;
}

export function nextSunChange(site, t) {
  return nextChange(site, t, (k) => site.ch.sunFrac[k] > 0, litAt);
}
export function nextEarthChange(site, t) {
  return nextChange(site, t, (k) => site.ch.earthVis[k] > 0.5, earthAt);
}

export function fmtDuration(sec) {
  if (sec == null) return '—';
  const m = Math.round(sec / 60);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${mm} min`;
  return `${mm} min`;
}

/** Longest run of `true` in bool array over [i0, i1). */
function longestRun(arr, i0, i1) {
  let best = 0, cur = 0;
  for (let i = i0; i < i1; i++) {
    if (arr(i)) { cur++; if (cur > best) best = cur; } else cur = 0;
  }
  return best;
}

/** Mission statistics over the hourly samples in [tStart, tStart + days). */
export function missionStats(site, tStart, days) {
  const { ch, n, t0 } = site;
  const i0 = Math.max(0, Math.round((tStart - t0) / 3600));
  const i1 = Math.min(n, i0 + Math.round(days * 24));
  const N = Math.max(i1 - i0, 1);
  let lit = 0, full = 0, earth = 0, both = 0;
  for (let i = i0; i < i1; i++) {
    const L = ch.sunFrac[i] > 0, E = ch.earthVis[i] > 0.5;
    lit += L; full += ch.sunFrac[i] >= FULL; earth += E; both += L && E;
  }
  return {
    hours: i1 - i0,
    pctSunlit: (100 * lit) / N,
    pctFull: (100 * full) / N,
    pctEarth: (100 * earth) / N,
    pctBoth: (100 * both) / N,
    longestDarkH: longestRun((i) => !(ch.sunFrac[i] > 0), i0, i1),
    longestGapH: longestRun((i) => !(ch.earthVis[i] > 0.5), i0, i1),
  };
}

/** Rank landing times for a site over the whole data period.
 *  Rule (stated in the UI): touchdown must be sunlit with Earth in view; then
 *  shortest longest-darkness during the mission; then highest % sun+Earth. */
export function bestLandingDates(site, days, stepH = 6, top = 5) {
  const { ch, n, t0 } = site;
  const W = Math.round(days * 24);
  const lit = (i) => ch.sunFrac[i] > 0, ear = (i) => ch.earthVis[i] > 0.5;
  // prefix sums for both
  const pb = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) pb[i + 1] = pb[i] + (lit(i) && ear(i) ? 1 : 0);
  const cands = [];
  for (let i = 0; i + W <= n; i += stepH) {
    if (!(lit(i) && ear(i))) continue;
    cands.push({ i, dark: longestRun((k) => !lit(k), i, i + W), both: (100 * (pb[i + W] - pb[i])) / W });
  }
  cands.sort((a, b) => a.dark - b.dark || b.both - a.both);
  // keep distinct dates (at least 2 days apart)
  const out = [];
  for (const c of cands) {
    if (out.every((o) => Math.abs(o.i - c.i) >= 48)) out.push(c);
    if (out.length >= top) break;
  }
  return out.map((c) => ({ t: t0 + c.i * 3600, longestDarkH: c.dark, pctBoth: c.both }));
}

/** Launch-slip tolerance: from landing time t, how many hours can landing
 *  slip later while the mission still meets: lit + Earth at touchdown,
 *  longest darkness <= maxDarkH and % sun+Earth >= minBothPct. Returns the
 *  length (h) of the contiguous acceptable window starting at t (or 0). */
export function slipTolerance(site, t, days, maxDarkH, minBothPct) {
  const { ch, n, t0 } = site;
  const W = Math.round(days * 24);
  let i = Math.round((t - t0) / 3600);
  const ok = (j) => {
    if (j < 0 || j + W > n) return false;
    if (!(ch.sunFrac[j] > 0 && ch.earthVis[j] > 0.5)) return false;
    const s = missionStats(site, t0 + j * 3600, days);
    return s.longestDarkH <= maxDarkH && s.pctBoth >= minBothPct;
  };
  if (!ok(i)) return 0;
  let k = 0;
  while (ok(i + k + 1) && k < 24 * 120) k++;
  return k;
}

// ---- geometry helpers ---------------------------------------------------
const R_MOON = 1737400;

/** lat/lon (deg) -> polar stereographic map metres (X right/90E, Y up/0E). */
export function latlonToMap(latDeg, lonDeg) {
  const lat = (latDeg * Math.PI) / 180, lon = (lonDeg * Math.PI) / 180;
  const ux = Math.cos(lat) * Math.cos(lon), uy = Math.cos(lat) * Math.sin(lon), uz = Math.sin(lat);
  const k = (2 * R_MOON) / (1 - uz);
  return { X: k * uy, Y: k * ux };
}

/** az/el (deg) -> unit vector in scene coords (x = East, y = Up, z = South). */
export function azElToVec(azDeg, elDeg) {
  const a = (azDeg * Math.PI) / 180, e = (elDeg * Math.PI) / 180;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)];
}

export function fmtUTC(t) {
  return new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
