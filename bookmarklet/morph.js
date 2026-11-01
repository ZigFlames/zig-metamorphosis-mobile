/* Zig Metamorphosis bookmarklet (morph.js)
 * Runs the Zig Metamorphosis effect on the biggest video of any web page, from a Safari bookmark.
 * Light by design: one video, <=24 fps (15 fps Brain Morph), reduced internal resolution, renders only
 * on new video frames, and stops completely when the video is paused, hidden or off screen.
 * Safety: nothing flashes faster than about once per second.
 * CSP-friendly: no innerHTML, no eval, no <style> elements (styles via CSSOM only), Trusted-Types safe. */
(function () {
  'use strict';
  var W = window;
  if (W.__zigMorph) { W.__zigMorph.off(); return; }   // second tap on the bookmark = switch off

  const MODES = { cycle: 4, liquid: 0, dissolve: 1, refraction: 2, chroma: 3, brain: 5 };
  const LABELS = [['cycle', 'Cycle'], ['liquid', 'Liquid Melt'], ['dissolve', 'Dissolve'], ['refraction', 'Refraction'], ['chroma', 'Chroma'], ['brain', 'Brain Morph']];
  const FPS = 24, BRAIN_FPS = 15, SCALE = 0.6, BRAIN_SCALE = 0.75, MAX_SIDE = 960, MIN_W = 80, MIN_H = 60;
  const UA = navigator.userAgent;
  const APPLE = /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1) ||
    (/AppleWebKit/.test(UA) && !/(Chrome|Chromium|CriOS|Edg|OPR|Android)\//.test(UA));
  const KEY = '__zigMorphMode';
  let mode = 'cycle';
  try { const m = localStorage.getItem(KEY); if (m && m in MODES) mode = m; } catch (e) {}
  const settings = { intensity: 55, speed: 40, adapt: 25 };
  const stats = { draws: 0, uploads: 0, filterUpdates: 0 };
  let alive = true;

  const VERT = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

  const FRAG = `
    precision mediump float;
    varying vec2 v_uv;
    uniform sampler2D u_tex;
    uniform float u_time, u_int, u_modeA, u_modeB, u_mix;
    uniform vec2  u_res;
    uniform vec4  u_crop;
    uniform float u_brain, u_bType, u_bAlpha, u_bPhase, u_bSpin;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm2(vec2 p) { return 0.65 * noise(p) + 0.35 * noise(p * 2.03 + 7.1); } // two octaves
    vec3 tex(vec2 uv) {
      uv = clamp(uv, 0.002, 0.998);
      return texture2D(u_tex, uv * u_crop.xy + u_crop.zw).rgb;
    }
    vec3 hueShift(vec3 c, float a) {
      const vec3 k = vec3(0.57735);
      float ca = cos(a);
      return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
    }

    // Liquid Melt: smooth trig flow warped by one noise lookup (no curl/fbm stack)
    vec3 liquid(vec2 uv, float t, float k) {
      vec2 p = uv * vec2(u_res.x / u_res.y, 1.0) * 2.2;
      float n = noise(p * 1.3 + vec2(t * 0.15, -t * 0.2));
      vec2 d = vec2(sin(p.y * 3.1 + t * 0.7 + n * 4.0), cos(p.x * 2.7 - t * 0.5 + n * 4.0)) * 0.016 * k;
      d.y += n * n * 0.05 * k * (1.0 - uv.y);
      vec3 c = tex(uv + d);
      return c + smoothstep(0.7, 1.0, n) * 0.10 * k;
    }

    // Dissolve & Reform: one noise field, one hash per cell, two texture reads
    vec3 dissolve(vec2 uv, float t, float k) {
      float aspect = u_res.x / u_res.y;
      float n = fbm2(uv * vec2(aspect, 1.0) * 4.0 + vec2(0.0, t * 0.12));
      float th = (0.5 - 0.5 * cos(t * 0.6)) * (0.25 + 0.6 * k);
      float edgeW = 0.03 + 0.05 * k;
      float solid = smoothstep(th - edgeW, th + edgeW, n);
      vec3 base = tex(uv);
      if (solid > 0.995) return base;             // most pixels: one read and done
      float cells = mix(110.0, 50.0, k);
      vec2 g = uv * vec2(cells * aspect, cells);
      vec2 cell = floor(g);
      float h = hash(cell);
      vec2 drift = (vec2(h, fract(h * 13.7)) - 0.5) * 0.10 * k * (1.0 - solid);
      drift.y += 0.04 * k * (1.0 - solid) * h;
      vec3 particle = tex((cell + 0.5) / vec2(cells * aspect, cells) - drift);
      vec2 f = fract(g) - 0.5;
      float dotMask = step(dot(f, f), 0.09) * step(1.0 - (1.0 - solid) * 0.9, h + 0.35);
      vec3 c = mix(particle * dotMask * 1.15 + base * 0.12, base, solid);
      float edge = 1.0 - smoothstep(0.0, edgeW * 1.5, abs(n - th));
      c += mix(vec3(1.0, 0.35, 0.9), vec3(0.3, 0.9, 1.0), n) * edge * (0.25 + 0.9 * k) * step(0.02, th);
      return c;
    }

    // Refraction: one-octave density gradient + two unrolled lenses, dispersion
    vec3 refraction(vec2 uv, float t, float k) {
      float aspect = u_res.x / u_res.y;
      vec2 p = uv * vec2(aspect, 1.0);
      vec2 q = p * 2.0 + vec2(t * 0.07, t * 0.05);
      float d0 = noise(q);
      vec2 grad = vec2(noise(q + vec2(0.05, 0.0)) - d0, noise(q + vec2(0.0, 0.05)) - d0) * 20.0;
      vec2 c1 = vec2(0.5 * aspect + 0.3 * aspect * sin(t * 0.21), 0.5 + 0.25 * cos(t * 0.17));
      vec2 c2 = vec2(0.5 * aspect + 0.35 * aspect * cos(t * 0.13 + 1.0), 0.5 + 0.3 * sin(t * 0.19 + 2.0));
      vec2 d1 = p - c1, d2 = p - c2;
      float r1 = length(d1) + 1e-3, r2 = length(d2) + 1e-3;
      vec2 lens = d1 / r1 * sin(r1 * 26.0 - t * 2.2) * exp(-r1 * 3.2) * 0.5
                + d2 / r2 * sin(r2 * 26.0 - t * 2.2) * exp(-r2 * 3.2) * 0.5;
      vec2 off = (grad * 0.012 + lens * 0.018) * k;
      float disp = 0.35 * k;
      vec3 c = vec3(tex(uv + off * (1.0 + disp)).r, tex(uv + off).g, tex(uv + off * (1.0 - disp)).b);
      return c + smoothstep(0.3, 1.0, length(lens)) * 0.08 * k;
    }

    // Chroma Morph: one noise, three reads
    vec3 chroma(vec2 uv, float t, float k) {
      float n = noise(uv * 2.5 + t * 0.08);
      float ang = t * 0.35 + n * 3.0;
      vec2 dir = vec2(cos(ang), sin(ang)) * (0.004 + 0.016 * k) * (0.6 + 0.8 * n);
      vec3 c = vec3(tex(uv + dir).r, tex(uv).g, tex(uv - dir).b);
      float hue = (sin(t * 0.25) * 0.6 + (n - 0.5) * 2.0) * k * 1.6;
      return mix(c, hueShift(c, hue), 0.35 + 0.65 * k);
    }

    vec3 effect(float m, vec2 uv, float t, float k) {
      if (m < 0.5) return liquid(uv, t, k);
      if (m < 1.5) return dissolve(uv, t, k);
      if (m < 2.5) return refraction(uv, t, k);
      return chroma(uv, t, k);
    }

    // Brain Morph overlay: smooth sinusoidal patterns; per-pixel temporal freq = phase rate (< 1 Hz, set in JS)
    vec4 brain(vec2 uv) {
      float aspect = u_res.x / u_res.y;
      vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
      float r = length(p) + 1e-3;
      float th = atan(p.y, p.x);
      float lum, a;
      if (u_bType < 0.5) {
        lum = 0.5 + 0.5 * sin(4.0 * (th + u_bSpin) + 9.0 * log(r) - 6.2831853 * u_bPhase);
        a = smoothstep(0.02, 0.12, r);
      } else if (u_bType < 1.5) {
        lum = 0.5 + 0.5 * sin(10.0 * log(r) + 0.09 * sin(3.0 * th + u_bSpin * 2.0) - 6.2831853 * u_bPhase);
        a = smoothstep(0.02, 0.12, r);
      } else {
        float saw = fract((th + u_bSpin * 0.2) / 6.2831853 * 24.0 + mod(floor(r * 9.0), 2.0) * 0.5);
        lum = mix(0.15, 0.85, saw < 0.8 ? saw / 0.8 : (1.0 - saw) / 0.2);
        a = smoothstep(0.12, 0.35, r) * 0.8;
      }
      float alpha = u_bAlpha * a * (0.18 + 0.47 * u_int);
      vec3 col = mix(vec3(0.05, 0.03, 0.10), vec3(0.95, 0.92, 1.0), lum);
      float dotA = (1.0 - smoothstep(0.012, 0.017, r)) * u_bAlpha * 0.9;
      col = mix(col, vec3(1.0, 0.3, 0.3), dotA);
      alpha = max(alpha, dotA);
      return vec4(col * alpha, alpha);
    }

    void main() {
      if (u_brain > 0.5) { gl_FragColor = brain(v_uv); return; }
      vec3 col = effect(u_modeA, v_uv, u_time, u_int);
      if (u_mix > 0.001) {
        vec3 b = effect(u_modeB, v_uv, u_time, u_int);
        float front = noise(v_uv * 3.0 + u_time * 0.1);
        col = mix(col, b, smoothstep(front - 0.25, front + 0.25, u_mix * 1.5 - 0.25));
      }
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`;

  // ---------------------------------------------------------------- timing
  const speedFactor = () => 0.1 + (settings.speed / 100) * 2.4;
  const intensity = () => settings.intensity / 100;
  let clock = 0, lastNow = performance.now();
  function tick() { const now = performance.now(); clock += Math.min(0.1, (now - lastNow) / 1000) * speedFactor(); lastNow = now; return clock; }
  function cycleState(t) {
    const pos = t / 7.0, i = Math.floor(pos) % 4, f = pos - Math.floor(pos), b = f < 0.6 ? 0 : (f - 0.6) / 0.4;
    return { a: i, b: (i + 1) % 4, mix: b * b * (3 - 2 * b) };
  }
  function modeState(t) {
    const m = MODES[mode];
    if (m === 4) return cycleState(t);
    if (m === 5) return { a: 0, b: 0, mix: 0, brain: true };
    return { a: m, b: m, mix: 0 };
  }
  // Brain Morph timeline: drift pattern for `adapt` s, 2 s fade-out, 8 s viewing; luminance phase rate 0.25-0.85 Hz (never flashes)
  let brainStart = performance.now(), brainPhase = 0, brainSpin = 0, brainLast = performance.now();
  function brainState() {
    const now = performance.now(), dt = Math.min(0.2, (now - brainLast) / 1000); brainLast = now;
    brainPhase = (brainPhase + dt * (0.25 + 0.6 * (settings.speed / 100))) % 1000;
    brainSpin += dt * 0.05;
    const adapt = settings.adapt, FADE = 2.0, VIEW = 8.0, sA = adapt + FADE + VIEW, sD = 22, total = sA * 2 + sD;
    let x = ((now - brainStart) / 1000) % total;
    const ease = (u) => u * u * (3 - 2 * u);
    const block = (type, x) => ({ type, alpha: x < 1.5 ? ease(x / 1.5) : x < adapt ? 1 : x < adapt + FADE ? 1 - ease((x - adapt) / FADE) : 0 });
    if (x < sA) return block(0, x); x -= sA;
    if (x < sA) return block(1, x); x -= sA;
    return { type: 2, alpha: x < 4 ? ease(x / 4) : x < 14 ? 1 : x < 18 ? 1 - ease((x - 14) / 4) : 0 };
  }

  // ---------------------------------------------------------------- fallback filter (cross-origin / DRM video)
  // Safari/iOS: SVG url() filters on <video> are unreliable and slow there, so it uses GPU CSS filter functions.
  // Other browsers: a cheap one-octave SVG displacement + hue filter. Parameters drift slowly, <= 8 updates/s.
  const NS = 'http://www.w3.org/2000/svg';
  let svgRoot = null, turb = null, disp = null, hue = null, fbLast = 0;
  function ensureSvg() {
    if (svgRoot && svgRoot.isConnected) return;
    const el = (n, attrs, parent) => { const e = document.createElementNS(NS, n); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
    svgRoot = el('svg', { width: '0', height: '0', 'aria-hidden': 'true' });
    svgRoot.style.cssText = 'position:absolute!important;width:0!important;height:0!important;overflow:hidden!important;pointer-events:none!important;';
    const f = el('filter', { id: 'zig-morph-bm-filter', x: '-5%', y: '-5%', width: '110%', height: '110%', 'color-interpolation-filters': 'sRGB' }, el('defs', {}, svgRoot));
    turb = el('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.008 0.012', numOctaves: '1', seed: '3', result: 'noise' }, f);
    disp = el('feDisplacementMap', { in: 'SourceGraphic', in2: 'noise', scale: '20', xChannelSelector: 'R', yChannelSelector: 'G', result: 'd' }, f);
    hue = el('feColorMatrix', { in: 'd', type: 'hueRotate', values: '0' }, f);
    document.documentElement.appendChild(svgRoot);
  }
  const CSSP = [
    (t, k) => `hue-rotate(${(18 * k * Math.sin(t * 0.3)).toFixed(1)}deg) saturate(${(1 + 0.5 * k).toFixed(2)})`,
    (t, k) => `contrast(${(1 + 0.25 * k * (0.5 - 0.5 * Math.cos(t * 0.6))).toFixed(2)}) brightness(${(1 + 0.12 * k * Math.sin(t * 0.6)).toFixed(2)}) saturate(${(1 + 0.6 * k).toFixed(2)})`,
    (t, k) => `hue-rotate(${(10 * k * Math.sin(t * 0.21)).toFixed(1)}deg) contrast(${(1 + 0.15 * k).toFixed(2)}) saturate(${(1.15 + 0.3 * k).toFixed(2)})`,
    (t, k) => `hue-rotate(${(160 * k * Math.sin(t * 0.25)).toFixed(1)}deg) saturate(${(1.2 + 0.8 * k).toFixed(2)})`,
  ];
  const SVGP = [{ fx: 0.006, fy: 0.014, s: 45, h: 0 }, { fx: 0.05, fy: 0.05, s: 30, h: 20 }, { fx: 0.012, fy: 0.012, s: 28, h: 0 }, { fx: 0.004, fy: 0.004, s: 10, h: 160 }];
  function filterValue(t) {
    const st = modeState(t), k = intensity();
    if (APPLE) return (st.mix > 0.5 ? CSSP[st.b] : CSSP[st.a])(t, k);
    ensureSvg();
    const A = SVGP[st.a], B = SVGP[st.b], L = (x, y) => x + (y - x) * st.mix, wob = 1 + 0.35 * Math.sin(t * 0.7);
    turb.setAttribute('baseFrequency', `${(L(A.fx, B.fx) * wob).toFixed(5)} ${(L(A.fy, B.fy) * (2 - wob)).toFixed(5)}`);
    disp.setAttribute('scale', (L(A.s, B.s) * k).toFixed(1));
    hue.setAttribute('values', (L(A.h, B.h) * k * Math.sin(t * 0.3)).toFixed(1));
    return 'url(#zig-morph-bm-filter)';
  }

  // ---------------------------------------------------------------- renderer for ONE video
  const EVTS = ['play', 'playing', 'pause', 'ended', 'seeked', 'loadeddata', 'emptied'];
  class Renderer {
    constructor(video) {
      this.video = video; this.mode = 'none'; this.filtered = false;
      this.running = false; this.rvfcId = 0; this.rafId = 0; this.nextDue = 0; this.lastTime = -1;
      this.layoutDirty = true; this.onScreen = true; this.texBlocked = false; this.hasFrame = false;
      this.onEvt = () => this.update();
      for (const e of EVTS) video.addEventListener(e, this.onEvt);
      this.ro = W.ResizeObserver ? new ResizeObserver(() => this.markLayout()) : null;
      if (this.ro) { this.ro.observe(video); if (video.parentElement) this.ro.observe(video.parentElement); }
      this.io = W.IntersectionObserver ? new IntersectionObserver((ents) => { for (const en of ents) this.onScreen = en.isIntersecting; this.update(); }) : null;
      if (this.io) this.io.observe(video);
      // DRM (EME/FairPlay) frames can't be read by WebGL: go straight to the filter/overlay path
      if (video.mediaKeys || video.webkitKeys) this.texBlocked = true;
      if (!this.initGL()) this.mode = 'fallback';
      this.update();
    }
    get usingFallback() { return this.mode === 'fallback' || this.texBlocked; }
    markLayout() {
      this.layoutDirty = true;
      if (!this.layoutRaf) this.layoutRaf = requestAnimationFrame(() => { this.layoutRaf = 0; if (!this.running) this.still(); });
    }
    shouldRun() { const v = this.video; return alive && !document.hidden && this.onScreen && !v.paused && !v.ended && v.readyState >= 2; }
    // paused: keep a frozen effect frame, unless the video uses the browser's own controls (then show them, unobstructed)
    still() {
      if (this.mode !== 'gl' || !this.canvas) return;
      const v = this.video;
      if ((v.paused || v.ended) && v.controls && MODES[mode] !== 5) { this.canvas.style.display = 'none'; return; }
      this.draw(true);
    }
    update() {
      if (!alive) return;
      const brain = MODES[mode] === 5;
      if (this.usingFallback) this.cssFilter(!brain);
      const want = this.shouldRun();
      if (want && !this.running) { this.running = true; lastNow = performance.now(); this.nextDue = 0; this.schedule(); }
      else if (!want && this.running) { this.running = false; this.cancel(); }
      if (!this.running) this.still();
      ui.status();
    }
    schedule() {
      if (!this.running) return;
      const v = this.video;
      if (typeof v.requestVideoFrameCallback === 'function') this.rvfcId = v.requestVideoFrameCallback(() => { this.rvfcId = 0; this.onFrame(true); });
      else this.rafId = requestAnimationFrame(() => { this.rafId = 0; this.onFrame(false); });
    }
    cancel() {
      const v = this.video;
      if (this.rvfcId && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this.rvfcId);
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rvfcId = 0; this.rafId = 0;
    }
    onFrame(isNew) {
      if (!this.running) return;
      const now = performance.now(), brain = MODES[mode] === 5;
      // Brain overlay and the fallback filter don't need new video frames; the GL effect does
      const fresh = isNew || brain || this.usingFallback || this.video.currentTime !== this.lastTime;
      const interval = 1000 / (brain ? BRAIN_FPS : this.usingFallback ? 8 : FPS);
      if (fresh && now >= this.nextDue - 3) {
        this.nextDue = (now - this.nextDue > interval) ? now + interval : this.nextDue + interval;
        this.lastTime = this.video.currentTime;
        const t = tick();
        if (this.mode === 'gl' && (brain || !this.texBlocked)) this.draw(false, t);
        else if (!brain) this.applyFilter(t);
      }
      // rVFC stops firing while frames don't change; the brain overlay / filter keep animating via rAF
      if ((brain || this.usingFallback) && this.rvfcId) { this.cancel(); }
      if (brain || this.usingFallback) this.rafId = requestAnimationFrame(() => { this.rafId = 0; this.onFrame(false); });
      else this.schedule();
    }
    initGL() {
      const v = this.video, parent = v.parentNode;
      if (!parent) return false;
      const c = document.createElement('canvas');
      c.setAttribute('aria-hidden', 'true'); c.setAttribute('data-zig-morph', '');
      c.style.cssText = 'position:absolute!important;pointer-events:none!important;margin:0!important;padding:0!important;border:0!important;' +
        'transform:none!important;max-width:none!important;max-height:none!important;display:none;left:0;top:0;width:0;height:0;';
      const z = getComputedStyle(v).zIndex;
      if (z && z !== 'auto') c.style.zIndex = z;
      let gl = null;
      try { gl = c.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' }); } catch (e) {}
      if (!gl) return false;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
      const vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
      if (!vs || !fs) return false;
      const prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'a_pos');
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]].forEach((p) => gl.texParameteri(gl.TEXTURE_2D, p[0], p[1]));
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      this.u = {};
      ['u_tex', 'u_time', 'u_int', 'u_res', 'u_crop', 'u_modeA', 'u_modeB', 'u_mix', 'u_brain', 'u_bType', 'u_bAlpha', 'u_bPhase', 'u_bSpin'].forEach((n) => { this.u[n] = gl.getUniformLocation(prog, n); });
      gl.uniform1i(this.u.u_tex, 0);
      c.addEventListener('webglcontextlost', (e) => { if (this.canvas !== c) return; e.preventDefault(); this.teardownGL(); this.mode = 'fallback'; this.update(); });
      parent.insertBefore(c, v.nextSibling);   // right after the video: site controls painted later stay on top, taps pass through
      this.canvas = c; this.gl = gl; this.mode = 'gl';
      return true;
    }
    layout() {
      const v = this.video, r = v.getBoundingClientRect(), cs = getComputedStyle(v);
      const vw = v.videoWidth || r.width, vh = v.videoHeight || r.height, fit = cs.objectFit || 'contain';
      const box = { left: r.left + v.clientLeft, top: r.top + v.clientTop, width: v.clientWidth || r.width, height: v.clientHeight || r.height };
      let crop = [1, 1, 0, 0];
      if (vw && vh && box.width && box.height) {
        const ea = box.width / box.height, va = vw / vh;
        if (fit === 'contain' || fit === 'scale-down') {
          if (va > ea) { const h = box.width / va; box.top += (box.height - h) / 2; box.height = h; }
          else { const w = box.height * va; box.left += (box.width - w) / 2; box.width = w; }
        } else if (fit === 'cover') {
          if (va > ea) { const s = ea / va; crop = [s, 1, (1 - s) / 2, 0]; } else { const s = va / ea; crop = [1, s, 0, (1 - s) / 2]; }
        }
      }
      return { box, crop, visible: r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' };
    }
    place(force) {
      const now = performance.now();
      if (!force && !this.layoutDirty && now - (this.lastPlace || 0) < 1000) return this.lastLayout;
      this.layoutDirty = false; this.lastPlace = now;
      const c = this.canvas, v = this.video;
      if (v.parentNode && (c.parentNode !== v.parentNode || c.previousSibling !== v)) v.parentNode.insertBefore(c, v.nextSibling);
      const L = this.layout(); this.lastLayout = L;
      if (!L.visible) return L;
      const op = c.offsetParent; let ox, oy;
      if (op && op !== document.body && op !== document.documentElement) { const pr = op.getBoundingClientRect(); ox = pr.left + op.clientLeft - op.scrollLeft; oy = pr.top + op.clientTop - op.scrollTop; }
      else if (op === document.body && getComputedStyle(document.body).position !== 'static') { const pr = document.body.getBoundingClientRect(); ox = pr.left; oy = pr.top; }
      else { ox = -W.scrollX; oy = -W.scrollY; }
      const s = c.style, b = L.box;
      s.left = (b.left - ox).toFixed(1) + 'px'; s.top = (b.top - oy).toFixed(1) + 'px';
      s.width = b.width.toFixed(1) + 'px'; s.height = b.height.toFixed(1) + 'px';
      const dpr = Math.min(W.devicePixelRatio || 1, 2), scale = dpr * SCALE * (MODES[mode] === 5 ? BRAIN_SCALE : 1);
      let bw = b.width * scale, bh = b.height * scale;
      const cap = Math.min(1, MAX_SIDE / Math.max(bw, bh, 1), MODES[mode] !== 5 && v.videoWidth ? Math.max(v.videoWidth / bw, v.videoHeight / bh) : 1);
      bw = Math.max(1, Math.round(bw * cap)); bh = Math.max(1, Math.round(bh * cap));
      if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; }
      return L;
    }
    cssFilter(on) {
      const v = this.video;
      if (on && !this.filtered) {
        this.savedFilter = v.style.getPropertyValue('filter'); this.savedFilterPrio = v.style.getPropertyPriority('filter');
        this.filtered = true; this.applyFilter(clock, true);
      }
      if (!on && this.filtered) {
        if (this.savedFilter) v.style.setProperty('filter', this.savedFilter, this.savedFilterPrio || ''); else v.style.removeProperty('filter');
        this.filtered = false;
      }
    }
    applyFilter(t, force) {
      if (!this.filtered) return;
      const now = performance.now();
      if (!force && now - fbLast < 125) return;
      fbLast = now;
      this.video.style.setProperty('filter', filterValue(t), 'important'); stats.filterUpdates++;
    }
    draw(stillOnly, t) {
      if (t === undefined) t = clock;
      const v = this.video, gl = this.gl;
      if (this.mode !== 'gl' || !v.isConnected) return;
      const L = this.place(stillOnly);
      if (!L || !L.visible) { this.canvas.style.display = 'none'; return; }
      const st = modeState(t);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.uniform2f(this.u.u_res, this.canvas.width, this.canvas.height);
      gl.uniform1f(this.u.u_int, intensity());
      if (st.brain) {   // transparent overlay; never reads video pixels, so it works on cross-origin and DRM video
        this.cssFilter(false);
        this.canvas.style.display = 'block';
        const b = brainState();
        gl.uniform1f(this.u.u_brain, 1); gl.uniform1f(this.u.u_bType, b.type); gl.uniform1f(this.u.u_bAlpha, b.alpha);
        gl.uniform1f(this.u.u_bPhase, brainPhase); gl.uniform1f(this.u.u_bSpin, brainSpin);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 6); stats.draws++;
        return;
      }
      gl.uniform1f(this.u.u_brain, 0);
      if (this.texBlocked) { this.canvas.style.display = 'none'; this.cssFilter(true); return; }
      if (v.readyState >= 2 && v.videoWidth > 0) {
        try {
          gl.bindTexture(gl.TEXTURE_2D, this.tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, v);
          stats.uploads++; this.hasFrame = true;
        } catch (e) {
          this.texBlocked = true; this.hasFrame = false; this.canvas.style.display = 'none'; this.cssFilter(true);
          ui.toast('This site protects its video, so you get a lighter colour effect. Brain Morph still works fully.');
          ui.status(); this.update();
          return;
        }
      }
      if (!this.hasFrame) { this.canvas.style.display = 'none'; return; }
      this.canvas.style.display = 'block';   // opaque canvas covers the picture; the video itself is left untouched
      gl.uniform1f(this.u.u_time, t);
      gl.uniform4f(this.u.u_crop, L.crop[0], L.crop[1], L.crop[2], L.crop[3]);
      gl.uniform1f(this.u.u_modeA, st.a); gl.uniform1f(this.u.u_modeB, st.b); gl.uniform1f(this.u.u_mix, st.mix);
      gl.drawArrays(gl.TRIANGLES, 0, 6); stats.draws++;
    }
    teardownGL() {
      const old = this.canvas; this.canvas = null;
      if (old) { try { const ext = this.gl && this.gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch (e) {} old.remove(); }
      this.gl = null; this.mode = 'none';
    }
    destroy() {
      this.running = false; this.cancel();
      if (this.layoutRaf) cancelAnimationFrame(this.layoutRaf);
      this.teardownGL(); this.cssFilter(false);
      for (const e of EVTS) this.video.removeEventListener(e, this.onEvt);
      if (this.ro) this.ro.disconnect(); if (this.io) this.io.disconnect();
    }
  }

  // ---------------------------------------------------------------- pick the largest (preferably playing) visible video
  let active = null;
  function pickTarget() {
    let best = null, bestScore = 0;
    const vh = W.innerHeight, vw = W.innerWidth;
    const vids = document.querySelectorAll('video');
    for (let i = 0; i < vids.length; i++) {
      const v = vids[i], r = v.getBoundingClientRect();
      if (r.width < MIN_W || r.height < MIN_H) continue;
      let score = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (!score) continue;
      if (!v.paused && !v.ended) score *= 4;
      if (score > bestScore) { bestScore = score; best = v; }
    }
    return best;
  }
  function scan() {
    if (!alive) return;
    const target = pickTarget();
    if (active && active.video.isConnected && target && target !== active.video) {
      const cur = active.video, cr = cur.getBoundingClientRect(), tr = target.getBoundingClientRect();
      if ((!cur.paused && !cur.ended) === (!target.paused && !target.ended) && cr.width * cr.height >= tr.width * tr.height * 0.8) return;
    }
    if (active && (!target || target !== active.video || !active.video.isConnected)) { active.destroy(); active = null; }
    if (!active && target) active = new Renderer(target);
    ui.status();
  }
  let scanTimer = 0;
  function scheduleScan(delay) { if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = 0; scan(); }, delay || 600); }

  // ---------------------------------------------------------------- minimal UI: a small dot that opens a pill (auto-hides after 3 s)
  const ui = (function () {
    const host = document.createElement('div');
    host.setAttribute('data-zig-morph-ui', '');
    // every property is !important so page CSS can't move it (and so the "all" reset doesn't wipe our own position)
    host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483647!important;top:0!important;left:0!important;transform-origin:0 0!important;' +
      'display:block!important;font:15px/1.25 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif!important;-webkit-text-size-adjust:100%!important;color:#fff!important;';
    const root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
    const mk = (tag, css, text, parent) => { const e = document.createElement(tag); e.style.cssText = css; if (text) e.textContent = text; (parent || root).appendChild(e); return e; };
    const BTN = 'all:initial;box-sizing:border-box;font:inherit;color:#fff;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;';
    const dot = mk('button', BTN + 'display:block;margin:0 0 0 auto;width:44px;height:44px;border-radius:22px;background:radial-gradient(circle at 50% 50%,#ff3b5c 0 4px,#7b3cff 5px,#2fb8ff 70%);' +
      'box-shadow:0 2px 12px rgba(0,0,0,.45);border:2px solid rgba(255,255,255,.85);opacity:.55;transition:opacity .3s;');
    dot.setAttribute('aria-label', 'Zig Morph menu');
    const panel = mk('div', 'display:none;box-sizing:border-box;width:236px;padding:10px;border-radius:20px;background:rgba(14,8,28,.88);' +
      '-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);box-shadow:0 6px 30px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.15);');
    const head = mk('div', 'display:flex;align-items:center;gap:8px;margin:0 2px 8px;', '', panel);
    mk('div', 'flex:1;font-weight:700;font-size:16px;', 'Zig Morph', head);
    const off = mk('button', BTN + 'padding:9px 14px;border-radius:14px;background:#e5484d;font-weight:700;font-size:15px;', 'Off \u2715', head);
    off.setAttribute('aria-label', 'Turn Zig Morph off');
    const grid = mk('div', 'display:grid;grid-template-columns:1fr 1fr;gap:6px;', '', panel);
    const chips = {};
    LABELS.forEach(([m, label]) => {
      const b = mk('button', BTN + 'min-height:44px;padding:6px 8px;border-radius:13px;text-align:center;font-size:14px;font-weight:600;', label, grid);
      b.addEventListener('click', (e) => { e.stopPropagation(); setMode(m); });
      chips[m] = b;
    });
    const msg = mk('div', 'margin:8px 2px 0;font-size:13px;color:#d9ccff;', '', panel);
    const toastEl = mk('div', 'display:none;box-sizing:border-box;width:236px;margin-top:6px;padding:9px 11px;border-radius:14px;background:rgba(14,8,28,.92);font-size:13px;');
    let open = false, hideTimer = 0, toastTimer = 0;
    function paint() {
      for (const m in chips) chips[m].style.background = m === mode ? 'linear-gradient(135deg,#a259ff,#3db4ff)' : 'rgba(255,255,255,.12)';
      dot.style.display = open ? 'none' : 'block'; panel.style.display = open ? 'block' : 'none';
      place();
    }
    function show() { open = true; dot.style.opacity = '1'; paint(); armHide(); }
    function hide() { open = false; dot.style.opacity = '.55'; paint(); }
    function armHide() { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 3000); }
    dot.addEventListener('click', (e) => { e.stopPropagation(); show(); });
    panel.addEventListener('pointerdown', armHide);
    off.addEventListener('click', (e) => { e.stopPropagation(); api.off(); });
    // keep the same on-screen size and spot (right edge, ~30% down) even when the page is pinch-zoomed
    function place() {
      const vv = W.visualViewport, s = vv ? vv.scale : 1, ox = vv ? vv.offsetLeft : 0, oy = vv ? vv.offsetTop : 0;
      const vw = vv ? vv.width : W.innerWidth, vh = vv ? vv.height : W.innerHeight;
      const w = (open || toastEl.style.display === 'block' ? 236 : 44) / s;
      host.style.setProperty('transform', 'scale(' + (1 / s).toFixed(4) + ')', 'important');
      host.style.setProperty('left', (ox + vw - w - 10 / s).toFixed(1) + 'px', 'important');
      host.style.setProperty('top', (oy + vh * 0.3).toFixed(1) + 'px', 'important');
    }
    function status() {
      let t;
      if (!active) t = 'Looking for a video\u2026 start one playing.';
      else if (active.usingFallback && MODES[mode] !== 5) t = 'Light mode: this video is protected. Brain Morph works fully.';
      else if (active.video.paused) t = 'Paused. Play the video to see it.';
      else t = MODES[mode] === 5 ? 'Stare at the red dot in the middle.' : 'Running.';
      if (msg.textContent !== t) msg.textContent = t;
    }
    function toast(text, ms) {
      toastEl.textContent = text; toastEl.style.display = 'block'; place();
      clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.style.display = 'none'; place(); }, ms || 6000);
    }
    const onVV = () => place();
    if (W.visualViewport) { W.visualViewport.addEventListener('resize', onVV); W.visualViewport.addEventListener('scroll', onVV); }
    W.addEventListener('resize', onVV);
    (document.body || document.documentElement).appendChild(host);
    return { show, hide, paint, status, toast, isOpen: () => open,
      remove() { clearTimeout(hideTimer); clearTimeout(toastTimer); host.remove(); if (W.visualViewport) { W.visualViewport.removeEventListener('resize', onVV); W.visualViewport.removeEventListener('scroll', onVV); } W.removeEventListener('resize', onVV); } };
  })();

  function setMode(m) {
    if (!(m in MODES)) return;
    const was = mode; mode = m;
    try { localStorage.setItem(KEY, m); } catch (e) {}
    if (m === 'brain' && was !== 'brain') brainStart = performance.now();
    if (active) {
      active.layoutDirty = true;
      if (m === 'brain' || was === 'brain') { active.running = false; active.cancel(); }
      active.update();
    }
    ui.paint(); ui.status(); ui.show();
  }

  // ---------------------------------------------------------------- global triggers (debounced)
  const mo = new MutationObserver(() => scheduleScan(700));
  mo.observe(document.documentElement, { childList: true, subtree: true });
  const onPlay = () => scheduleScan(100);
  const onVis = () => { if (active) active.update(); };
  let resizeRaf = 0;
  const relayout = () => { if (!resizeRaf) resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; if (active) active.markLayout(); scheduleScan(600); }); };
  const onScroll = () => scheduleScan(800);
  document.addEventListener('play', onPlay, true);
  document.addEventListener('visibilitychange', onVis);
  W.addEventListener('resize', relayout, { passive: true });
  document.addEventListener('fullscreenchange', relayout); document.addEventListener('webkitfullscreenchange', relayout);
  W.addEventListener('scroll', onScroll, { passive: true });

  const api = W.__zigMorph = {
    version: 1,
    off() {
      if (!alive) return; alive = false;
      clearTimeout(scanTimer); mo.disconnect();
      document.removeEventListener('play', onPlay, true); document.removeEventListener('visibilitychange', onVis);
      W.removeEventListener('resize', relayout); W.removeEventListener('scroll', onScroll);
      document.removeEventListener('fullscreenchange', relayout); document.removeEventListener('webkitfullscreenchange', relayout);
      if (active) { active.destroy(); active = null; }
      if (svgRoot) { svgRoot.remove(); svgRoot = null; }
      ui.remove();
      try { delete W.__zigMorph; } catch (e) { W.__zigMorph = undefined; }
    },
    setMode,
    // read-only diagnostics for automated tests
    state() {
      return { alive, mode, apple: APPLE, target: active ? (active.video.id || active.video.currentSrc.slice(0, 80)) : null,
        renderer: active ? (active.usingFallback ? 'fallback' : active.mode) : null, running: !!(active && active.running),
        draws: stats.draws, uploads: stats.uploads, filterUpdates: stats.filterUpdates, uiOpen: ui.isOpen(),
        buffer: active && active.canvas ? [active.canvas.width, active.canvas.height] : null,
        canvasShown: !!(active && active.canvas && active.canvas.style.display === 'block'),
        filter: active ? active.video.style.filter : '' };
    },
  };

  scan(); ui.paint(); ui.status(); ui.show();
  if (!active) ui.toast('Zig Morph is on. Start a video and it will join in.', 5000);
})();
