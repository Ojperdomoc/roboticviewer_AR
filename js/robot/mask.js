/**
 * mask.js — máscara de "sólo partes humanas".
 *
 * Dibuja en un canvas chico los tubos del cuerpo (brazos, piernas, torso, cabeza,
 * manos, dedos) a partir de los landmarks y los multiplica por la silueta que entrega
 * el segmentador. Esa máscara es la que usa el sombreador del visor: fuera de ella el
 * video NO se toca, dentro se robotiza. Es la garantía técnica de la regla del juego:
 * «solamente se alteran partes de cuerpos humanos».
 *
 * Empaquetado por canal (para que el shader pueda mezclar con control fino):
 *   R = tubos de partes detectadas (geometría del cuerpo)
 *   G = silueta del segmentador (0 si no hay)
 *   B = calor de zócalos / objetivos activos
 */

import { CONFIG } from '../config.js';
import { HAND_CONNECTIONS } from '../track/parts.js';
import { clamp } from '../util.js';

const { maskWidth, dilation, tubeScale } = CONFIG.robotize;

export class MaskBuilder {
  constructor(width = maskWidth) {
    this.w = Math.max(64, Math.round(width));
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = this.w;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    this.aspect = 1;
    // Scratch: los tubos se dibujan nítidos acá y se copian desenfocados a la máscara,
    // para que el borde de la alteración sea suave (no un recorte duro sobre la piel).
    this.partsCanvas = document.createElement('canvas');
    this.partsCanvas.width = this.w;
    this.partsCanvas.height = this.w;
    this.partsCtx = this.partsCanvas.getContext('2d');
    this.segData = null;
    this.lastCoverage = 0;
  }

  setSize(w, h) {
    this.aspect = (w || 1) / (h || 1);
    if (this.canvas.height !== Math.round(this.w / this.aspect)) {
      this.canvas.height = Math.round(this.w / this.aspect);
      this.partsCanvas.height = this.canvas.height;
    }
  }

  /**
   * @param {{parts:Object, bones:Array, hands:Object, scale:number}} body
   * @param {{seg?:{w:number,h:number,data:Float32Array}, facing?:'front'|'rear', mirror?:boolean, sockets?:Array, energy?:number}} ctx
   *   `mirror` se acepta por compatibilidad con el HUD, pero NO afecta la geometría: la
   *   máscara vive en espacio de imagen crudo (ver `px`).
   */
  update(body, ctx = {}) {
    const g = this.partsCtx;
    const W = this.w, H = this.canvas.height;
    if (this.partsCanvas.height !== H) { this.partsCanvas.height = H; }
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, W, H);
    g.filter = 'none';
    g.lineCap = 'round';
    g.lineJoin = 'round';

    if (!body?.humanVisible) {
      g.restore();
      this.#compose({ hasBody: false, seg: null });
      return;
    }
    ctx.hasBody = true;

    // IMPORTANTE: la máscara se dibuja SIEMPRE en espacio de imagen CRUDO (sin espejar).
    // El espejado del modo frontal lo hace el sombreador al muestrear tVideo, y la máscara
    // se muestrea en la misma coordenada; si espejáramos acá, la máscara se desalinearían
    // con el video (efecto "guante izquierdo en la mano derecha").
    const px = (p) => ({ x: p.x * W, y: p.y * H });
    const unit = Math.max(2, (body.scale || 0.2) * H);

    // --- R: tubos del esqueleto + palmas/dedos
    g.strokeStyle = 'rgba(255,0,0,1)';
    g.fillStyle = 'rgba(255,0,0,1)';
    for (const b of body.bones || []) {
      const s = tubeScaleFor(b.part);
      g.lineWidth = Math.max(3, b.length * s * 2 + dilation);
      const a = px(b.a), c = px(b.b);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(c.x, c.y); g.stroke();
    }
    for (const part of Object.values(body.parts || {})) {
      if (!part.visible || !part.center) continue;
      const c = px(part.center);
      const r = part.radius * W * (part.id === 'cabeza' ? 1.35 : part.id === 'torso' ? 1.6 : 1.15) + dilation;
      g.beginPath(); g.arc(c.x, c.y, Math.max(4, r), 0, Math.PI * 2); g.fill();
    }
    for (const side of ['Left', 'Right']) {
      const h = body.hands?.[side];
      if (!h?.landmarks) continue;
      g.lineWidth = Math.max(3, unit * tubeScale.finger + dilation);
      for (const [a, b] of HAND_CONNECTIONS) {
        const p = px(h.landmarks[a]), q = px(h.landmarks[b]);
        g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
      }
    }
    // Cara: relleno óvalo (para robotizar la piel de la cara, no solo el contorno).
    const face = body.joints?.face;
    if (face?.length) {
      g.lineWidth = Math.max(3, unit * tubeScale.head * 0.5 + dilation);
      g.beginPath();
      for (let i = 0; i < face.length; i += 3) { const p = px(face[i]); i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y); }
      g.closePath();
      g.stroke();
      g.fill();
    }

    // Calor de zócalos/objetivos (canal B) también en el scratch.
    if (ctx.sockets?.length) {
      g.globalCompositeOperation = 'lighter';
      for (const sk of ctx.sockets) {
        if (!sk.visible) continue;
        const p2 = px(sk);
        const r2 = Math.max(6, unit * 0.85);
        const grd = g.createRadialGradient(p2.x, p2.y, 0, p2.x, p2.y, r2);
        grd.addColorStop(0, 'rgba(0,0,255,0.95)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        g.beginPath(); g.arc(p2.x, p2.y, r2, 0, Math.PI * 2); g.fill();
      }
      g.globalCompositeOperation = 'source-over';
    }

    // Tubos + palmas + dedos + cara + calor de zócalos quedaron en el scratch nítido.
    g.restore();
    this.#compose(ctx);
  }

  /**
   * Composición final de la máscara:
   *   R = tubos de partes humanas (desenfocados => borde suave sobre la piel)
   *   G = silueta del segmentador (si está disponible)
   *   B = calor de zócalos/objetivos
   */
  #compose(ctx = {}) {
    const g = this.ctx;
    const W = this.w, H = this.canvas.height;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.filter = 'none';
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);

    if (ctx.hasBody) {
      try {
        g.filter = `blur(${Math.max(2, Math.round(dilation * 0.5))}px)`;
      } catch { /* navegador sin ctx.filter: la máscara queda dura pero válida */ }
      g.drawImage(this.partsCanvas, 0, 0, W, H);
      g.filter = 'none';
      if (ctx.seg?.data) this.#drawSegmentation(ctx.seg, W, H);
    }
    g.restore();
    this.lastCoverage = clamp(this.#coverage(), 0, 1);
  }

  #drawSegmentation(seg, W, H) {
    const g = this.ctx;
    if (!this.segCanvas) {
      this.segCanvas = document.createElement('canvas');
      this.segCtx = this.segCanvas.getContext('2d');
    }
    if (this.segCanvas.width !== seg.w || this.segCanvas.height !== seg.h) {
      this.segCanvas.width = seg.w; this.segCanvas.height = seg.h;
    }
    const img = this.segCtx.createImageData(seg.w, seg.h);
    const d = img.data;
    for (let i = 0, n = seg.w * seg.h; i < n; i++) {
      let a = seg.data[i];
      if (a > 1) a /= 255;
      const v = clamp((a - 0.35) / 0.4, 0, 1) * 255;
      d[i * 4] = 0; d[i * 4 + 1] = v; d[i * 4 + 2] = 0; d[i * 4 + 3] = 255;
    }
    this.segCtx.putImageData(img, 0, 0);
    g.globalCompositeOperation = 'lighter';
    g.drawImage(this.segCanvas, 0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
  }

  #coverage() {
    // Muestreo barato (1 de cada 64 px) para saber cuánta pantalla está robotizada.
    if (!this._read) {
      this._read = document.createElement('canvas'); this._read.width = 32; this._read.height = 32; this._rctx = this._read.getContext('2d'); }
    this._rctx.drawImage(this.canvas, 0, 0, 32, 32);
    const d = this._rctx.getImageData(0, 0, 32, 32).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += Math.min(1, d[i] / 255);
    return s / (d.length / 4);
  }

  /** Cobertura 0..1 de la última máscara (para el HUD: "robotización al 42 %"). */
  get coverage() { return this.lastCoverage; }
}

function tubeScaleFor(part) {
  if (!part) return tubeScale.limb;
  if (part.startsWith('mano')) return tubeScale.hand;
  if (part.startsWith('brazo')) return tubeScale.limb;
  if (part.startsWith('pierna')) return tubeScale.leg;
  if (part === 'cabeza') return tubeScale.head;
  if (part === 'torso') return tubeScale.torso;
  return tubeScale.limb;
}

export default MaskBuilder;
