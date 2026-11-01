/* Zig Metamorphosis, mobile web player. Everything runs on the device; no network calls except the
   video link you paste (and the app files themselves). */
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const DEFAULTS = { mode: 'cycle', intensity: 60, speed: 40, adapt: 25, perf: 'medium' };
  const MODES = { liquid: 0, dissolve: 1, refraction: 2, chroma: 3, cycle: 4, brain: 5 };
  // Lite performance approach: fps cap + reduced internal resolution (relative to screen pixels, max 2x)
  const PERF = {
    low:    { fps: 15, scale: 0.5,  max: 720 },
    medium: { fps: 24, scale: 0.6,  max: 960 },
    high:   { fps: 30, scale: 0.85, max: 1280 },
  };
  const BRAIN_FPS = 15, BRAIN_SCALE = 0.75, HIDE_MS = 3000, KEY = 'zigMobileSettings';
  const stats = { draws: 0, uploads: 0, cssUpdates: 0 };

  let settings = { ...DEFAULTS };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* private mode */ }
  if (!(settings.mode in MODES)) settings.mode = DEFAULTS.mode;
  if (!PERF[settings.perf]) settings.perf = DEFAULTS.perf;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) {} };

  const video = $('video'), canvas = $('canvas'), stage = $('stage'), ui = $('ui');
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches;
  const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  // ---------------------------------------------------------------- shaders (mediump, 1–2 noise octaves, no loops)
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
      float dotA = (1.0 - smoothstep(0.006, 0.010, r)) * u_bAlpha * 0.9;
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

  // ---------------------------------------------------------------- timing (same as the extension)
  const perf = () => PERF[settings.perf] || PERF.medium;
  const isBrain = () => settings.mode === 'brain';
  const speedFactor = () => 0.1 + (settings.speed / 100) * 2.4;
  const intensity = () => Math.max(0, Math.min(1, settings.intensity / 100));
  let clock = 0, lastNow = performance.now();
  function tick() {
    const now = performance.now();
    clock += Math.min(0.1, (now - lastNow) / 1000) * speedFactor();
    lastNow = now;
    return clock;
  }
  function cycleState(t) {
    const pos = t / 7.0, i = Math.floor(pos) % 4, f = pos - Math.floor(pos);
    const b = f < 0.6 ? 0 : (f - 0.6) / 0.4;
    return { a: i, b: (i + 1) % 4, mix: b * b * (3 - 2 * b) };
  }
  function modeState(t) {
    const m = MODES[settings.mode] ?? 4;
    if (m === 4) return cycleState(t);
    if (m === 5) return { a: 0, b: 0, mix: 0, brain: true };
    return { a: m, b: m, mix: 0 };
  }
  // Brain Morph timeline: spiral adapt -> ~2 s fade -> view; then expanding rings; then gentle peripheral drift.
  // Pattern phase advances 0.25–0.85 cycles/s per pixel, so nothing changes faster than ~1 Hz. Never flashes.
  let brainStart = performance.now(), brainPhase = 0, brainSpin = 0, brainLast = performance.now();
  function brainState() {
    const now = performance.now();
    const dt = Math.min(0.2, (now - brainLast) / 1000); brainLast = now;
    brainPhase = (brainPhase + dt * (0.25 + 0.6 * (settings.speed / 100))) % 1000;
    brainSpin += dt * 0.05;
    const adapt = Math.max(5, Math.min(120, Number(settings.adapt) || 25));
    const FADE = 2.0, VIEW = 8.0, sA = adapt + FADE + VIEW, sD = 22, total = sA * 2 + sD;
    let x = ((now - brainStart) / 1000) % total;
    const ease = (u) => u * u * (3 - 2 * u);
    const block = (type, x) => ({ type, alpha: x < 1.5 ? ease(x / 1.5) : x < adapt ? 1 : x < adapt + FADE ? 1 - ease((x - adapt) / FADE) : 0 });
    if (x < sA) return block(0, x);
    x -= sA;
    if (x < sA) return block(1, x);
    x -= sA;
    return { type: 2, alpha: x < 4 ? ease(x / 4) : x < 14 ? 1 : x < 18 ? 1 - ease((x - 14) / 4) : 0 };
  }
  const resetBrain = () => { brainStart = brainLast = performance.now(); };

  // ---------------------------------------------------------------- WebGL
  let gl = null, prog = null, tex = null, U = {}, glFailed = false;
  function initGL() {
    gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false,
      stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
    if (!gl) { glFailed = true; return false; }
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    for (const n of ['u_tex', 'u_time', 'u_int', 'u_modeA', 'u_modeB', 'u_mix', 'u_res', 'u_crop', 'u_brain', 'u_bType', 'u_bAlpha', 'u_bPhase', 'u_bSpin'])
      U[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(U.u_tex, 0);
    gl.uniform4f(U.u_crop, 1, 1, 0, 0);
    return true;
  }
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); gl = null; stop(); });
  canvas.addEventListener('webglcontextrestored', () => { try { initGL(); } catch (e) { glFailed = true; } update(); redrawStill(); });

  // ---------------------------------------------------------------- layout (visual viewport + safe areas)
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.documentElement.appendChild(probe);
  let rect = { x: 0, y: 0, w: 0, h: 0 }, layoutDirty = true;
  function viewport() {
    const vv = window.visualViewport;
    const w = Math.round(vv ? vv.width * vv.scale : innerWidth) || innerWidth;
    const h = Math.round(vv ? vv.height * vv.scale : innerHeight) || innerHeight;
    return { w: Math.min(w, innerWidth) || w, h: Math.min(h, innerHeight) || h };
  }
  function layout() {
    const v = viewport();
    document.documentElement.style.setProperty('--vvw', v.w + 'px');
    document.documentElement.style.setProperty('--vvh', v.h + 'px');
    const cs = getComputedStyle(probe);
    const st = parseFloat(cs.paddingTop) || 0, sr = parseFloat(cs.paddingRight) || 0, sb = parseFloat(cs.paddingBottom) || 0, sl = parseFloat(cs.paddingLeft) || 0;
    // fit the picture inside the safe area (notch / home indicator / rounded corners), centred
    const aw = Math.max(1, v.w - sl - sr), ah = Math.max(1, v.h - st - sb);
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9, ar = vw / vh;
    let w = aw, h = aw / ar;
    if (h > ah) { h = ah; w = ah * ar; }
    w = Math.round(w); h = Math.round(h);
    rect = { x: Math.round(sl + (aw - w) / 2), y: Math.round(st + (ah - h) / 2), w, h };
    for (const el of [video, canvas]) {
      el.style.left = rect.x + 'px'; el.style.top = rect.y + 'px';
      el.style.width = rect.w + 'px'; el.style.height = rect.h + 'px';
    }
    layoutDirty = false;
  }
  function sizeBuffer() {
    const p = perf();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let s = dpr * p.scale * (isBrain() ? BRAIN_SCALE : 1);
    let bw = rect.w * s, bh = rect.h * s;
    const long = Math.max(bw, bh), cap = Math.min(p.max, Math.max(video.videoWidth, video.videoHeight) || p.max);
    if (long > cap) { bw *= cap / long; bh *= cap / long; }
    bw = Math.max(2, Math.round(bw)); bh = Math.max(2, Math.round(bh));
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  }
  let layoutRaf = 0;
  const markLayout = () => { layoutDirty = true; if (!layoutRaf) layoutRaf = requestAnimationFrame(() => { layoutRaf = 0; layout(); redrawStill(); }); };
  window.addEventListener('resize', markLayout);
  window.addEventListener('orientationchange', () => setTimeout(markLayout, 250));
  if (window.visualViewport) visualViewport.addEventListener('resize', markLayout);

  // ---------------------------------------------------------------- fallback (cross-origin without CORS)
  // Video texture is blocked → the canvas only carries the Brain Morph overlay, other modes become a gentle CSS filter.
  let fallback = false, cssLast = 0;
  const CSSP = [ // liquid, dissolve, refraction, chroma
    (t, k) => `hue-rotate(${(18 * k * Math.sin(t * 0.3)).toFixed(1)}deg) saturate(${(1 + 0.5 * k).toFixed(2)})`,
    (t, k) => `contrast(${(1 + 0.25 * k * (0.5 - 0.5 * Math.cos(t * 0.6))).toFixed(2)}) brightness(${(1 + 0.12 * k * Math.sin(t * 0.6)).toFixed(2)}) saturate(${(1 + 0.6 * k).toFixed(2)})`,
    (t, k) => `hue-rotate(${(10 * k * Math.sin(t * 0.21)).toFixed(1)}deg) contrast(${(1 + 0.15 * k).toFixed(2)}) saturate(${(1.15 + 0.3 * k).toFixed(2)})`,
    (t, k) => `hue-rotate(${(160 * k * Math.sin(t * 0.25)).toFixed(1)}deg) saturate(${(1.2 + 0.8 * k).toFixed(2)})`,
  ];
  function updateCss(t, force) {
    const now = performance.now();
    if (!force && now - cssLast < (settings.perf === 'low' ? 250 : 125)) return; // ≤8 updates/s
    cssLast = now;
    if (!fallback || isBrain()) { if (video.style.filter) video.style.filter = ''; return; }
    const st = modeState(t), k = intensity();
    video.style.filter = (st.mix > 0.5 ? CSSP[st.b] : CSSP[st.a])(t, k);
    stats.cssUpdates++;
  }
  function enterFallback() {
    if (fallback) return;
    fallback = true;
    const msg = 'This link\u2019s server doesn\u2019t allow full effects (it doesn\u2019t send CORS headers), so you\u2019re seeing simplified colour effects. Brain Morph still works fully. For all effects, save the video to Files or Photos and choose it with \u201cChoose a video\u201d.';
    $('fallbackNote').textContent = 'Simplified mode: ' + msg;
    $('fallbackNote').hidden = false;
    toast(msg, 9000);
    applyVisibility();
  }

  // ---------------------------------------------------------------- drawing
  function applyVisibility() {
    // GL effects: opaque canvas covers the picture. Brain: transparent overlay. Fallback non-brain: no canvas.
    canvas.style.visibility = (gl && (!fallback || isBrain())) ? 'visible' : 'hidden';
    if (!fallback || isBrain()) video.style.filter = '';
  }
  function draw() {
    if (layoutDirty) layout();
    const t = tick();
    if (!gl) { if (fallback) updateCss(t); return; }
    const st = modeState(t);
    if (fallback && !st.brain) { updateCss(t); return; }
    sizeBuffer();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(U.u_res, canvas.width, canvas.height);
    gl.uniform1f(U.u_int, intensity());
    if (st.brain) {
      const b = brainState();
      gl.uniform1f(U.u_brain, 1); gl.uniform1f(U.u_bType, b.type); gl.uniform1f(U.u_bAlpha, b.alpha);
      gl.uniform1f(U.u_bPhase, brainPhase); gl.uniform1f(U.u_bSpin, brainSpin);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6); stats.draws++;
      return;
    }
    try {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
      stats.uploads++;
    } catch (e) {
      if (e && (e.name === 'SecurityError' || /secur|cross|taint/i.test(e.message || ''))) { enterFallback(); updateCss(t, true); return; }
      return;
    }
    gl.uniform1f(U.u_brain, 0);
    gl.uniform1f(U.u_time, t); gl.uniform1f(U.u_modeA, st.a); gl.uniform1f(U.u_modeB, st.b); gl.uniform1f(U.u_mix, st.mix);
    gl.drawArrays(gl.TRIANGLES, 0, 6); stats.draws++;
  }
  function redrawStill() {
    // one frame when paused (layout/setting change) so the picture isn't stale; no loop
    if (!started || running || document.hidden || video.readyState < 2) return;
    draw();
  }

  // ---------------------------------------------------------------- render loop: only new frames, fps cap, stop when idle
  let started = false, running = false, rvfcId = 0, rafId = 0, lastDraw = 0, lastTime = -1, nextDue = 0;
  const shouldRun = () => started && !!gl && !document.hidden && !video.paused && !video.ended && video.readyState >= 2;
  function schedule() {
    if (!running) return;
    if (hasRVFC) rvfcId = video.requestVideoFrameCallback(onFrame);
    else rafId = requestAnimationFrame(onFrame);
  }
  function onFrame(now) {
    if (!running) return;
    const fps = isBrain() ? Math.min(BRAIN_FPS, perf().fps) : perf().fps;
    const fresh = hasRVFC || video.currentTime !== lastTime;
    // steady-rate pacing: average stays at the cap even when frames arrive with jitter
    const interval = 1000 / fps;
    if (fresh && now >= nextDue - 3) {
      nextDue = (now - nextDue > interval) ? now + interval : nextDue + interval;
      lastDraw = now; lastTime = video.currentTime; draw();
    }
    schedule();
  }
  function start() { if (running) return; running = true; nextDue = 0; lastNow = performance.now(); brainLast = lastNow; schedule(); }
  function stop() {
    running = false;
    if (rvfcId && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(rvfcId);
    if (rafId) cancelAnimationFrame(rafId);
    rvfcId = rafId = 0;
  }
  function update() {
    if (shouldRun()) start(); else stop();
    if (!gl && started && fallback) updateCss(clock, true);
  }
  // CSS-filter-only path (no WebGL at all) still needs a slow ticker while playing
  setInterval(() => { if (started && !gl && fallback && !document.hidden && !video.paused) updateCss(tick()); }, 250);

  for (const e of ['play', 'playing', 'pause', 'ended', 'seeked', 'loadeddata', 'waiting', 'emptied']) video.addEventListener(e, () => { update(); syncUI(); });
  video.addEventListener('seeked', () => setTimeout(redrawStill, 30));
  video.addEventListener('loadedmetadata', markLayout);
  document.addEventListener('visibilitychange', () => { update(); if (!document.hidden) { wake(); markLayout(); } });

  // keep the screen awake while playing (iOS 16.4+); harmless where unsupported
  let lock = null;
  async function wake() {
    if (!('wakeLock' in navigator) || video.paused || document.hidden || lock) return;
    try { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } catch (e) { lock = null; }
  }
  video.addEventListener('playing', wake);
  video.addEventListener('pause', () => { if (lock) lock.release().catch(() => {}); });

  // ---------------------------------------------------------------- loading sources
  let blobUrl = null, loadTimer = 0;
  function homeMsg(text) { const m = $('homeMsg'); m.textContent = text || ''; m.hidden = !text; }
  function resetPlayer() {
    stop(); started = false; fallback = false;
    clearTimeout(loadTimer);
    $('fallbackNote').hidden = true;
    video.style.filter = '';
    video.removeAttribute('src'); video.load();
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
    if (gl) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
  }
  function load(src, title, isFile, fromGesture) {
    resetPlayer(); homeMsg('');
    let attempt = isFile ? 'file' : 'cors';
    const tryLoad = () => {
      if (attempt === 'cors') video.crossOrigin = 'anonymous'; else video.removeAttribute('crossorigin');
      video.src = src; video.load();
    };
    const onErr = () => {
      if (attempt === 'cors') { attempt = 'plain'; tryLoad(); return; } // maybe the server just lacks CORS → play without it
      cleanup(); showHome();
      homeMsg(isFile ? 'This video format can\u2019t be played here. Try a different video (MP4 or MOV work best).'
        : 'Couldn\u2019t play that link. It has to be a direct link to a video file (usually ending in .mp4, .mov or .m3u8), not a page like YouTube or Instagram.' +
          (/^http:/i.test(src) && location.protocol === 'https:' ? ' Also, links starting with http:// are blocked on secure pages; use https:// instead.' : ''));
    };
    const onReady = () => {
      cleanup();
      $('title').textContent = title;
      showStage();
      started = true; resetBrain(); clock = 0;
      layout(); applyVisibility(); syncUI();
      if (attempt === 'plain' && !isBrain()) { /* texture will be blocked; detected on first upload */ }
      autoplay(fromGesture);
    };
    const cleanup = () => { video.removeEventListener('error', onErr); video.removeEventListener('loadeddata', onReady); clearTimeout(loadTimer); };
    video.addEventListener('error', onErr);
    video.addEventListener('loadeddata', onReady);
    loadTimer = setTimeout(() => { if (!started) { cleanup(); resetPlayer(); showHome(); homeMsg('That video is taking too long to load. Check the link or your connection and try again.'); } }, 25000);
    tryLoad();
  }
  async function autoplay() {
    // try with sound (a file pick or button tap usually counts as a gesture); else muted; else Tap to play
    video.muted = false;
    try { await video.play(); }
    catch (e) {
      video.muted = true;
      try { await video.play(); toast('Playing muted. Tap the speaker button for sound.', 4000); }
      catch (e2) { $('bigPlay').hidden = false; }
    }
    syncUI(); showControls();
  }

  $('file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    blobUrl = null;
    const u = URL.createObjectURL(f);
    load(u, f.name || 'Your video', true, true);
    blobUrl = u;
    e.target.value = '';
  });
  $('urlForm').addEventListener('submit', (e) => {
    e.preventDefault();
    let u = $('url').value.trim();
    if (!u) return;
    if (!/^[a-z]+:/i.test(u)) u = 'https://' + u;
    try { new URL(u); } catch (err) { homeMsg('That doesn\u2019t look like a link. Paste the full address of a video file.'); return; }
    $('url').blur();
    load(u, decodeURIComponent(u.split('/').pop().split('?')[0]) || u, false, true);
  });
  $('demoBtn').addEventListener('click', () => load('demo.mp4', 'Demo clip', true, true));

  // ---------------------------------------------------------------- screens
  function showStage() { $('home').hidden = true; stage.hidden = false; document.body.classList.add('playing'); markLayout(); }
  function showHome() {
    stage.hidden = true; $('home').hidden = false; document.body.classList.remove('playing');
    $('bigPlay').hidden = true; hideToast();
    if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
  $('backBtn').addEventListener('click', () => { resetPlayer(); showHome(); });
  if (isIOS && !standalone) $('installTip').hidden = false;

  // ---------------------------------------------------------------- controls: auto-hide after 3 s while playing
  let hideTimer = 0;
  function showControls() {
    ui.classList.add('show'); stage.classList.remove('hide-cursor');
    clearTimeout(hideTimer);
    if (!video.paused && !video.ended) hideTimer = setTimeout(hideControls, HIDE_MS);
  }
  function hideControls() {
    if (video.paused || video.ended) return;
    ui.classList.remove('show'); stage.classList.add('hide-cursor'); clearTimeout(hideTimer);
  }
  // tap anywhere on the picture: toggle controls (never shown over a playing video unless you ask)
  stage.addEventListener('click', (e) => {
    if (e.target.closest('.panel, .topbar, .big-play, .toast')) return;
    if (ui.classList.contains('show') && !video.paused) hideControls(); else showControls();
  });
  ui.addEventListener('pointerdown', (e) => { if (e.target.closest('.panel, .topbar')) showControls(); });
  ui.addEventListener('input', showControls);

  $('bigPlay').addEventListener('click', async () => {
    $('bigPlay').hidden = true; video.muted = false;
    try { await video.play(); } catch (e) { video.muted = true; try { await video.play(); } catch (e2) { $('bigPlay').hidden = false; } }
    syncUI(); showControls();
  });
  $('playBtn').addEventListener('click', () => { if (video.paused || video.ended) { $('bigPlay').hidden = true; video.play().catch(() => { $('bigPlay').hidden = false; }); } else video.pause(); });
  $('muteBtn').addEventListener('click', () => { video.muted = !video.muted; syncUI(); });
  video.addEventListener('volumechange', syncUI);

  const fsEl = stage;
  const fsOK = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled) && !standalone;
  if (fsOK) $('fsBtn').hidden = false;
  $('fsBtn').addEventListener('click', () => {
    const inFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (inFs) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen).call(fsEl);
  });
  for (const e of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(e, () => setTimeout(markLayout, 100));

  // seek bar
  const fmt = (s) => { if (!isFinite(s)) return '–:––'; s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
  let seeking = false;
  $('seek').addEventListener('input', () => { seeking = true; const d = video.duration; if (isFinite(d)) { video.currentTime = d * $('seek').value / 1000; $('tCur').textContent = fmt(video.currentTime); } });
  $('seek').addEventListener('change', () => { seeking = false; });
  video.addEventListener('timeupdate', () => {
    if (!ui.classList.contains('show')) return; // don't touch the DOM while controls are hidden
    if (!seeking && isFinite(video.duration)) $('seek').value = Math.round(1000 * video.currentTime / video.duration);
    $('tCur').textContent = fmt(video.currentTime);
  });
  video.addEventListener('durationchange', () => { $('tDur').textContent = fmt(video.duration); });

  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
    on: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM16 8.5a4.5 4.5 0 0 1 0 7M18.5 6a8 8 0 0 1 0 12" stroke="currentColor" stroke-width="1.8" fill="currentColor" fill-rule="evenodd"/></svg>',
    off: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };
  function syncUI() {
    const paused = video.paused || video.ended;
    $('playBtn').innerHTML = paused ? ICON.play : ICON.pause;
    $('muteBtn').innerHTML = video.muted ? ICON.off : ICON.on;
    $('muteBtn').classList.toggle('attn', video.muted);
    for (const b of document.querySelectorAll('#modes button')) b.setAttribute('aria-checked', String(b.dataset.mode === settings.mode));
    for (const b of document.querySelectorAll('.perf button')) b.setAttribute('aria-checked', String(b.dataset.perf === settings.perf));
    $('intensity').value = settings.intensity; $('speed').value = settings.speed; $('adapt').value = settings.adapt;
    $('adaptVal').textContent = settings.adapt + 's';
    $('adaptRow').hidden = $('brainHint').hidden = !isBrain();
    if (paused && started) showControls();
  }

  // settings
  $('modes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]'); if (!b) return;
    settings.mode = b.dataset.mode; if (isBrain()) resetBrain();
    save(); applyVisibility(); syncUI(); updateCss(clock, true); redrawStill();
  });
  document.querySelector('.perf').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-perf]'); if (!b) return;
    settings.perf = b.dataset.perf; save(); syncUI(); redrawStill();
  });
  for (const id of ['intensity', 'speed', 'adapt']) $(id).addEventListener('input', () => {
    settings[id] = Number($(id).value); if (id === 'adapt') resetBrain();
    save(); $('adaptVal').textContent = settings.adapt + 's'; updateCss(clock, true); redrawStill();
  });

  // toast
  let toastTimer = 0;
  function toast(text, ms) { const t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, ms || 5000); }
  function hideToast() { $('toast').hidden = true; }
  $('toast').addEventListener('click', hideToast);

  // ---------------------------------------------------------------- boot
  try { initGL(); } catch (e) { gl = null; glFailed = true; }
  applyVisibility(); syncUI(); layout();
  if (glFailed) console.warn('WebGL unavailable: simplified effects only');
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // read-only diagnostics for automated tests (no effect on the app)
  window.__zig = {
    state: () => ({ started, running, fallback, gl: !!gl, mode: settings.mode, perf: settings.perf, draws: stats.draws, uploads: stats.uploads,
      cssUpdates: stats.cssUpdates, buffer: [canvas.width, canvas.height], rect, controls: ui.classList.contains('show'),
      paused: video.paused, muted: video.muted, filter: video.style.filter, canvasVisible: canvas.style.visibility, rvfc: hasRVFC }),
  };
})();
