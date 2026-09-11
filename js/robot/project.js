/**
 * project.js — proyección entre el espacio de la IMAGEN (lo que entregan los
 * landmarks, x/y en 0..1) y el espacio 3D del visor.
 *
 * El video se muestra con `object-fit: cover` sobre el lienzo del juego, así que hay
 * que replicar ese recorte en 3D para que el cuerpo robótico quede encima del cuerpo
 * real. Todo el modo visor (rig, núcleos, zócalos) usa estas funciones; el modo XR usa
 * metros reales y no necesita proyección de video.
 */

import { CONFIG } from '../config.js';

const DEG = Math.PI / 180;

/** Factores de recorte "cover" del video (w,h del video) al lienzo (W,H). */
export function coverFactors(vw, vh, W, H) {
  const vAspect = (vw || 16) / (vh || 9);
  const sAspect = (W || 16) / (H || 9);
  const k = vAspect / sAspect;
  return {
    // xF/yF: cuánto ocupa el video en el lienzo (1 = lleno, <1 = recortado)
    xF: Math.min(1, k),
    yF: Math.min(1, 1 / k),
    vAspect,
    sAspect,
  };
}

export class VisorProjector {
  /**
   * @param {number} fov degrees (debe coincidir con la cámara ortho/persp del visor)
   */
  constructor({ fov = CONFIG.visor.fov, depthPlane = CONFIG.visor.depthPlane, zScale = CONFIG.visor.zScale } = {}) {
    this.fov = fov;
    this.depthPlane = depthPlane;
    this.zScale = zScale;
    this.setVideoSize(1280, 720);
    this.setScreenSize(1280, 720);
  }

  setVideoSize(w, h) { this.vw = w; this.vh = h; this.#recalc(); }
  setScreenSize(w, h) { this.W = w; this.H = h; this.#recalc(); }

  #recalc() {
    const { xF, yF } = coverFactors(this.vw, this.vh, this.W, this.H);
    this.xF = xF; this.yF = yF;
    this.aspect = this.W / Math.max(1, this.H);
    this.halfH = Math.tan((this.fov * DEG) / 2) * this.depthPlane;
    this.halfW = this.halfH * this.aspect;
    /** z de MediaPipe es "relativa" (1 ≈ profundidad de la palma): lo llevamos a metros del plano. */
    this.zUnit = this.halfH * 0.9 * this.zScale;
  }

  /** Punto en espacio de imagen -> mundo 3D (para colocar mallas del rig/núcleos). */
  toWorld(p, out = { x: 0, y: 0, z: 0 }, mirror = false) {
    const nx = ((p.x ?? 0.5) - 0.5) * 2 * this.xF * (mirror ? -1 : 1);
    const ny = -(((p.y ?? 0.5) - 0.5) * 2 * this.yF);
    const depth = this.depthPlane + (p.z ?? 0) * this.zUnit;
    out.x = nx * this.halfW * (depth / this.depthPlane);
    out.y = ny * this.halfH * (depth / this.depthPlane);
    out.z = this.depthPlane - depth;
    return out;
  }

  /** Mundo 3D -> espacio de imagen (para saber si un núcleo está bajo la mano). */
  toImage(vec, out = { x: 0, y: 0, z: 0 }, mirror = false) {
    const depth = this.depthPlane - (vec.z ?? 0);
    const f = depth / this.depthPlane || 1;
    const nx = (vec.x / (this.halfW * f));
    const ny = -(vec.y / (this.halfH * f));
    out.x = 0.5 + (mirror ? -nx : nx) / (2 * this.xF);
    out.y = 0.5 + ny / (2 * this.yF);
    out.z = (this.depthPlane - depth) / Math.max(1e-4, this.zUnit);
    return out;
  }

  /** Tamaño en píxeles de una unidad de mundo en el plano de profundidad dado. */
  unitToScreen(depth = this.depthPlane) {
    return (this.halfH * 2 * (this.H || 1)) / (depth / this.depthPlane);
  }

  /** Radio en unidades de imagen (para el HUD y los radios de agarre). */
  radiusInImage(worldRadius, depth = this.depthPlane) {
    const f = depth / this.depthPlane || 1;
    return { x: worldRadius / (2 * this.halfW * f), y: worldRadius / (2 * this.halfH * f) };
  }
}

export default VisorProjector;
