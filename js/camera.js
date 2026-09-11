/**
 * camera.js — gestión de la cámara del celular (FRONTAL y TRASERA).
 *
 * Responsabilidades:
 *  - pedir permisos con constraints escalonadas (muchos navegadores movileron
 *    rechazan combinaciones exóticas: probamos HD -> VGA -> cualquier cosa);
 *  - informar qué cámara se abrió REALMENTE (`actualFacing`), porque el navegador
 *    puede ignorar `facingMode` (notebooks con una sola cámara);
 *  - linterna y zoom cuando el hardware lo permite (útil para escanear con la trasera);
 *  - `frameId` monótono: los detectores de MediaPipe exigen timestamps crecientes.
 *
 * No dibuja nada: entrega un <video> listo para usarse como textura.
 */

import { CONFIG } from './config.js';
import { Emitter, clamp } from './util.js';

export class CameraRig extends Emitter {
  /** @param {HTMLVideoElement} video */
  constructor(video) {
    super();
    this.video = video;
    this.stream = null;
    this.track = null;
    this.facing = 'front';
    this.actualFacing = 'front';
    this.running = false;
    this.torch = false;
    this.frameId = 0;
    this.lastError = null;
  }

  get ready() { return this.running && this.video.readyState >= 2 && this.video.videoWidth > 0; }
  get size() { return { w: this.video.videoWidth || 1280, h: this.video.videoHeight || 720 }; }

  static get supported() {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  /** @param {'front'|'rear'} facing */
  async open(facing = this.facing) {
    if (!CameraRig.supported) {
      const err = new Error('Este navegador no expone getUserMedia. Necesitás HTTPS (GitHub Pages lo da) o un contexto seguro.');
      this.lastError = err;
      throw err;
    }
    this.close();
    this.facing = facing === 'rear' ? 'rear' : 'front';

    const tryList = this.#constraintLadder(this.facing);
    let lastError = null;
    for (const c of tryList) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(c);
        this.#attach(stream);
        return this;
      } catch (err) {
        lastError = err;
        // Permiso denegado: no tiene sentido reintentar con otras constraints.
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) break;
      }
    }
    this.lastError = lastError;
    this.emit('error', lastError);
    throw lastError;
  }

  #constraintLadder(facing) {
    const facingHint = CONFIG.camera.facing[facing] || CONFIG.camera.facing.front;
    const mirror = facing === 'front' ? 'user' : 'environment';
    const base = { audio: false, video: { ...facingHint, ...CONFIG.camera.resolution } };
    return [
      base,
      { audio: false, video: { facingMode: { exact: mirror } } },
      { audio: false, video: { facingMode: mirror } },
      { audio: false, video: true },
    ];
  }

  #attach(stream) {
    this.stream = stream;
    this.track = stream.getVideoTracks()[0] || null;
    if (this.video.srcObject !== stream) this.video.srcObject = stream;
    this.video.setAttribute('playsinline', 'true');
    this.video.muted = true;
    this.video.autoplay = true;

    const s = this.track?.getSettings?.() || {};
    this.actualFacing = resolveFacing(s, this.facing);
    this.mirror = this.actualFacing === 'front';
    this.capabilities = this.track?.getCapabilities?.() || {};

    const play = async () => {
      try { await this.video.play(); } catch { /* iOS a veces necesita un gesto: lo reintenta la UI */ }
    };
    play();
    this.running = true;
    this.lastError = null;
    this.emit('open', { facing: this.actualFacing, size: this.size, torch: this.torchSupported });
  }

  close() {
    this.running = false;
    if (this.stream) for (const t of this.stream.getTracks()) { try { t.stop(); } catch { /* noop */ } }
    this.stream = null;
    this.track = null;
    if (this.video) this.video.srcObject = null;
  }

  /** Cambia frontal <-> trasera manteniendo el mismo elemento <video>. */
  async switch() { return this.open(this.facing === 'front' ? 'rear' : 'front'); }

  get torchSupported() { return !!(this.capabilities && (this.capabilities.torch || this.capabilities.flashMode)); }
  get zoomSupported() { return !!(this.capabilities && this.capabilities.zoom); }

  async setTorch(on) {
    if (!this.track || !this.torchSupported) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      this.torch = !!on;
      this.emit('torch', this.torch);
      return true;
    } catch { return false; }
  }

  /** @param {number} k 0 = mínimo (gran angular), 1 = máximo zoom óptico/digital. */
  async setZoom(k) {
    const z = this.capabilities.zoom;
    if (!this.track || !z) return false;
    const v = clamp(z.min + (z.max - z.min) * clamp(k, 0, 1), z.min, z.max);
    try { await this.track.applyConstraints({ advanced: [{ zoom: z.step ? Math.round(v / z.step) * z.step : v }] }); return true; } catch { return false; }
  }

  /** Timestamp monótono para `detectForVideo` (debe ser estrictamente creciente). */
  nextTs() {
    const t = Math.max(this.frameId + 1, Math.round(performance.now()));
    this.frameId = t;
    return t;
  }

  /** Pide un frame al video (algunos navegadores requieren requestVideoFrameCallback). */
  hasNewFrame() {
    if (typeof this.video.requestVideoFrameCallback === 'function') return this.video.videoFrameNumber !== this._lastFrame;
    return this.ready;
  }
}

/** Determina si la imagen mostrada debe espejarse. */
export function resolveFacing(settings, asked) {
  const fm = typeof settings?.facingMode === 'string' ? settings.facingMode : settings?.facingMode?.exact;
  if (fm === 'user') return 'front';
  if (fm === 'environment') return 'rear';
  if (settings?.facingMode && typeof settings.facingMode === 'object') return asked;
  return asked;
}

export default CameraRig;
