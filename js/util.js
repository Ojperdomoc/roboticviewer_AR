/** Utilidades sin dependencias (usadas también por los tests en Node). */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : clamp((v - a) / (b - a), 0, 1));
export const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

/** Suavizado exponencial independiente del framerate. */
export const damp = (current, target, lambda, dt) => lerp(current, target, 1 - Math.exp(-lambda * dt));

export const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2 });

export const round1 = (v) => Math.round(v * 10) / 10;
export const mmss = (s) => {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
};

export const uid = (() => { let i = 0; return (p = 'id') => `${p}-${(++i).toString(36)}`; })();

/** Generador determinista (para simulación y tests reproducibles). */
export function mulberry32(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = (arr, rnd = Math.random) => arr[Math.floor((typeof rnd === 'function' ? rnd() : rnd) * arr.length) % arr.length];
export const shuffle = (arr, rnd = Math.random) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor((typeof rnd === 'function' ? rnd() : rnd) * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

/** Emitter mínimo. */
export class Emitter {
  constructor() { this._h = new Map(); }
  on(type, fn) { (this._h.get(type) ?? this._h.set(type, new Set()).get(type)).add(fn); return () => this.off(type, fn); }
  off(type, fn) { this._h.get(type)?.delete(fn); }
  emit(type, payload) {
    const set = this._h.get(type);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(payload); } catch (err) { console.error(`[emitter:${type}]`, err); }
    }
  }
}

/** Persistencia tolerante a fallos (modo privado, Safari, etc.). */
export const store = {
  get(key, fallback = null) {
    try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
};

/** Deep-merge de preferencias del usuario sobre CONFIG. */
export function mergePrefs(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergePrefs(base?.[k] ?? {}, v) : v;
  }
  return out;
}

/** Promise con timeout. */
export function withTimeout(promise, ms, label = 'operación') {
  let to;
  return Promise.race([
    promise.finally(() => clearTimeout(to)),
    new Promise((_, rej) => { to = setTimeout(() => rej(new Error(`Tiempo de espera agotado en ${label}`)), ms); }),
  ]);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Descarga un recurso mostrando progreso; devuelve ArrayBuffer. */
export async function fetchBuffer(url, onProgress) {
  const res = await fetch(url, { mode: 'cors', cache: 'force-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url.split('/').pop()}`);
  const total = Number(res.headers.get('content-length') || 0);
  if (!res.body || !total) {
    const buf = await res.arrayBuffer();
    onProgress?.(buf.byteLength, buf.byteLength);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    onProgress?.(got, total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out.buffer;
}

/** Formatea bytes para la UI. */
export const humanBytes = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/** Normaliza un landmark de MediaPipe ({x,y,z,visibility}) asegurando campos. */
export const norm = (p) => ({ x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0, visibility: p.visibility ?? p.presence ?? 1 });

/** Espejo horizontal de un set de landmarks (cámara frontal = imagen reflejada). */
export const mirrorX = (p) => ({ ...p, x: 1 - p.x });
