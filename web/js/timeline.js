// Two-lane timeline (Sun power state, Earth link) over the mission window.
import { FULL, fmtUTC } from './science.js';

const COL = {
  gen: '#ffb547', part: '#8a6a32', dark: '#1a1d24',
  earth: '#5fb4ff', noEarth: '#1a1d24', cursor: '#ffffff', grid: 'rgba(255,255,255,0.10)',
};

export class Timeline {
  constructor(canvas, onSeek) {
    this.cv = canvas;
    this.onSeek = onSeek;
    this.hover = null;
    let dragging = false;
    const seek = (e) => {
      const r = this.cv.getBoundingClientRect();
      const u = Math.min(Math.max((e.clientX - r.left - this.labelW) / (r.width - this.labelW), 0), 1);
      if (this.t0 != null) this.onSeek(this.t0 + u * (this.t1 - this.t0));
    };
    canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); seek(e); });
    canvas.addEventListener('pointermove', (e) => {
      if (dragging) seek(e);
      const r = this.cv.getBoundingClientRect();
      this.hover = e.clientX - r.left;
      this.draw();
    });
    canvas.addEventListener('pointerup', () => { dragging = false; });
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
    this.labelW = 64;
  }

  set(site, t0, t1) { this.site = site; this.t0 = t0; this.t1 = t1; this.draw(); }
  setTime(t) { this.t = t; this.draw(); }

  draw() {
    const cv = this.cv, dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!this.site) return;
    const { ch, t0: d0, n } = this.site;
    const L = this.labelW, w = W - L;
    const laneH = Math.floor((H - 22) / 2) - 3;
    const y1 = 4, y2 = y1 + laneH + 5;
    const span = this.t1 - this.t0;
    g.font = '600 10px "IBM Plex Mono", ui-monospace, monospace';
    g.fillStyle = '#ffb547'; g.fillText('SUNLIGHT', 4, y1 + laneH / 2 + 4);
    g.fillStyle = '#5fb4ff'; g.fillText('EARTH', 4, y2 + laneH / 2 + 4);
    // one rect per pixel column (max state in column for sun, any for earth)
    for (let x = 0; x < w; x++) {
      const ta = this.t0 + (x / w) * span, tb = this.t0 + ((x + 1) / w) * span;
      const ia = Math.max(0, Math.floor((ta - d0) / 3600)), ib = Math.min(n, Math.max(ia + 1, Math.ceil((tb - d0) / 3600)));
      let sMin = 3, sMax = -1, eAny = 0, eAll = 1;
      for (let i = ia; i < ib; i++) {
        const f = ch.sunFrac[i];
        const s = f >= FULL ? 2 : f > 0 ? 1 : 0;
        sMin = Math.min(sMin, s); sMax = Math.max(sMax, s);
        const e = ch.earthVis[i] > 0.5;
        eAny |= e; eAll &= e;
      }
      if (sMax < 0) continue;
      const s = sMin === 0 && sMax > 0 ? 1 : sMax;
      g.fillStyle = s === 2 ? COL.gen : s === 1 ? COL.part : COL.dark;
      g.fillRect(L + x, y1, 1.02, laneH);
      g.fillStyle = eAll ? COL.earth : eAny ? '#2f5f8a' : COL.noEarth;
      g.fillRect(L + x, y2, 1.02, laneH);
    }
    // day ticks
    g.fillStyle = 'rgba(200,210,230,0.55)';
    g.font = '10px "IBM Plex Mono", ui-monospace, monospace';
    const days = span / 86400;
    const every = days > 120 ? 30 : days > 40 ? 7 : days > 10 ? 2 : 1;
    let lastX = -1e9;
    for (let d = 0; d <= days; d += every) {
      const x = L + (d / days) * w;
      g.fillStyle = COL.grid; g.fillRect(x, y1, 1, y2 + laneH - y1);
      if (x - lastX > 64) {
        g.fillStyle = 'rgba(200,210,230,0.6)';
        g.fillText(new Date((this.t0 + d * 86400) * 1000).toISOString().slice(5, 10), x + 2, H - 5);
        lastX = x;
      }
    }
    // cursor
    if (this.t != null) {
      const x = L + ((this.t - this.t0) / span) * w;
      g.fillStyle = COL.cursor; g.fillRect(x - 1, 0, 2, y2 + laneH + 3);
    }
    if (this.hover != null && this.hover > L) {
      const tt = this.t0 + ((this.hover - L) / w) * span;
      const label = fmtUTC(tt);
      g.font = '10px "IBM Plex Mono", ui-monospace, monospace';
      const tw = g.measureText(label).width + 10;
      const x = Math.min(this.hover + 8, W - tw - 2);
      g.fillStyle = 'rgba(8,10,14,0.92)'; g.fillRect(x, y2 - 6, tw, 16);
      g.fillStyle = '#dfe6f2'; g.fillText(label, x + 5, y2 + 6);
      g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(this.hover, 0, 1, y2 + laneH + 3);
    }
  }
}
