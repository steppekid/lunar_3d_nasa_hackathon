import * as THREE from '../vendor/three.module.js';
import { loadIndex, loadOverview, loadSite } from './data.js';
import {
  sample, nextSunChange, nextEarthChange, fmtDuration, fmtUTC, missionStats,
  bestLandingDates, slipTolerance, sunFraction, SUN_STATE_LABEL,
} from './science.js';
import { SurfaceView } from './surface.js';
import { Overview } from './overview.js';
import { Timeline } from './timeline.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;

// ------------------------------------------------------------------ state
const S = {
  index: null, mode: 'overview', siteId: null, variant: 'databook', site: null,
  t: 0, playing: false, speedH: 24, missionStart: 0, missionDays: 30,
  panel: null, lastHud: 0,
};

const renderer = new THREE.WebGLRenderer({ canvas: $('gl'), antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
const surface = new SurfaceView(renderer);
const overview = new Overview(renderer);
const timeline = new Timeline($('timeline'), (t) => setTime(t));
const overlay = $('overlay');
const og = overlay.getContext('2d');

function resize() {
  const w = window.innerWidth, h = window.innerHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setSize(w, h, false);
  surface.setSize(w, h); overview.setSize(w, h);
  overlay.width = Math.round(w * dpr); overlay.height = Math.round(h * dpr);
  og.setTransform(dpr, 0, 0, dpr, 0, 0);
  timeline.draw();
}
window.addEventListener('resize', resize);

// --------------------------------------------------------------- helpers
const siteEntry = (id) => S.index.sites.find((s) => s.id === id);
const fmtLat = (v) => `${Math.abs(v).toFixed(4)}°${v < 0 ? 'S' : 'N'}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(4)}°${v < 0 ? 'W' : 'E'}`;
const fmtDeg = (v, d = 2) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}°`;
const isoLocal = (t) => new Date(t * 1000).toISOString().slice(0, 16);
const periodStart = () => Date.parse(S.index.period.start) / 1000;
const periodEnd = () => Date.parse(S.index.period.end) / 1000;
const missionEnd = () => Math.min(S.missionStart + S.missionDays * 86400, periodEnd());

function setHash() {
  const p = new URLSearchParams();
  if (S.mode === 'surface') { p.set('site', S.siteId); p.set('v', S.variant); }
  p.set('land', isoLocal(S.missionStart)); p.set('days', S.missionDays); p.set('t', isoLocal(S.t));
  history.replaceState(null, '', '#' + p.toString());
}

// ------------------------------------------------------------- overview UI
function buildSiteList() {
  const ol = $('sites');
  ol.innerHTML = '';
  for (const s of S.index.sites) {
    const v = s.variants.databook, b = s.variants.best;
    const sm = v.summary_full_period;
    const li = document.createElement('li');
    const bs = b?.summary_full_period;
    li.innerHTML = `<button>
      <span class="nm">${s.name}</span><span class="rf">${s.ref}</span>
      <span class="st"><span class="s">Sun <b>${sm.pct_sunlit_any.toFixed(0)}%</b></span>
      <span class="e">Earth <b>${sm.pct_earth.toFixed(0)}%</b></span>
      <span>Longest night <b>${sm.longest_dark_h} h</b></span></span>
      <span class="alt">${bs ? `≤500 m away: sun <b>${bs.pct_sunlit_any.toFixed(0)}%</b>, night <b>${bs.longest_dark_h} h</b>` : 'No ≤10° slope within 500 m at 80 m res.'}</span>
    </button>`;
    li.querySelector('button').onclick = () => enterSite(s.id, 'databook');
    ol.appendChild(li);
  }
  const pins = $('pins');
  pins.innerHTML = '';
  for (const s of overview.sites) {
    const el = document.createElement('div');
    el.className = 'pin';
    el.textContent = s.name;
    el.onclick = () => enterSite(s.id, 'databook');
    pins.appendChild(el);
    s.el = el;
  }
}

function placePins() {
  const w = window.innerWidth, h = window.innerHeight;
  const show = S.mode === 'overview' && !overview.anim;
  const items = [];
  for (const s of overview.sites) {
    const p = show ? overview.project(s.pos, w, h) : null;
    const g = show ? overview.project(s.pos, w, h, 0) : null;
    s.el.style.display = p ? '' : 'none';
    if (p) items.push({ s, p, g, x: p.x, y: p.y, wd: s.el.offsetWidth || 120 });
  }
  // greedy vertical de-overlap, then leader lines from the ground point
  items.sort((a, b) => b.y - a.y);
  const placed = [];
  for (const it of items) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const q of placed) {
        if (Math.abs(q.x - it.x) < (q.wd + it.wd) / 2 + 4 && Math.abs(q.y - it.y) < 24) { it.y = q.y - 26; moved = true; }
      }
    }
    placed.push(it);
    it.s.el.style.left = `${it.x}px`; it.s.el.style.top = `${it.y}px`;
  }
  if (show) {
    og.strokeStyle = 'rgba(70,224,200,0.8)'; og.lineWidth = 1;
    for (const it of items) {
      og.beginPath(); og.moveTo(it.g.x, it.g.y); og.lineTo(it.x, it.y); og.stroke();
      og.fillStyle = '#46e0c8'; og.beginPath(); og.arc(it.g.x, it.g.y, 3, 0, Math.PI * 2); og.fill();
    }
  }
}

// --------------------------------------------------------------- surface
async function enterSite(id, variant, { fly = true, keepTime = false } = {}) {
  const entry = siteEntry(id);
  if (!entry.variants[variant]) variant = 'databook';
  const ovSite = overview.sites.find((s) => s.id === id);
  $('loading').classList.add('on');
  const load = loadSite(entry.variants[variant].dir);
  if (fly && S.mode === 'overview') await overview.flyTo(ovSite);
  $('fade').classList.add('on');
  const site = await load;
  $('loading').classList.remove('on');
  await new Promise((r) => setTimeout(r, 350));
  S.siteId = id; S.variant = variant; S.site = site;
  selfCheck(site);
  surface.setSite(site);
  S.mode = 'surface';
  document.body.className = 'mode-surface';
  if (!keepTime) {
    const s0 = sample(site, S.t);
    surface.yaw = s0.sunAz; surface.pitch = 1;
  }
  refreshMission();
  renderHudStatic();
  $('fade').classList.remove('on');
  if (S.panel) openPanel(S.panel);
  setHash();
}

async function switchVariant(v) {
  if (!S.site || v === S.variant) return;
  const yaw = surface.yaw, pitch = surface.pitch;
  await enterSite(S.siteId, v, { fly: false, keepTime: true });
  surface.yaw = yaw; surface.pitch = pitch;
}

function backToMap() {
  S.mode = 'overview';
  S.playing = false; $('play').textContent = '▶';
  document.body.className = 'mode-overview';
  overview.reset();
  setHash();
}

/** Browser-vs-pipeline consistency: recompute the disc fraction in JS at
 *  hourly samples and compare with the pipeline's series. */
function selfCheck(site) {
  if (site.selfcheck) return;
  const m = site.meta.mask.el_deg, st = site.meta.mask.az_step_deg, c = site.ch;
  let maxd = 0;
  for (let i = 0; i < site.n; i += 7) {
    const f = sunFraction(c.sunAz[i], c.sunEl[i], c.sunR[i], m, st);
    maxd = Math.max(maxd, Math.abs(f - c.sunFrac[i]));
  }
  site.selfcheck = { maxAbsFracDiff: maxd, n: Math.ceil(site.n / 7) };
}

function renderHudStatic() {
  const e = siteEntry(S.siteId), m = S.site.meta;
  $('h-name').innerHTML = `${e.name}<span class="ref">${e.ref}</span>`;
  $('h-coords').textContent = `${fmtLat(m.lat)} ${fmtLon(m.lon)} · ground ${m.ground_height_m.toFixed(0)} m · slope ${m.slope_deg}° @80 m`;
  for (const b of $('h-variant').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.v === S.variant);
    b.disabled = !e.variants[b.dataset.v];
    if (b.dataset.v === 'best' && !e.variants.best) b.title = 'No DEM pixel with slope ≤ 10° within 500 m';
  }
  $('h-variant-note').textContent = S.variant === 'best'
    ? `Best-lit DEM pixel ${m.offset_m.toFixed(0)} m from the Data Book centre with slope ≤ ${m.search.slope_limit_deg}° (our illustrative limit).`
    : e.variants.best ? 'Region centre from the Data Book (not a landing point).'
      : 'Region centre from the Data Book. No pixel ≤ 10° slope within 500 m at 80 m resolution.';
}

function renderHud(s) {
  $('h-time').textContent = fmtUTC(s.t);
  $('d-time').textContent = fmtUTC(s.t);
  $('h-sun-el').textContent = fmtDeg(s.sunEl);
  $('h-sun-az').textContent = `${s.sunAz.toFixed(1)}°`;
  $('h-sun-mask').textContent = fmtDeg(s.sunMask);
  $('h-sun-frac').textContent = `${(s.sunFrac * 100).toFixed(s.sunFrac > 0 && s.sunFrac < 0.995 ? 1 : 0)}%`;
  const pw = $('h-power');
  pw.textContent = SUN_STATE_LABEL[s.sunState];
  pw.className = 'chip ' + ['dark', 'part', 'gen'][s.sunState];
  $('h-earth-el').textContent = fmtDeg(s.earthEl);
  $('h-earth-az').textContent = `${s.earthAz.toFixed(1)}°`;
  $('h-earth-margin').textContent = fmtDeg(s.earthEl - s.earthMask);
  const lk = $('h-link');
  lk.textContent = s.earthVis ? 'DTE link: in view' : 'DTE link: blocked';
  lk.className = 'chip ' + (s.earthVis ? 'link' : 'nolink');
  // Earth phase: illuminated fraction k = (1 + cos(phase angle)) / 2,
  // phase angle = angle Sun-Earth-observer.
  const sv = [Math.cos(s.sunEl * DEG) * Math.sin(s.sunAz * DEG), Math.sin(s.sunEl * DEG), -Math.cos(s.sunEl * DEG) * Math.cos(s.sunAz * DEG)];
  const ev = [Math.cos(s.earthEl * DEG) * Math.sin(s.earthAz * DEG), Math.sin(s.earthEl * DEG), -Math.cos(s.earthEl * DEG) * Math.cos(s.earthAz * DEG)];
  const dS = 695700 / Math.sin(s.sunR * DEG), dE = 6371 / Math.sin(s.earthR * DEG);
  const es = sv.map((v, i) => v * dS - ev[i] * dE), eo = ev.map((v) => -v);
  const nes = Math.hypot(...es);
  const cosPa = (es[0] * eo[0] + es[1] * eo[1] + es[2] * eo[2]) / nes;
  $('h-earth-phase').textContent = `${(((1 + cosPa) / 2) * 100).toFixed(0)}%`;

  const ns = nextSunChange(S.site, s.t), ne = nextEarthChange(S.site, s.t);
  const lit = s.sunFrac > 0;
  $('h-sun-next').innerHTML = ns == null ? `<span class="muted">No change before end of data (${S.index.period.end.slice(0, 10)})</span>`
    : `${lit ? 'Sunlight lost in' : 'Sunlight returns in'} <b>${fmtDuration(ns - s.t)}</b>`;
  $('h-earth-next').innerHTML = ne == null ? `<span class="muted">No change before end of data</span>`
    : `${s.earthVis ? 'Earth link lost in' : 'Earth link returns in'} <b>${fmtDuration(ne - s.t)}</b>`;
}

// ------------------------------------------------------------- time/mission
function setTime(t) {
  S.t = Math.min(Math.max(t, periodStart()), periodEnd());
  const u = (S.t - S.missionStart) / (missionEnd() - S.missionStart);
  $('scrub').value = Math.round(Math.min(Math.max(u, 0), 1) * 1000);
  timeline.setTime(S.t);
  S.dirty = true;
}

function refreshMission() {
  $('m-start').value = isoLocal(S.missionStart);
  $('m-days').value = String(S.missionDays);
  if (S.t < S.missionStart || S.t > missionEnd()) S.t = S.missionStart;
  if (S.site) {
    timeline.set(S.site, S.missionStart, missionEnd());
    surface.setPaths(S.site, (t) => sample(S.site, t), S.missionStart, missionEnd());
  }
  setTime(S.t);
  if (S.panel === 'compare') renderCompare();
}

$('scrub').addEventListener('input', (e) => setTime(S.missionStart + (e.target.value / 1000) * (missionEnd() - S.missionStart)));
$('play').addEventListener('click', () => {
  S.playing = !S.playing;
  $('play').textContent = S.playing ? '❚❚' : '▶';
  if (S.playing && S.t >= missionEnd() - 1) setTime(S.missionStart);
});
$('speed').addEventListener('change', (e) => { S.speedH = +e.target.value; });
$('m-start').addEventListener('change', (e) => {
  const t = Date.parse(e.target.value + ':00Z') / 1000;
  if (!Number.isFinite(t)) return;
  S.missionStart = Math.min(Math.max(t, periodStart()), periodEnd() - 86400);
  S.t = S.missionStart;
  refreshMission(); setHash();
});
$('m-days').addEventListener('change', (e) => { S.missionDays = +e.target.value; refreshMission(); setHash(); });
$('back').addEventListener('click', backToMap);
for (const b of $('h-variant').querySelectorAll('button')) b.addEventListener('click', () => switchVariant(b.dataset.v));

// view options
const bindOpt = (id, fn) => $(id).addEventListener('change', (e) => { fn(e.target.checked); surface.applyOptions(); S.dirty = true; });
bindOpt('opt-horizon', (v) => { surface.opts.horizon = v; });
bindOpt('opt-paths', (v) => { surface.opts.paths = v; });
bindOpt('opt-fill', (v) => { surface.opts.fill = v; });
bindOpt('opt-mag', (v) => { surface.opts.earthMag = v ? 4 : 1; });
bindOpt('opt-detail', (v) => { surface.opts.detail = v; });
bindOpt('opt-lowq', (v) => { surface.opts.quality = v ? 'low' : 'high'; });

function lookAt(az, el) {
  const y0 = surface.yaw, p0 = surface.pitch, t0 = performance.now();
  const dy = ((az - y0 + 540) % 360) - 180;
  S.lookAnim = (now) => {
    const u = Math.min((now - t0) / 700, 1), e = 1 - Math.pow(1 - u, 3);
    surface.yaw = y0 + dy * e; surface.pitch = p0 + (el - p0) * e;
    if (u >= 1) S.lookAnim = null;
  };
}
$('look-sun').addEventListener('click', () => { const s = sample(S.site, S.t); lookAt(s.sunAz, s.sunEl); });
$('look-earth').addEventListener('click', () => { const s = sample(S.site, S.t); lookAt(s.earthAz, s.earthEl); });

// first-person look controls
{
  const cv = $('gl');
  let drag = null;
  cv.addEventListener('pointerdown', (e) => { if (S.mode !== 'surface') return; drag = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const k = surface.fov / window.innerHeight;
    surface.yaw = (surface.yaw - (e.clientX - drag.x) * k + 360) % 360;
    surface.pitch = Math.min(Math.max(surface.pitch + (e.clientY - drag.y) * k, -85), 85);
    drag = { x: e.clientX, y: e.clientY };
  });
  cv.addEventListener('pointerup', () => { drag = null; });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (S.mode === 'surface') {
      surface.fov = Math.min(Math.max(surface.fov * Math.exp(e.deltaY * 0.001), 2), 100);
      $('fovlabel').textContent = `${surface.fov.toFixed(surface.fov < 10 ? 1 : 0)}°`;
    } else if (!overview.anim) {
      overview.dist = Math.min(Math.max(overview.dist * Math.exp(e.deltaY * 0.001), 60000), 1.2e6);
    }
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === ' ') { e.preventDefault(); $('play').click(); }
    if (S.mode !== 'surface') return;
    if (e.key === 'ArrowLeft') surface.yaw = (surface.yaw - 5 + 360) % 360;
    if (e.key === 'ArrowRight') surface.yaw = (surface.yaw + 5) % 360;
    if (e.key === 'ArrowUp') surface.pitch = Math.min(surface.pitch + 2, 85);
    if (e.key === 'ArrowDown') surface.pitch = Math.max(surface.pitch - 2, -85);
  });
}

// ---------------------------------------------------------- overlay drawing
function drawOverlay(s) {
  const w = window.innerWidth, h = window.innerHeight;
  og.clearRect(0, 0, w, h);
  if (S.mode !== 'surface') return;
  // compass tape
  const tapeW = Math.min(560, w - 80), x0 = (w - tapeW) / 2, y0 = 60, span = 90;
  og.fillStyle = 'rgba(8,11,16,0.72)'; og.fillRect(x0, y0, tapeW, 30);
  og.strokeStyle = 'rgba(150,170,200,0.25)'; og.strokeRect(x0 + 0.5, y0 + 0.5, tapeW - 1, 29);
  og.font = '600 11px "IBM Plex Mono", monospace'; og.textAlign = 'center';
  const card = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
  for (let a = Math.ceil((surface.yaw - span / 2) / 5) * 5; a <= surface.yaw + span / 2; a += 5) {
    const x = x0 + ((a - surface.yaw) / span + 0.5) * tapeW;
    const aa = ((a % 360) + 360) % 360;
    og.fillStyle = 'rgba(200,210,230,0.5)';
    og.fillRect(x, y0 + 22, 1, aa % 15 === 0 ? 8 : 4);
    if (aa % 45 === 0) { og.fillStyle = aa === 0 ? '#46e0c8' : '#dfe6f2'; og.fillText(card[aa], x, y0 + 13); }
    else if (aa % 15 === 0) { og.fillStyle = 'rgba(200,210,230,0.6)'; og.fillText(String(aa), x, y0 + 13); }
  }
  const mark = (az, col, label) => {
    let d = ((az - surface.yaw + 540) % 360) - 180;
    const clamped = Math.max(Math.min(d, span / 2), -span / 2);
    const x = x0 + (clamped / span + 0.5) * tapeW;
    og.fillStyle = col;
    og.beginPath(); og.moveTo(x, y0 + 30); og.lineTo(x - 5, y0 + 38); og.lineTo(x + 5, y0 + 38); og.fill();
    og.fillText(Math.abs(d) > span / 2 ? (d < 0 ? `◂ ${label}` : `${label} ▸`) : label, x, y0 + 50);
  };
  mark(s.sunAz, '#ffb547', 'SUN'); mark(s.earthAz, '#5fb4ff', 'EARTH');
  og.fillStyle = '#46e0c8'; og.fillRect(w / 2 - 1, y0 - 4, 2, 6);
  og.fillText(`${surface.yaw.toFixed(0).padStart(3, '0')}°`, w / 2, y0 - 7);

  // in-scene labels
  const lab = (az, el, r, col, text) => {
    const p = surface.project(az, el, w, h);
    if (!p || p.x < -50 || p.x > w + 50 || p.y < -50 || p.y > h + 50) return;
    const px = (r * DEG) / (surface.fov * DEG) * h; // approx. disc radius in px
    const rr = Math.max(px + 6, 12);
    og.strokeStyle = col; og.lineWidth = 1;
    og.beginPath(); og.arc(p.x, p.y, rr, 0, Math.PI * 2); og.stroke();
    og.fillStyle = col; og.textAlign = 'left'; og.font = '600 11px "IBM Plex Mono", monospace';
    og.fillText(text, p.x + rr + 6, p.y - 4);
  };
  lab(s.sunAz, s.sunEl, s.sunR, 'rgba(255,181,71,0.9)', `SUN ${fmtDeg(s.sunEl)} · ${(s.sunFrac * 100).toFixed(0)}% disc`);
  lab(s.earthAz, s.earthEl, s.earthR * surface.opts.earthMag, 'rgba(95,180,255,0.9)', `EARTH ${fmtDeg(s.earthEl)}${surface.opts.earthMag > 1 ? ' (×4)' : ''}`);
  og.textAlign = 'center';
}

// ------------------------------------------------------------------ panels
function openPanel(name) {
  S.panel = name;
  for (const b of document.querySelectorAll('#topbar nav button')) b.classList.toggle('active', b.dataset.panel === name);
  $('panel').classList.add('open'); $('panel').setAttribute('aria-hidden', 'false');
  ({ compare: renderCompare, validation: renderValidation, about: renderAbout })[name]();
}
function closePanel() {
  S.panel = null;
  for (const b of document.querySelectorAll('#topbar nav button')) b.classList.remove('active');
  $('panel').classList.remove('open'); $('panel').setAttribute('aria-hidden', 'true');
}
for (const b of document.querySelectorAll('#topbar nav button')) b.addEventListener('click', () => (S.panel === b.dataset.panel ? closePanel() : openPanel(b.dataset.panel)));
$('panel-close').addEventListener('click', closePanel);

const cmp = { ids: null, variant: 'databook', maxDark: 150, minBoth: 30 };

async function renderCompare() {
  const body = $('panel-body');
  if (!cmp.ids) cmp.ids = S.index.sites.slice(0, 4).map((s) => s.id);
  const ent = S.index.sites;
  body.innerHTML = `<h2>Compare sites</h2>
    <p class="muted small">Mission window: <b>${fmtUTC(S.missionStart)}</b> + <b>${S.missionDays} days</b> (change it in the bottom bar). Hourly samples; 2 to 4 sites.</p>
    <div class="pick" id="cmp-pick">${ent.map((s) => `<label><input type="checkbox" value="${s.id}" ${cmp.ids.includes(s.id) ? 'checked' : ''}>${s.name}</label>`).join('')}</div>
    <div class="row">Evaluate at
      <select id="cmp-var"><option value="databook">Data Book centre</option><option value="best">Best-lit point within 500 m (slope ≤ 10°)</option></select>
    </div>
    <div id="cmp-table"><p class="muted">Loading…</p></div>
    <h3>Best landing date</h3><div id="cmp-best"></div>
    <h3>Launch-slip tolerance</h3><div id="cmp-slip"></div>`;
  $('cmp-var').value = cmp.variant;
  $('cmp-var').onchange = (e) => { cmp.variant = e.target.value; renderCompare(); };
  for (const cb of body.querySelectorAll('#cmp-pick input')) cb.onchange = () => {
    const ids = [...body.querySelectorAll('#cmp-pick input:checked')].map((x) => x.value);
    if (ids.length < 2 || ids.length > 4) { cb.checked = !cb.checked; return; }
    cmp.ids = ids; renderCompare();
  };
  const rows = [
    ['% time sunlit (any disc)', 'pctSunlit', 1, (v) => `${v.toFixed(1)}%`],
    ['% time full sun', 'pctFull', 1, (v) => `${v.toFixed(1)}%`],
    ['% time Earth in view', 'pctEarth', 1, (v) => `${v.toFixed(1)}%`],
    ['% time sun + Earth', 'pctBoth', 1, (v) => `${v.toFixed(1)}%`],
    ['Longest darkness', 'longestDarkH', -1, (v) => `${v} h`],
    ['Longest comms gap', 'longestGapH', -1, (v) => `${v} h`],
  ];
  const cols = [];
  for (const id of cmp.ids) {
    const e = siteEntry(id);
    const v = e.variants[cmp.variant] ? cmp.variant : 'databook';
    const site = await loadSite(e.variants[v].dir);
    cols.push({ e, v, site, st: missionStats(site, S.missionStart, S.missionDays) });
  }
  const score = (c) => c.st.pctBoth - 0.05 * c.st.longestDarkH;
  const bestCol = cols.reduce((a, b) => (score(b) > score(a) ? b : a));
  let html = `<table class="t"><tr><th>Metric</th>${cols.map((c) => `<th>${c.e.name}${c.v !== cmp.variant ? ' *' : ''}</th>`).join('')}</tr>`;
  for (const [label, key, dir, fmt] of rows) {
    const vals = cols.map((c) => c.st[key]);
    const best = dir > 0 ? Math.max(...vals) : Math.min(...vals);
    html += `<tr><td>${label}</td>${vals.map((v) => `<td class="${v === best ? 'best' : ''}">${fmt(v)}</td>`).join('')}</tr>`;
  }
  html += `<tr class="sub"><td>Offset from Data Book centre</td>${cols.map((c) => `<td>${c.site.meta.offset_m.toFixed(0)} m</td>`).join('')}</tr>`;
  html += `<tr class="sub"><td>Local slope (80 m DEM)</td>${cols.map((c) => `<td>${c.site.meta.slope_deg}°</td>`).join('')}</tr>`;
  html += `</table>
    <div class="callout">Best overall for this window: <b>${bestCol.e.name}</b> <span class="muted">(highest % sun + Earth, penalised 0.05 pt per hour of the longest night)</span>.
    Highlighted cells are the best value per row.${cols.some((c) => c.v !== cmp.variant) ? ' * no qualifying nearby point; Data Book centre shown.' : ''}</div>`;
  $('cmp-table').innerHTML = html;

  // best landing dates for the current (or first) site
  const cur = S.site && cmp.ids.includes(S.siteId) ? cols.find((c) => c.e.id === S.siteId) : cols[0];
  const best = bestLandingDates(cur.site, S.missionDays);
  $('cmp-best').innerHTML = `<p class="small muted">For <b>${cur.e.name}</b>, ${S.missionDays}-day mission, any landing between ${S.index.period.start.slice(0, 10)} and ${S.index.period.end.slice(0, 10)}.
     Rule: touchdown sunlit with Earth in view → shortest longest-night → highest % sun + Earth (6-hour steps).</p>
    <table class="t"><tr><th>Landing (UTC)</th><th>Longest darkness</th><th>% sun + Earth</th><th></th></tr>
    ${best.map((b, i) => `<tr><td>${fmtUTC(b.t)}</td><td>${b.longestDarkH} h</td><td>${b.pctBoth.toFixed(1)}%</td><td><button class="btn" data-i="${i}">Use</button></td></tr>`).join('')}</table>`;
  for (const btn of $('cmp-best').querySelectorAll('button')) btn.onclick = () => {
    S.missionStart = best[+btn.dataset.i].t; S.t = S.missionStart;
    if (S.mode === 'surface' && S.siteId !== cur.e.id) enterSite(cur.e.id, cur.v, { fly: false });
    refreshMission(); setHash();
  };

  // slip tolerance for the current mission start
  const renderSlip = () => {
    const st = missionStats(cur.site, S.missionStart, S.missionDays);
    const h = slipTolerance(cur.site, S.missionStart, S.missionDays, cmp.maxDark, cmp.minBoth);
    const touchdownOk = cur.site.ch.sunFrac[Math.round((S.missionStart - cur.site.t0) / 3600)] > 0;
    $('cmp-slip-out').innerHTML = h > 0 || (st.longestDarkH <= cmp.maxDark && st.pctBoth >= cmp.minBoth && touchdownOk)
      ? `<span class="big">${fmtDuration(h * 3600)}</span><br><span class="muted small">Landing at ${fmtUTC(S.missionStart)} can slip up to this long and still meet the constraints (hourly check, later dates only).</span>`
      : `<span class="big" style="color:var(--bad)">not met</span><br><span class="muted small">The current landing time does not meet the constraints (it needs sunlight and Earth at touchdown). Try a date from the list above.</span>`;
  };
  $('cmp-slip').innerHTML = `<p class="small muted">${cur.e.name}: how long can the landing slip after the current landing time and still keep:</p>
    <div class="row">Longest darkness ≤ <input type="number" id="slip-dark" value="${cmp.maxDark}" min="0" step="12"> h
    and % sun + Earth ≥ <input type="number" id="slip-both" value="${cmp.minBoth}" min="0" max="100" step="5"> %</div>
    <p id="cmp-slip-out"></p>
    <p class="tiny muted">Thresholds are inputs for exploration, not mission requirements.</p>`;
  $('slip-dark').onchange = (e) => { cmp.maxDark = +e.target.value; renderSlip(); };
  $('slip-both').onchange = (e) => { cmp.minBoth = +e.target.value; renderSlip(); };
  renderSlip();
}

async function renderValidation() {
  const body = $('panel-body');
  const rows = [];
  for (const s of S.index.sites) for (const [k, v] of Object.entries(s.variants)) rows.push({ s, k, v });
  const allSun = Math.max(...rows.map((r) => r.v.validation_max_arcsec?.sun ?? NaN));
  const allEarth = Math.max(...rows.map((r) => r.v.validation_max_arcsec?.earth ?? NaN));
  let detail = '';
  if (S.site) {
    const val = S.site.meta.validation;
    const sc = S.site.selfcheck;
    const r = S.site.meta.mask.rendered_minus_mask_deg;
    if (val.status === 'ok') {
      const fmtRow = (b, i) => {
        const d = val[b];
        const daz = ((d.app_az[i] - d.horizons_az[i] + 540) % 360 - 180) * Math.cos(d.horizons_el[i] * DEG) * 3600;
        const del = (d.app_el[i] - d.horizons_el[i]) * 3600;
        return `<td>${d.horizons_az[i].toFixed(4)}</td><td>${d.horizons_el[i].toFixed(4)}</td><td>${daz.toFixed(2)}</td><td>${del.toFixed(2)}</td>`;
      };
      detail = `<h3>Sample check: ${siteEntry(S.siteId).name} (${S.variant === 'best' ? 'best nearby point' : 'Data Book centre'})</h3>
      <div class="tw"><table class="t"><tr><th>Time (UTC)</th><th>Sun az (Horizons)</th><th>Sun el</th><th>Δaz·cos el ″</th><th>Δel ″</th><th>Earth az</th><th>Earth el</th><th>Δaz·cos el ″</th><th>Δel ″</th></tr>
      ${val.times_utc.slice(0, 12).map((t, i) => `<tr><td>${t.slice(0, 16).replace('T', ' ')}</td>${fmtRow('sun', i)}${fmtRow('earth', i)}</tr>`).join('')}
      </table></div><p class="tiny muted">First 12 of ${val.n} times (minutes off the hourly grid, so the app's interpolation error is included). Horizons header: “${val.sun.horizons_header.frame_line.trim()}”, “${val.sun.horizons_header.ephem_line.trim()}”.</p>`;
    }
    detail += `<h3>Internal consistency at this point</h3><ul>
      <li>Rendered terrain skyline vs computed horizon mask: mean ${r.mean.toFixed(3)}°, range ${r.min.toFixed(3)}° to +${r.max.toFixed(3)}°. Where the decimated far mesh is lower, a skyline drawn from the mask fills the gap, so the visible horizon matches the mask.</li>
      <li>Browser vs pipeline solar-disc fraction (${sc.n} hourly samples): max |Δ| = ${sc.maxAbsFracDiff.toExponential(1)}.</li></ul>`;
  }
  body.innerHTML = `<h2>How do we know this is right?</h2>
  <p>Every Sun and Earth position in this app was computed offline with Skyfield and JPL's DE440 ephemeris, using DE440 lunar orientation in the Moon's Mean-Earth frame. That's the same frame the LOLA terrain uses. We then checked the positions against an independent source: the <a href="https://ssd.jpl.nasa.gov/horizons/" target="_blank" rel="noopener">JPL Horizons</a> API, with the observer placed on the lunar surface at each site.</p>
  <div class="callout">Largest disagreement with Horizons over ${rows.length} evaluated points × 36 times each in 2027–2028, <b>as displayed</b> (including hourly interpolation):
    Sun <b>${allSun.toFixed(2)}″</b>, Earth <b>${allEarth.toFixed(2)}″</b> (arcseconds). The Sun's disc is about 1900″ across.</div>
  <table class="t"><tr><th>Site · point</th><th>Sun max ″</th><th>Earth max ″</th><th>Slope</th><th>Offset</th></tr>
    ${rows.map((r) => `<tr><td>${r.s.name} · ${r.k === 'best' ? 'best ≤500 m' : 'Data Book'}</td><td>${r.v.validation_max_arcsec?.sun.toFixed(2) ?? '—'}</td><td>${r.v.validation_max_arcsec?.earth.toFixed(2) ?? '—'}</td><td>${r.v.slope_deg}°</td><td>${r.v.offset_m.toFixed(0)} m</td></tr>`).join('')}
  </table>
  ${detail}
  <h3>Horizon method</h3>
  <p>For every 0.25° of azimuth we trace the ground along the great circle from the observer, 2 m above the LOLA surface. We sample the 80 m DEM every 40 m out to 300 km, or to the map edge (at least 185 km at every site), and keep the highest elevation angle. Curvature is exact for a 1737.4 km sphere. The horizon tests check this against synthetic terrain with known answers: a bare sphere, a ring wall, and a lone peak 120 km away.</p>
  <p>The visible fraction of the solar disc integrates the true-size disc (radius from the Sun's distance, about 0.27°) against that horizon in 64 vertical strips. Earth counts as <em>in view</em> when its centre is above the horizon.</p>
  <h3>Known limitations</h3>
  <ul>
    <li><b>80 m terrain.</b> Boulders, small craters and slopes shorter than about 160 m are not modelled. At several sites the near horizon comes from the local slope a few hundred metres away, so results depend on the exact spot. That's why we show a second, nearby evaluated point.</li>
    <li><b>Data Book coordinates are region centres</b>, not landing points. Shackleton rim's centre sits on a 31° slope at this resolution.</li>
    <li><b>Earth "in view" uses the disc centre.</b> A half-hidden Earth may still support a link, and real links also need antenna pointing, ground stations, and a margin above terrain.</li>
    <li><b>Hourly time steps.</b> Statistics, the timeline and best-date search use hourly samples; countdowns are refined to the second. Events shorter than an hour can be missed.</li>
    <li><b>Lander height 2 m.</b> A mast or a solar array a few metres higher can see noticeably more Sun.</li>
    <li><b>Terrain rendering.</b> Distant terrain is drawn from a 600 m grid (320 m block-averaged DEM), with the computed skyline behind it. Shading is a Lommel–Seeliger/Lambert blend, and terrain shadows are traced per terrain grid node (60 m near, 600 m far). Both are for display; the HUD numbers come from the horizon mask.</li>
    <li><b>Terrain shadows beyond ~150 km</b> from the site are not cast onto the rendered terrain. The HUD and timeline do include them, out to the map edge.</li>
    <li><b>Ephemeris span.</b> Data covers ${S.index.period.start.slice(0, 10)} to ${S.index.period.end.slice(0, 10)} only.</li>
  </ul>`;
}

function renderAbout() {
  $('panel-body').innerHTML = `<h2>About</h2>
  <p>At the lunar south pole the Sun never climbs more than about two degrees above a flat horizon, and distant ridges decide whether a lander has power or a line of sight to Earth. This tool puts you <b>on the terrain</b> at a candidate site. For any date in 2027–2028 you see where the Sun and Earth really are against the real LOLA horizon, how much of the Sun is up, and how long until you lose power or the link home.</p>
  <h3>How to read it</h3>
  <ul>
    <li><b>Disc visible</b>: share of the solar disc above the terrain. <b>Generating</b> means the whole disc is up; <b>Partial</b>, part of it.</li>
    <li><b>DTE link</b>: Earth's centre is above the local terrain horizon (a geometric check, not a link budget).</li>
    <li><b>Timeline</b>: amber is sunlight, blue is Earth in view; gaps are night or a comms blackout.</li>
    <li><b>Teal line</b>: the computed horizon, which every number is checked against.</li>
  </ul>
  <h3>Data</h3>
  <ul>
    <li>Terrain: <a href="${S.index.dem.url}" target="_blank" rel="noopener">LRO LOLA LDEM_80S_80M</a>, NASA PDS Geosciences Node. 80 m/px polar stereographic, heights relative to a 1737.4 km sphere (scaling 0.5 m/DN, read from the PDS label).</li>
    <li>Ephemeris: JPL DE440 (de440s.bsp), lunar orientation moon_pa_de440_200625.bpc, frame kernel moon_de440_250416.tf, via NAIF generic kernels, computed with Skyfield.</li>
    <li>Validation: JPL Horizons API, observer at <code>coord@301</code>.</li>
    <li>Sites: NASA M2M-30044 <em>Lunar Surface Data Book</em> (Baseline, 18 Mar 2025), Table A2.1-1. Site numbering follows Mazarico et al. (2011).</li>
    <li>Software: three.js (MIT). Full list in docs/ATTRIBUTION.md.</li>
  </ul>
  <div class="callout warn">This is an independent student project for the NASA Space Apps Challenge 2026. It is not a NASA product and is not endorsed by NASA. Don't use it for actual mission decisions.</div>`;
}

// --------------------------------------------------------------------- loop
let lastNow = performance.now();
function frame(now) {
  const dt = Math.min((now - lastNow) / 1000, 0.5);  // real time, so slow machines keep pace
  lastNow = now;
  if (S.mode === 'surface' && S.site) {
    if (S.playing) {
      let t = S.t + dt * S.speedH * 3600;
      if (t >= missionEnd()) { t = missionEnd(); S.playing = false; $('play').textContent = '▶'; }
      setTime(t);
    }
    if (S.lookAnim) S.lookAnim(now);
    const s = sample(S.site, S.t);
    surface.update(s);
    surface.render();
    drawOverlay(s);
    if (S.dirty && now - S.lastHud > 60) { renderHud(s); S.lastHud = now; S.dirty = false; }
  } else {
    overview.render(now);
    drawOverlay(null);
  }
  placePins();
  requestAnimationFrame(frame);
}

// --------------------------------------------------------------------- boot
(async function boot() {
  try {
    S.index = await loadIndex();
    const ov = await loadOverview(S.index);
    overview.build(ov, S.index.sites);
    buildSiteList();
    const p = new URLSearchParams(location.hash.slice(1));
    const landing = p.get('land') ? Date.parse(p.get('land') + ':00Z') / 1000 : Date.parse('2027-01-01T00:00:00Z') / 1000;
    S.missionStart = Number.isFinite(landing) ? landing : periodStart();
    S.missionDays = +(p.get('days') || 30);
    const t = p.get('t') ? Date.parse(p.get('t') + ':00Z') / 1000 : S.missionStart;
    S.t = Number.isFinite(t) ? t : S.missionStart;
    $('speed').value = String(S.speedH);
    resize();
    requestAnimationFrame(frame);
    if (p.get('site') && siteEntry(p.get('site'))) {
      await enterSite(p.get('site'), p.get('v') || 'databook', { fly: false, keepTime: true });
      const s0 = sample(S.site, S.t); surface.yaw = s0.sunAz; surface.pitch = 1;
    }
    if (p.get('panel')) openPanel(p.get('panel'));
    window.__app = { S, surface, overview, ready: true };
  } catch (err) {
    console.error(err);
    $('loading').textContent = 'Failed to load data: ' + err.message;
    $('loading').classList.add('on');
  }
})();
