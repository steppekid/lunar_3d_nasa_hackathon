// First-person surface view at a landing site.
// Scene coordinates: x = East, y = Up, z = South (so the camera's default
// -z view direction is North). Origin = observer eye, 2 m above the ground.
import * as THREE from '../vendor/three.module.js';
import { azElToVec, maskLookup } from './science.js';

const SKY_D = 4.0e6;        // where Sun/Earth billboards live (m)
const CURTAIN_D = 245000;   // skyline curtain radius (beyond rendered terrain)
const LINE_D = 240000;      // horizon line radius
const DEG = Math.PI / 180;

// Shadow bake: one texel per terrain grid node. March from the node toward
// the Sun's azimuth through both height grids and keep the highest terrain
// elevation angle; the visible share of the true-size solar disc above it is
// the node's sunlight factor. Re-run only when the Sun moves.
const bakeVert = /* glsl */`
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const bakeFrag = /* glsl */`
#include <common>
uniform sampler2D nearTex;
uniform sampler2D farTex;
uniform float nearHalf, farHalf, nearN, farN;
uniform float gridHalf, gridN;
uniform sampler2D gridTex;
uniform vec3 sunDir;
uniform float sunR;
uniform int steps;
uniform float growth;
uniform float d0;
float hAt(vec2 en) {
  if (abs(en.x) < nearHalf && abs(en.y) < nearHalf) {
    vec2 uv = ((en + nearHalf) / (2.0 * nearHalf) * (nearN - 1.0) + 0.5) / nearN;
    return texture2D(nearTex, uv).r;
  }
  vec2 uv = ((en + farHalf) / (2.0 * farHalf) * (farN - 1.0) + 0.5) / farN;
  return texture2D(farTex, uv).r;
}
float discVisible(float d) {
  if (d >= 1.0) return 1.0;
  if (d <= -1.0) return 0.0;
  return 1.0 - (acos(d) - d * sqrt(1.0 - d * d)) / PI;
}
void main() {
  vec2 node = floor(gl_FragCoord.xy);
  float sp = 2.0 * gridHalf / (gridN - 1.0);
  vec2 en = -gridHalf + node * sp;
  float py = texture2D(gridTex, (node + 0.5) / gridN).r;
  vec2 sh = vec2(sunDir.x, -sunDir.z);
  float hl = max(length(sh), 1e-6);
  vec2 hd = sh / hl;
  float sunEl = atan(sunDir.y, hl);
  float maxTan = -1e6;
  float d = d0;
  for (int k = 0; k < 128; k++) {
    if (k >= steps) break;
    vec2 q = en + hd * d;
    if (abs(q.x) > farHalf || abs(q.y) > farHalf) break;
    maxTan = max(maxTan, (hAt(q) - py) / d);
    d *= growth;
  }
  gl_FragColor = vec4(vec3(discVisible((sunEl - atan(maxTan)) / sunR)), 1.0);
}`;

const terrainVert = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform sampler2D shadowTex;
uniform float gridHalf, gridN;
varying vec3 vN;
varying vec3 vW;
varying float vShadow;
void main() {
  vec3 p = position;
  vec2 en = vec2(p.x, -p.z);
  vec2 uv = ((en + gridHalf) / (2.0 * gridHalf) * (gridN - 1.0) + 0.5) / gridN;
  vShadow = texture2D(shadowTex, uv).r;
  vN = normal;
  vW = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}`;

const terrainFrag = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 sunDir;
uniform float sunI;
uniform float fill;
uniform float detail;
varying vec3 vN;
varying vec3 vW;
varying float vShadow;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  float mu0 = dot(n, sunDir);
  float mu = max(dot(n, v), 0.0);
  // Display photometry: Lommel-Seeliger (regolith-like, flat-lit look) blended
  // with Lambert so sun-facing slopes read as relief. Not radiometric.
  float ls = mu0 > 0.0 ? mu0 / (mu0 + mu + 1e-3) : 0.0;
  float b = 0.22 * ls + 2.4 * max(mu0, 0.0);
  vec3 alb = vec3(0.60, 0.59, 0.57);
  // Illustrative albedo texture below the 80 m data resolution (toggle).
  float dist = length(vW - cameraPosition);
  float fade = detail * (1.0 - smoothstep(300.0, 6000.0, dist));
  float tx = vnoise(vW.xz / 6.0) * 0.45 + vnoise(vW.xz / 23.0) * 0.35 + vnoise(vW.xz / 97.0) * 0.20;
  alb *= 1.0 + fade * (tx - 0.5) * 0.8;
  vec3 col = alb * b * vShadow * sunI;
  // "Enhanced visibility" fill: a display aid, not a measurement.
  // Shadowed ground is tinted blue so it still reads as shadow.
  float hemi = 0.55 + 0.45 * n.y;
  vec3 tint = mix(vec3(0.42, 0.55, 0.95), vec3(1.0), vShadow);
  col += alb * tint * hemi * fill * 0.22;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const curtainVert = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float vTop;
varying float fTop;
varying vec3 vW;
void main() {
  fTop = vTop; vW = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const curtainFrag = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 sunDir;
uniform float sunI;
uniform float fill;
varying float fTop;
varying vec3 vW;
void main() {
  #include <logdepthbuf_fragment>
  // Approximate shading of the distant skyline (display only): slopes facing
  // the observer are lit when the Sun is behind the observer.
  vec2 toC = normalize(vW.xz);
  vec2 s = normalize(sunDir.xz + 1e-6);
  float facing = max(-dot(toC, s), 0.0);
  float up = smoothstep(-0.02, 0.06, sunDir.y + 0.03);
  float b = (0.03 + 0.55 * facing * up) * sunI * mix(0.35, 1.0, fTop);
  vec3 col = vec3(0.60, 0.59, 0.57) * b + vec3(0.42, 0.55, 0.95) * fill * 0.05 * fTop;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const earthVert = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const earthFrag = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 sunFromEarth;
varying vec3 vN;
void main() {
  #include <logdepthbuf_fragment>
  float l = dot(normalize(vN), sunFromEarth);
  float day = smoothstep(-0.03, 0.12, l);
  vec3 col = mix(vec3(0.0, 0.004, 0.012), vec3(0.42, 0.62, 1.0) * (0.35 + 0.75 * max(l, 0.0)), day);
  gl_FragColor = vec4(col, 1.0);
}`;

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,240,210,1)');
  r.addColorStop(0.08, 'rgba(255,225,170,0.55)');
  r.addColorStop(0.3, 'rgba(255,190,110,0.12)');
  r.addColorStop(1, 'rgba(255,170,80,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class SurfaceView {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.5, 2.0e7);
    this.camera.rotation.order = 'YXZ';
    this.yaw = 0;   // azimuth of view, deg clockwise from north
    this.pitch = 2; // deg
    this.fov = 60;
    this.opts = { fill: false, horizon: true, paths: false, earthMag: 1, quality: 'high', detail: true };
    this.floatLinear = !!renderer.extensions.get('OES_texture_float_linear');
    this.objects = [];
    this.grids = [];          // [{rt, bakeMat, half, n}]
    this.bakeDirty = true;
    this.lastBake = -1e9;
    this.bakeScene = new THREE.Scene();
    this.bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.bakeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.bakeQuad.frustumCulled = false;
    this.bakeScene.add(this.bakeQuad);

    this.uniforms = {
      nearTex: { value: null }, farTex: { value: null },
      nearHalf: { value: 1 }, farHalf: { value: 1 }, nearN: { value: 2 }, farN: { value: 2 },
      sunDir: { value: new THREE.Vector3(0, 0.01, -1) },
      sunR: { value: 0.2666 * DEG }, sunI: { value: 1.0 }, fill: { value: 0 }, detail: { value: 1 },
      steps: { value: 96 }, growth: { value: 1.094 }, d0: { value: 30 },
    };

    // Sun disc + decorative glow
    this.sun = new THREE.Mesh(new THREE.CircleGeometry(1, 64),
      new THREE.MeshBasicMaterial({ color: 0xfff6e2, toneMapped: false }));
    this.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      transparent: true }));
    this.scene.add(this.sun, this.sunGlow);

    // Earth: a sphere lit from the true Sun direction -> correct phase.
    this.earthMat = new THREE.ShaderMaterial({
      uniforms: { sunFromEarth: { value: new THREE.Vector3(1, 0, 0) } },
      vertexShader: earthVert, fragmentShader: earthFrag });
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.earthMat);
    this.scene.add(this.earth);

    this.pathGroup = new THREE.Group();
    this.scene.add(this.pathGroup);
  }

  // ------------------------------------------------------------- site setup
  _dataTex(q, n, quantum, nodata) {
    const f = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) f[i] = q[i] === nodata ? -1e5 : q[i] * quantum;
    let tex;
    if (this.floatLinear) {
      tex = new THREE.DataTexture(f, n, n, THREE.RedFormat, THREE.FloatType);
    } else {
      const h = new Uint16Array(f.length);
      for (let i = 0; i < f.length; i++) h[i] = THREE.DataUtils.toHalfFloat(f[i]);
      tex = new THREE.DataTexture(h, n, n, THREE.RedFormat, THREE.HalfFloatType);
    }
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  _gridGeometry(q, n, half, quantum, nodata, holeHalf, skirt) {
    const sp = (2 * half) / (n - 1);
    const pos = new Float32Array(n * n * 3);
    const bad = new Uint8Array(n * n);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        const E = -half + c * sp, N = -half + r * sp;
        const v = q[i];
        bad[i] = v === nodata;
        pos[i * 3] = E; pos[i * 3 + 1] = bad[i] ? 0 : v * quantum; pos[i * 3 + 2] = -N;
      }
    }
    const idx = [];
    const inside = (r, c) => Math.abs(-half + c * sp) <= holeHalf + 1e-6 && Math.abs(-half + r * sp) <= holeHalf + 1e-6;
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const a = r * n + c, b = a + 1, d = a + n, e = d + 1;
        if (bad[a] || bad[b] || bad[d] || bad[e]) continue;
        if (holeHalf > 0 && inside(r, c) && inside(r, c + 1) && inside(r + 1, c) && inside(r + 1, c + 1)) continue;
        idx.push(a, b, d, b, e, d);
      }
    }
    let positions = pos;
    if (skirt > 0) {
      // vertical skirt around the border hides cracks against the far mesh
      const ring = [];
      for (let c = 0; c < n; c++) ring.push(c);
      for (let r = 1; r < n; r++) ring.push(r * n + n - 1);
      for (let c = n - 2; c >= 0; c--) ring.push((n - 1) * n + c);
      for (let r = n - 2; r >= 0; r--) ring.push(r * n);
      const extra = new Float32Array(ring.length * 3);
      ring.forEach((i, k) => {
        extra[k * 3] = pos[i * 3]; extra[k * 3 + 1] = pos[i * 3 + 1] - skirt; extra[k * 3 + 2] = pos[i * 3 + 2];
      });
      positions = new Float32Array(pos.length + extra.length);
      positions.set(pos); positions.set(extra, pos.length);
      const base = n * n;
      for (let k = 0; k < ring.length - 1; k++) {
        const a = ring[k], b = ring[k + 1], a2 = base + k, b2 = base + k + 1;
        idx.push(a, a2, b, b, a2, b2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  setSite(site) {
    for (const o of this.objects) { this.scene.remove(o); o.geometry.dispose(); o.material.dispose(); }
    this.objects = [];
    for (const g of this.grids) { g.rt.dispose(); g.bakeMat.dispose(); }
    this.grids = [];
    for (const k of ['nearTex', 'farTex']) this.uniforms[k].value?.dispose();
    this.site = site;
    const T = site.meta.terrain;
    const u = this.uniforms;
    u.nearTex.value = this._dataTex(site.near, T.near.n, T.near.quantum_m, T.nodata);
    u.farTex.value = this._dataTex(site.far, T.far.n, T.far.quantum_m, T.nodata);
    u.nearHalf.value = T.near.half_m; u.farHalf.value = T.far.half_m;
    u.nearN.value = T.near.n; u.farN.value = T.far.n;

    // one shadow render target + bake pass + terrain material per grid
    const mkGrid = (spec, tex) => {
      const rt = new THREE.WebGLRenderTarget(spec.n, spec.n, {
        type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      const gu = { gridHalf: { value: spec.half_m }, gridN: { value: spec.n } };
      const bakeMat = new THREE.ShaderMaterial({
        uniforms: { ...u, ...gu, gridTex: { value: tex } }, vertexShader: bakeVert, fragmentShader: bakeFrag,
        depthTest: false, depthWrite: false });
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...u, ...gu, shadowTex: { value: rt.texture } },
        vertexShader: terrainVert, fragmentShader: terrainFrag, side: THREE.DoubleSide });
      this.grids.push({ rt, bakeMat });
      return mat;
    };
    const nearMat = mkGrid(T.near, u.nearTex.value);
    const farMat = mkGrid(T.far, u.farTex.value);
    this.bakeDirty = true;
    const near = new THREE.Mesh(this._gridGeometry(site.near, T.near.n, T.near.half_m, T.near.quantum_m, T.nodata, 0, 150), nearMat);
    const far = new THREE.Mesh(this._gridGeometry(site.far, T.far.n, T.far.half_m, T.far.quantum_m, T.nodata, T.near.half_m, 0), farMat);
    near.frustumCulled = far.frustumCulled = false;

    // Skyline curtain from the computed horizon mask: guarantees the visible
    // skyline equals the mask even where the decimated far mesh is lower.
    const mask = site.meta.mask.el_deg, step = site.meta.mask.az_step_deg;
    const m = mask.length;
    const cp = new Float32Array((m + 1) * 2 * 3), top = new Float32Array((m + 1) * 2);
    const ci = [];
    for (let k = 0; k <= m; k++) {
      const az = (k % m) * step * DEG;
      const sx = Math.sin(az), sz = -Math.cos(az);
      const yT = CURTAIN_D * Math.tan(mask[k % m] * DEG);
      const yB = CURTAIN_D * Math.tan(-15 * DEG);
      cp.set([sx * CURTAIN_D, yT, sz * CURTAIN_D, sx * CURTAIN_D, yB, sz * CURTAIN_D], k * 6);
      top[k * 2] = 1; top[k * 2 + 1] = 0;
      if (k < m) { const a = 2 * k; ci.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(cp, 3));
    cg.setAttribute('vTop', new THREE.BufferAttribute(top, 1));
    cg.setIndex(ci);
    const curtain = new THREE.Mesh(cg, new THREE.ShaderMaterial({
      uniforms: { sunDir: u.sunDir, sunI: u.sunI, fill: u.fill },
      vertexShader: curtainVert, fragmentShader: curtainFrag, side: THREE.DoubleSide }));
    curtain.frustumCulled = false;

    // Computed horizon line overlay
    const lp = new Float32Array((m + 1) * 3);
    for (let k = 0; k <= m; k++) {
      const az = (k % m) * step * DEG;
      lp.set([Math.sin(az) * LINE_D, LINE_D * Math.tan(mask[k % m] * DEG), -Math.cos(az) * LINE_D], k * 3);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
    this.horizonLine = new THREE.Line(lg, new THREE.LineBasicMaterial({
      color: 0x46e0c8, transparent: true, opacity: 0.85, depthTest: false }));
    this.horizonLine.renderOrder = 10;
    this.horizonLine.frustumCulled = false;

    this.objects.push(near, far, curtain, this.horizonLine);
    this.scene.add(near, far, curtain, this.horizonLine);
    this.applyOptions();
  }

  /** Sun/Earth sky paths over [t0, t1] (hourly), dim where blocked. */
  setPaths(site, sampleFn, t0, t1) {
    for (const c of [...this.pathGroup.children]) { this.pathGroup.remove(c); c.geometry.dispose(); c.material.dispose(); }
    if (!site) return;
    const D = SKY_D * 0.9;
    const mk = (azK, elK, visFn, rgb) => {
      const pts = [], cols = [], dots = [];
      for (let t = t0, k = 0; t <= t1; t += 3600, k++) {
        const s = sampleFn(t);
        const v = azElToVec(s[azK], s[elK]);
        pts.push(v[0] * D, v[1] * D, v[2] * D);
        const f = visFn(s) ? 1 : 0.28;
        cols.push(rgb[0] * f, rgb[1] * f, rgb[2] * f);
        if (k % 24 === 0) dots.push(v[0] * D, v[1] * D, v[2] * D);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, toneMapped: false }));
      const dg = new THREE.BufferGeometry();
      dg.setAttribute('position', new THREE.Float32BufferAttribute(dots, 3));
      const pm = new THREE.PointsMaterial({ color: new THREE.Color(...rgb), size: 4, sizeAttenuation: false, depthTest: false, toneMapped: false });
      const p = new THREE.Points(dg, pm);
      for (const o of [line, p]) { o.renderOrder = 9; o.frustumCulled = false; this.pathGroup.add(o); }
    };
    mk('sunAz', 'sunEl', (s) => s.sunFrac > 0, [1.0, 0.72, 0.28]);
    mk('earthAz', 'earthEl', (s) => s.earthVis, [0.37, 0.7, 1.0]);
  }

  applyOptions() {
    const o = this.opts;
    this.uniforms.fill.value = o.fill ? 1 : 0;
    this.uniforms.detail.value = o.detail ? 1 : 0;
    if (this.horizonLine) this.horizonLine.visible = o.horizon;
    this.pathGroup.visible = o.paths;
    const hi = o.quality === 'high';
    this.uniforms.steps.value = hi ? 96 : 48;
    this.uniforms.growth.value = hi ? 1.094 : 1.196;
    this.bakeDirty = true;
  }

  update(s) {
    this.state = s;
    const sv = azElToVec(s.sunAz, s.sunEl);
    const cur = this.uniforms.sunDir.value;
    // re-bake shadows when the Sun has moved by more than ~0.002 deg
    if (Math.abs(cur.x - sv[0]) + Math.abs(cur.y - sv[1]) + Math.abs(cur.z - sv[2]) > 4e-5) this.bakeDirty = true;
    this.uniforms.sunDir.value.set(...sv);
    this.uniforms.sunR.value = s.sunR * DEG;
    const sunPos = new THREE.Vector3(...sv).multiplyScalar(SKY_D);
    this.sun.position.copy(sunPos);
    const rs = SKY_D * Math.tan(s.sunR * DEG);
    this.sun.scale.setScalar(rs);
    this.sunGlow.position.copy(sunPos);
    this.sunGlow.scale.setScalar(rs * 14);

    const ev = azElToVec(s.earthAz, s.earthEl);
    const re = SKY_D * Math.sin(s.earthR * DEG) * this.opts.earthMag;
    this.earth.position.set(ev[0] * SKY_D, ev[1] * SKY_D, ev[2] * SKY_D);
    this.earth.scale.setScalar(re);
    // Direction from Earth to Sun, using true distances
    const dS = 695700 / Math.sin(s.sunR * DEG), dE = 6371 / Math.sin(s.earthR * DEG);
    const v = new THREE.Vector3(sv[0] * dS - ev[0] * dE, sv[1] * dS - ev[1] * dE, sv[2] * dS - ev[2] * dE).normalize();
    this.earthMat.uniforms.sunFromEarth.value.copy(v);
  }

  setSize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Recompute terrain shadows into textures (throttled to ~12 Hz). */
  bake(force = false) {
    const now = performance.now();
    if (!this.grids.length || !(this.bakeDirty || force) || (!force && now - this.lastBake < 80)) return;
    const r = this.renderer, prev = r.getRenderTarget();
    for (const g of this.grids) {
      this.bakeQuad.material = g.bakeMat;
      r.setRenderTarget(g.rt);
      r.render(this.bakeScene, this.bakeCam);
    }
    r.setRenderTarget(prev);
    this.bakeDirty = false;
    this.lastBake = now;
  }

  render() {
    this.bake();
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
    this.camera.rotation.set(this.pitch * DEG, -this.yaw * DEG, 0);
    this.sun.quaternion.copy(this.camera.quaternion);
    this.renderer.render(this.scene, this.camera);
  }

  /** Screen position of an az/el direction, or null if behind the camera. */
  project(az, el, w, h) {
    const v = new THREE.Vector3(...azElToVec(az, el)).multiplyScalar(1e6).project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h };
  }

  maskAt(az) {
    return maskLookup(this.site.meta.mask.el_deg, this.site.meta.mask.az_step_deg, az);
  }
}
