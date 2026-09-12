/**
 * compositor.js — pantalla del visor: video en vivo + "robotización" limitada a la
 * máscara de partes humanas (R = tubos del cuerpo, G = silueta, B = calor de zócalos).
 *
 * Se renderiza como un quad a pantalla completa en una escena ortho separada que va
 * ANTES de la escena 3D (renderer.autoClear = false). En modo XR esta capa se apaga:
 * ahí la cámara real la entrega el propio sistema de RA.
 */

export const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;

uniform sampler2D tVideo;
uniform sampler2D tMask;
uniform vec2  uCrop;        // recorte "cover" del video
uniform vec2  uRes;         // resolución del lienzo (px)
uniform vec3  uAccent;      // color del servo
uniform vec3  uWarn;        // color de objetivo activo
uniform float uTime;
uniform float uEnergy;      // 0..1 combo / carga
uniform float uGlitch;      // 0..1 fallos de calibración
uniform float uStrength;    // 0..1 cuánto se altera la piel
uniform float uMirror;      // 1 = cámara frontal (imagen espejada)
uniform float uHasSeg;      // 1 = hay silueta del segmentador
uniform float uShowVideo;   // 0 = sólo HUD (si el video no arrancó)
uniform float uScan;        // 0..1 progreso del escáner

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

vec2 videoUv(vec2 uv) {
  vec2 p = (uv - 0.5) * uCrop + 0.5;
  if (uMirror > 0.5) p.x = 1.0 - p.x;
  return clamp(p, vec2(0.0), vec2(1.0));
}

vec3 frameAt(vec2 uv) { return texture2D(tVideo, videoUv(uv)).rgb; }

void main() {
  vec2 uv = vUv;
  vec3 raw = frameAt(uv);
  vec3 col = mix(raw, vec3(0.015, 0.025, 0.035) * (0.7 + 0.3 * (1.0 - length(uv - 0.5))), 1.0 - uShowVideo);

  // La máscara se dibuja en espacio de imagen CRUDO, y la pantalla está recortada
  // (cover) y a lo mejor espejada: por eso se muestrea en la MISMA coordenada que el
  // video. Si se muestreara en uv a secas, el resaltado se correría de la piel.
  vec2 mUv = videoUv(uv);
  vec4 msk = texture2D(tMask, mUv);
  float tubes = smoothstep(0.08, 0.72, msk.r);
  float seg   = uHasSeg > 0.5 ? smoothstep(0.05, 0.5, msk.g) : 1.0;
  float heat  = clamp(msk.b * 1.35, 0.0, 1.0);

  // Regla del juego: sólo se altera lo que es parte humana detectada.
  float m = clamp(tubes * mix(1.0, 0.35 + 0.75 * seg, uHasSeg) * uStrength, 0.0, 1.0);
  m = max(m, heat * 0.85 * uStrength);

  // Borde de la región humana (detección tipo Sobel sobre la máscara).
  vec2 tx = (1.6 / uRes) * uCrop;
  float e0 = texture2D(tMask, mUv + vec2(tx.x, 0.0)).r;
  float e1 = texture2D(tMask, mUv - vec2(tx.x, 0.0)).r;
  float e2 = texture2D(tMask, mUv + vec2(0.0, tx.y)).r;
  float e3 = texture2D(tMask, mUv - vec2(0.0, tx.y)).r;
  float edge = clamp(abs(e0 - e1) + abs(e2 - e3), 0.0, 1.0);
  edge = smoothstep(0.12, 0.9, edge) * (uStrength * 0.9 + 0.1);

  // ---- ensamblado del "bodykit" robótico
  float band = 0.5 + 0.5 * sin((uv.y * uRes.y) * 0.045 - uTime * 2.2 + luma(raw) * 3.0);
  float grid = step(0.86, max(fract(uv.x * 28.0), fract(uv.y * 20.0)));
  float glitchLine = step(0.72, hash(vec2(floor(uv.y * 64.0), floor(uTime * 14.0)))) * uGlitch;

  vec2 ab = vec2(uGlitch * 0.006 + 0.0015, 0.0) * (1.0 + uEnergy);
  vec3 shifted = vec3(
    frameAt(uv + vec2(ab.x + glitchLine * 0.01, 0.0)).r,
    raw.g,
    frameAt(uv - vec2(ab.x, glitchLine * 0.004)).b
  );

  float lum = luma(shifted);
  vec3 metal = mix(vec3(lum), shifted, 0.35);
  metal = pow(metal, vec3(1.15, 1.05, 0.95));
  metal = metal * 0.75 + band * 0.16 + grid * 0.10;
  // Cuantización "chapa": pocas bandas de brillo, como un render de CAD.
  metal = floor(metal * 7.0 + 0.5) / 7.0;
  metal *= mix(vec3(1.0), uAccent * 1.35, 0.55 + 0.35 * uEnergy);
  metal += uAccent * pow(max(lum - 0.62, 0.0), 1.6) * 2.2;
  metal += uWarn * heat * (0.35 + 0.5 * sin(uTime * 7.0));
  // Ruido de servo y líneas de escaneo del visor.
  metal += (hash(uv * uRes + uTime) - 0.5) * 0.06;

  vec3 altered = mix(col, metal, m);
  altered += uAccent * edge * (0.5 + 0.6 * uEnergy);
  altered = mix(altered, altered.bgr, uGlitch * 0.18 * m);

  // Línea de escaneo del escáner corporal (cámara trasera).
  float scanLine = smoothstep(0.006, 0.0, abs(uv.y - (1.0 - uScan))) * step(0.001, uScan) * (0.5 + 0.5 * uHasSeg);
  altered += mix(uWarn, uAccent, 0.4) * scanLine * 0.85;

  // Atenuación del fondo: sólo fuera del cuerpo no tocamos el color (requisito), así
  // que únicamente oscurecemos ligeramente dentro de la región alterada para leer el HUD.
  col = mix(col, col * 0.72, m * 0.35);
  col = mix(col, altered, m * 0.92 + edge * 0.35);

  // Grano y viñeta del visor (estética de casco, no altera el cuerpo).
  float vig = smoothstep(1.35, 0.25, length((uv - 0.5) * vec2(uRes.x / uRes.y, 1.0)));
  col *= 0.55 + 0.45 * vig;
  col += (hash(uv * uRes * 0.5 + floor(uTime * 30.0)) - 0.5) * 0.035;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

import { CONFIG } from '../config.js';

/**
 * Envuelve el material, las texturas (video + máscara) y el render de fondo.
 */
export class Compositor {
  constructor(THREE, { maskCanvas, videoEl }) {
    this.THREE = THREE;
    this.texVideo = new THREE.VideoTexture(videoEl);
    this.texVideo.colorSpace = THREE.SRGBColorSpace;
    this.texVideo.minFilter = THREE.LinearFilter;
    this.texVideo.magFilter = THREE.LinearFilter;
    this.texVideo.generateMipmaps = false;

    this.texMask = new THREE.CanvasTexture(maskCanvas);
    this.texMask.minFilter = THREE.LinearFilter;
    this.texMask.magFilter = THREE.LinearFilter;
    this.texMask.generateMipmaps = false;
    this.texMask.colorSpace = THREE.NoColorSpace;

    this.uniforms = {
      tVideo: { value: this.texVideo },
      tMask: { value: this.texMask },
      uCrop: { value: new THREE.Vector2(1, 1) },
      uRes: { value: new THREE.Vector2(1, 1) },
      uAccent: { value: new THREE.Color(CONFIG.robotize.colors.accent) },
      uWarn: { value: new THREE.Color(CONFIG.robotize.colors.warn) },
      uTime: { value: 0 },
      uEnergy: { value: 0 },
      uGlitch: { value: 0 },
      uStrength: { value: 1 },
      uMirror: { value: 1 },
      uHasSeg: { value: 0 },
      uShowVideo: { value: 1 },
      uScan: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
    });
    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.quad = new THREE.Mesh(this.geometry, this.material);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /** @param {{energy, glitch, strength, mirror, hasSeg, showVideo, scan, crop, res, time}} p */
  update(p = {}) {
    const u = this.uniforms;
    if (p.time != null) u.uTime.value = p.time;
    if (p.energy != null) u.uEnergy.value = p.energy;
    if (p.glitch != null) u.uGlitch.value = p.glitch;
    if (p.strength != null) u.uStrength.value = p.strength;
    if (p.mirror != null) u.uMirror.value = p.mirror ? 1 : 0;
    if (p.hasSeg != null) u.uHasSeg.value = p.hasSeg ? 1 : 0;
    if (p.showVideo != null) u.uShowVideo.value = p.showVideo ? 1 : 0;
    if (p.scan != null) u.uScan.value = p.scan;
    if (p.accent != null) u.uAccent.value.set(p.accent);
    if (p.crop) u.uCrop.value.set(p.crop[0], p.crop[1]);
    if (p.res) u.uRes.value.set(p.res[0], p.res[1]);
  }

  markTexturesDirty() {
    this.texVideo.needsUpdate = true;
    this.texMask.needsUpdate = true;
  }

  /**
   * Dibuja el fondo. NO toca el render target: quien llama decide si va al lienzo
   * (modo visor) o a una textura (pantalla flotante del modo gafas).
   */
  render(renderer) {
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.texVideo.dispose();
    this.texMask.dispose();
  }
}

export default Compositor;
