/**
 * tracker.js — pipeline de percepción (MediaPipe Tasks Vision).
 *
 * Produce por frame:
 *   { pose, world, hands:[{handedness,score,landmarks}], face, blendshapes, seg:{w,h,data} }
 *
 * Decisiones de diseño importantes para que corra en un celular:
 *  - cuatro modelos pequeños en vez de uno gigante => se puede degradar (si falla la
 *    cara, el juego sigue con manos + cuerpo; si falla la segmentación, la máscara se
 *    construye igual con el esqueleto).
 *  - los .task se descargan con progreso y se cachean en IndexedDB (segunda vez = 0 s).
 *  - delegate GPU con reintento en CPU: hay móviles donde el delegate GPU rompe.
 *  - schedule por perfiles: las manos van todos los frames (son el "mouse" del juego),
 *    pose/cara/segmentación se alternan cuando el dispositivo va justo de fps.
 */

import { CONFIG } from '../config.js';
import { Emitter, clamp, fetchBuffer, withTimeout, humanBytes } from '../util.js';
import { cacheGet, cachePut } from '../idb.js';

export const MODULES = ['pose', 'hands', 'face', 'selfie'];

export class Tracker extends Emitter {
  /**
   * @param {{profile?:string, wasmPath?:string, modelBase?:string, enabled?:Object}} opts
   */
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.enabled = { ...(CONFIG.vision.profiles[opts.profile || 'medio'] || CONFIG.vision.profiles.medio) };
    this.wasmPath = opts.wasmPath || CONFIG.paths.mediapipeWasm;
    this.mv = null;               // módulo vision_bundle
    this.vision = null;           // FilesetResolver result
    this.d = { pose: null, hands: null, face: null, selfie: null };
    this.status = { phase: 'idle', detail: '', progress: 0, loaded: {}, errors: {}, delegate: null, fps: 0, cost: 0 };
    this.cache = { pose: null, hands: null, face: null, seg: null };
    this.tick = 0;
    this.lastTs = 0;
    this.closed = false;
  }

  get ready() { return !!(this.d.pose || this.d.hands) && this.status.phase === 'ready'; }
  get fullReady() { return this.ready && !Object.keys(this.status.errors).length; }

  #report(patch) { Object.assign(this.status, patch); this.emit('status', { ...this.status }); }

  /** Descarga (o recupera de caché) el binario de un modelo. */
  async #loadModel(kind, onProgress) {
    const rel = CONFIG.vision.modelRel[kind];
    const base = (this.opts.modelBase || '').trim().replace(/\/$/, '');
    const urls = (base && rel ? [`${base}/${rel}`] : []).concat(CONFIG.vision.models[kind] || []);
    for (const url of urls) {
      const hit = await cacheGet(url).catch(() => null);
      if (hit) { onProgress?.(hit.byteLength, hit.byteLength); return { buffer: new Uint8Array(hit), url, cached: true }; }
      try {
        const buf = await withTimeout(fetchBuffer(url, onProgress), 45000, url.split('/').pop());
        cachePut(url, buf.slice ? buf.slice(0) : buf).catch(() => {});
        return { buffer: new Uint8Array(buf), url, cached: false };
      } catch (err) {
        this.status.errors[`${kind}:url`] = String(err?.message || err);
        this.#report({ detail: `No se pudo bajar ${kind} (${url.split('/').pop()}).` });
      }
    }
    throw new Error(`Ninguna fuente funcionó para el modelo «${kind}»`);
  }

  /** Crea un detector intentando GPU y luego CPU. */
  async #create(kind, cls, options) {
    for (const delegate of ['GPU', 'CPU']) {
      try {
        const obj = { ...options, baseOptions: { ...options.baseOptions, delegate } };
        const inst = await cls.createFromOptions(this.vision, obj);
        this.status.delegate = this.status.delegate || delegate;
        return inst;
      } catch (err) {
        this.status.errors[`${kind}:${delegate}`] = String(err?.message || err);
      }
    }
    throw new Error(`No se pudo inicializar ${this.status.errors[`${kind}:CPU`] || kind}`);
  }

  /**
   * Carga wasm + modelos + detectores. Nunca lanza: los fallos parciales quedan en
   * `status.errors` y el juego arranca igual con lo que haya (o en modo demo).
   * @returns {Promise<boolean>} true si quedó útil.
   */
  async init() {
    this.#report({ phase: 'loading', detail: 'Cargando motor de visión…', progress: 0.02 });
    try {
      this.mv = await import(CONFIG.paths.mediapipe);
      this.vision = await this.mv.FilesetResolver.forVisionTasks(this.wasmPath);
    } catch (err) {
      this.#report({ phase: 'error', detail: `Motor de visión no disponible: ${err.message}` });
      this.status.errors.wasm = String(err?.message || err);
      return false;
    }

    const { FilesetResolver: _f, ...m } = this.mv;
    const total = Object.keys(this.enabled).filter((k) => this.enabled[k]).length || 1;
    let done = 0;
    const wanted = MODULES.filter((k) => this.enabled[k]);

    for (const kind of wanted) {
      this.#report({ detail: `Descargando modelo: ${kind} (${humanBytes(0)})`, progress: 0.05 + 0.75 * (done / total) });
      let loaded;
      try {
        loaded = await this.#loadModel(kind, (got, tot) => {
          if (!tot) return;
          this.#report({ progress: 0.05 + 0.75 * ((done + got / tot) / total), detail: `Descargando ${kind}: ${humanBytes(got)} / ${humanBytes(tot)}` });
        });
      } catch (err) {
        this.status.errors[kind] = String(err?.message || err);
        done++;
        continue;
      }
      try {
        const min = CONFIG.vision.minConfidence;
        if (kind === 'pose') {
          this.d.pose = await this.#create('pose', m.PoseLandmarker, {
            baseOptions: { modelAssetBuffer: loaded.buffer },
            runningMode: 'VIDEO', numPoses: 1,
            minPoseDetectionConfidence: min, minPosePresenceConfidence: min, minTrackingConfidence: min,
          });
        } else if (kind === 'hands') {
          this.d.hands = await this.#create('hands', m.HandLandmarker, {
            baseOptions: { modelAssetBuffer: loaded.buffer },
            runningMode: 'VIDEO', numHands: CONFIG.vision.numHands,
            minHandDetectionConfidence: 0.45, minHandPresenceConfidence: 0.45, minTrackingConfidence: 0.4,
          });
        } else if (kind === 'face') {
          this.d.face = await this.#create('face', m.FaceLandmarker, {
            baseOptions: { modelAssetBuffer: loaded.buffer },
            runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
            minFaceDetectionConfidence: 0.45, minFacePresenceConfidence: 0.4, minTrackingConfidence: 0.4,
          });
        } else if (kind === 'selfie') {
          this.d.selfie = await this.#create('selfie', m.ImageSegmenter, {
            baseOptions: { modelAssetBuffer: loaded.buffer },
            runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false,
          });
        }
        this.status.loaded[kind] = { from: loaded.cached ? 'caché' : 'red', bytes: loaded.buffer.byteLength };
        done++;
        this.#report({ progress: 0.05 + 0.75 * (done / total), detail: `Listo: ${kind}` });
      } catch (err) {
        this.status.errors[kind] = String(err?.message || err);
        done++;
      }
    }

    const ok = !!(this.d.pose || this.d.hands);
    this.#report({
      phase: ok ? 'ready' : 'error',
      progress: 1,
      detail: ok ? `Visor listo (${Object.keys(this.d).filter((k) => this.d[k]).join(' + ')})` : 'No se pudo iniciar la detección corporal',
    });
    return ok;
  }

  setProfile(name) {
    const p = CONFIG.vision.profiles[name];
    if (!p) return;
    this.enabled = { ...p };
    this.emit('profile', p);
  }

  /**
   * Procesa un frame del <video>. Devuelve `null` si todavía no hay nada útil.
   * @param {HTMLVideoElement} video
   */
  async process(video, ts = Math.floor(performance.now())) {
    if (this.closed || !video || video.readyState < 2) return null;
    ts = Math.max(ts, this.lastTs + 1);
    this.lastTs = ts;
    this.tick++;
    const t0 = performance.now();
    const every = this.enabled.everyN || 1;
    const skipBody = this.tick % every !== 0;
    const out = { ts, skipped: 0 };

    // Manos: todos los frames (mandan el agarre del juego).
    if (this.d.hands) {
      try {
        const r = this.d.hands.detectForVideo(video, ts);
        if (r) this.cache.hands = mapHands(r);
        r.close?.();
      } catch (err) { this.#fail('hands', err); }
    }

    // Cuerpo: alterno cuando el perfil lo pide.
    if (this.d.pose && !skipBody) {
      try {
        const r = this.d.pose.detectForVideo(video, ts);
        if (r?.landmarks?.length) this.cache.pose = r.landmarks[0];
        if (r?.worldLandmarks?.length) this.cache.world = r.worldLandmarks[0];
        r.close?.();
      } catch (err) { this.#fail('pose', err); }
    }

    if (this.d.face && !skipBody) {
      try {
        const r = this.d.face.detectForVideo(video, ts);
        if (r?.faceLandmarks?.length) this.cache.face = r.faceLandmarks[0];
        if (r?.faceBlendshapes?.length) this.cache.blendshapes = r.faceBlendshapes[0].categories;
        r.close?.();
      } catch (err) { this.#fail('face', err); }
    }

    if (this.d.selfie && !skipBody) {
      try {
        const r = this.d.selfie.segmentForVideo(video, ts);
        const mask = r?.confidenceMasks?.[0] || r?.categoryMask || null;
        if (mask) this.cache.seg = readMask(mask);
        r.close?.();
      } catch (err) { this.#fail('selfie', err); }
    }

    const cost = performance.now() - t0;
    this.status.cost = cost;
    this.status.fps = 1000 / Math.max(1, cost + 1);
    out.cost = cost;
    return {
      ...this.cache,
      hands: this.cache.hands || [],
      pose: this.cache.pose || null,
      face: this.cache.face || null,
      seg: this.cache.seg || null,
      ts,
      cost,
      active: { ...this.enabled },
    };
  }

  #fail(kind, err) {
    const msg = String(err?.message || err);
    if (this.status.errors[kind] === msg) return;
    this.status.errors[kind] = msg;
    this.emit('error', { kind, message: msg });
    // Un detector que revienta en caliente se apaga para no romper el bucle.
    if (/gl|shader|texture|WebGL/i.test(msg)) {
      try { this.d[kind]?.close?.(); } catch { /* noop */ }
      this.d[kind] = null;
      this.#report({ detail: `Visor: módulo ${kind} desactivado por un fallo de GPU.` });
    }
  }

  close() {
    this.closed = true;
    for (const k of MODULES) { try { this.d[k]?.close?.(); } catch { /* noop */ } this.d[k] = null; }
    this.cache = { pose: null, hands: null, face: null, seg: null };
  }
}

function mapHands(r) {
  const hands = [];
  const n = r.landmarks?.length || 0;
  for (let i = 0; i < n; i++) {
    const cat = r.handednesses?.[i]?.[0];
    hands.push({
      handedness: cat?.categoryName === 'Right' ? 'Right' : cat?.categoryName === 'Left' ? 'Left' : (i === 0 ? 'Right' : 'Left'),
      score: cat?.score ?? 0.9,
      landmarks: r.landmarks[i],
      world: r.worldLandmarks?.[i] || null,
      index: i,
    });
  }
  return hands;
}

/** Convierte el MPMask de MediaPipe en un buffer 0..1 reutilizable. */
function readMask(mask) {
  const w = mask.width || 0, h = mask.height || 0;
  if (!w || !h) return null;
  let data = null;
  try { data = mask.getAsFloat32Array(); } catch { data = null; }
  if (!data || data.length < w * h) {
    try {
      const u8 = mask.getAsUint8Array();
      if (u8 && u8.length >= w * h) {
        const f = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) f[i] = u8[i] / 255;
        data = f;
      }
    } catch { data = null; }
  }
  if (!data || data.length < w * h) return null;
  return { w, h, data, source: 'segmenter' };
}

/** Intensidad de la máscara de segmentación en una coordenada normalizada. */
export function sampleMask(seg, u, v) {
  if (!seg?.data) return 0;
  const x = clamp(Math.round(u * (seg.w - 1)), 0, seg.w - 1);
  const y = clamp(Math.round(v * (seg.h - 1)), 0, seg.h - 1);
  const v0 = seg.data[y * seg.w + x];
  return v0 > 1 ? v0 / 255 : v0;
}

export default Tracker;
