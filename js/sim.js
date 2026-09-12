/**
 * sim.js — cuerpo humano sintético (modo demo / sin cámara / tests).
 *
 * Genera los mismos datos que produciría MediaPipe: 33 landmarks de pose,
 * 2x21 de manos, 478 de cara y mundo en metros. Se usa para:
 *  - el modo DEMO del visor cuando no hay permisos de cámara o no hay red;
 *  - los tests de Node (pipeline completo sin navegador).
 */

import { POSE, FINGERS, HAND_CONNECTIONS } from './track/parts.js';
import { clamp, lerp, mulberry32 } from './util.js';

/** Esqueleto en metros, origen en la cadera, +Y hacia arriba (coordenadas de mundo MediaPipe-like). */
function skeleton(t) {
  const breathe = Math.sin(t * 1.6) * 0.008;
  const sway = Math.sin(t * 0.7) * 0.03;
  const y = (v) => v + breathe;

  const hipY = 0, shoulderY = y(0.52), headY = y(0.72);
  const shX = 0.19, hipX = 0.10;

  // Brazos: el ángulo del hombro y del codo se anima para hacer gestos.
  const armL = { shoulder: 0.55 + Math.sin(t * 1.1) * 0.45, elbow: -0.75 + Math.sin(t * 1.35 + 1) * 0.6 };
  const armR = { shoulder: 0.62 + Math.sin(t * 1.1 + 2.2) * 0.5, elbow: -0.8 + Math.sin(t * 1.5 + 2.6) * 0.6 };
  const upper = 0.29, fore = 0.26;

  const armChain = (sx, a) => {
    const shoulder = { x: sx, y: shoulderY, z: 0 };
    const elbow = { x: sx + Math.cos(a.shoulder) * upper * 0.35 * Math.sign(sx), y: shoulderY - Math.abs(Math.sin(a.shoulder)) * 0.06 - upper * 0.85, z: Math.sin(a.shoulder) * 0.1 };
    const wrist = {
      x: elbow.x + Math.cos(a.shoulder + a.elbow) * fore * 0.9 * (sx < 0 ? 1 : 1),
      y: elbow.y - Math.sin(a.elbow + 1.2) * fore * 0.6,
      z: elbow.z + Math.sin(a.elbow) * 0.12,
    };
    return { shoulder, elbow, wrist };
  };
  const L = armChain(-shX, armL);
  const R = armChain(shX, armR);

  const kneeSwing = Math.sin(t * 0.9) * 0.05;
  const P = {
    nose: { x: sway * 0.4, y: headY, z: 0.09 },
    lShoulder: L.shoulder, rShoulder: R.shoulder,
    lElbow: L.elbow, rElbow: R.elbow,
    lWrist: L.wrist, rWrist: R.wrist,
    lHip: { x: -hipX, y: hipY, z: 0 }, rHip: { x: hipX, y: hipY, z: 0 },
    lKnee: { x: -hipX - kneeSwing, y: -0.44, z: 0.02 }, rKnee: { x: hipX + kneeSwing, y: -0.44, z: 0.02 },
    lAnkle: { x: -hipX * 1.05, y: -0.86, z: -0.02 }, rAnkle: { x: hipX * 1.05, y: -0.86, z: -0.02 },
  };
  return { P, sway, headY, breathe };
}

function poseFromWorld(P, sway) {
  const H = 1.9; // metros visibles en el frame
  const toImg = (p) => ({ x: 0.5 + (p.x + sway) / H, y: 0.5 - p.y / H, z: -(p.z || 0) / H, visibility: 1 });
  const pose = new Array(33).fill(0).map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.05 }));
  const set = (i, p, v = 1) => { pose[i] = { ...toImg(p), visibility: v }; };
  set(POSE.NOSE, P.nose);
  set(POSE.L_EYE, { x: P.nose.x - 0.03, y: P.nose.y + 0.02, z: 0.06 });
  set(POSE.R_EYE, { x: P.nose.x + 0.03, y: P.nose.y + 0.02, z: 0.06 });
  set(POSE.L_EAR, { x: P.nose.x - 0.09, y: P.nose.y - 0.01, z: 0 });
  set(POSE.R_EAR, { x: P.nose.x + 0.09, y: P.nose.y - 0.01, z: 0 });
  set(POSE.L_SHOULDER, P.lShoulder); set(POSE.R_SHOULDER, P.rShoulder);
  set(POSE.L_ELBOW, P.lElbow); set(POSE.R_ELBOW, P.rElbow);
  set(POSE.L_WRIST, P.lWrist); set(POSE.R_WRIST, P.rWrist);
  set(POSE.L_INDEX, { x: P.lWrist.x - 0.03, y: P.lWrist.y - 0.06, z: P.lWrist.z });
  set(POSE.R_INDEX, { x: P.rWrist.x + 0.03, y: P.rWrist.y - 0.06, z: P.rWrist.z });
  set(POSE.L_PINKY, { x: P.lWrist.x + 0.03, y: P.lWrist.y - 0.05, z: P.lWrist.z });
  set(POSE.R_PINKY, { x: P.rWrist.x - 0.03, y: P.rWrist.y - 0.05, z: P.rWrist.z });
  set(POSE.L_THUMB, { x: P.lWrist.x - 0.05, y: P.lWrist.y - 0.02, z: P.lWrist.z });
  set(POSE.R_THUMB, { x: P.rWrist.x + 0.05, y: P.rWrist.y - 0.02, z: P.rWrist.z });
  set(POSE.L_HIP, P.lHip); set(POSE.R_HIP, P.rHip);
  set(POSE.L_KNEE, P.lKnee); set(POSE.R_KNEE, P.rKnee);
  set(POSE.L_ANKLE, P.lAnkle); set(POSE.R_ANKLE, P.rAnkle);
  set(POSE.L_HEEL, { x: P.lAnkle.x, y: P.lAnkle.y - 0.02, z: P.lAnkle.z - 0.04 });
  set(POSE.R_HEEL, { x: P.rAnkle.x, y: P.rAnkle.y - 0.02, z: P.rAnkle.z - 0.04 });
  set(POSE.L_FOOT, { x: P.lAnkle.x - 0.01, y: P.lAnkle.y - 0.03, z: P.lAnkle.z + 0.12 });
  set(POSE.R_FOOT, { x: P.rAnkle.x + 0.01, y: P.rAnkle.y - 0.03, z: P.rAnkle.z + 0.12 });
  const world = new Array(33).fill(0).map(() => ({ x: 0, y: 0, z: 0, visibility: 1 }));
  // world: el esqueleto en metros (origen en la cadera), como PoseLandmarker.worldLandmarks.
  const wmap = {
    0: P.nose, 11: P.lShoulder, 12: P.rShoulder, 13: P.lElbow, 14: P.rElbow, 15: P.lWrist, 16: P.rWrist,
    23: P.lHip, 24: P.rHip, 25: P.lKnee, 26: P.rKnee, 27: P.lAnkle, 28: P.rAnkle,
  };
  for (const [i, p] of Object.entries(wmap)) world[i] = { x: p.x, y: -p.y, z: -(p.z || 0), visibility: 1 };
  return { pose, world };
}

/**
 * Mano paramétrica: muñeca + orientación + curl por dedo -> 21 landmarks.
 * Las cadenas siguen el orden de HandLandmarker (0 muñeca, 1-4 pulgar, 5-8 índice, ...).
 */
export function makeHand({ center, heading = -0.6, scale = 0.09, curls = [0, 0, 0, 0, 0], pinch = 0 }) {
  const lm = new Array(21).fill(0).map(() => ({ x: center.x, y: center.y, z: 0, visibility: 1 }));
  const at = (base, dir, d, curl = 0) => ({
    x: base.x + Math.cos(dir) * d,
    y: base.y + Math.sin(dir) * d,
    z: base.z - curl * d * 0.18,
    visibility: 1,
  });

  const knuckles = [0.62, 0.9, 1.0, 0.94, 0.78];   // largo relativo de cada dedo
  const fan = [-0.62, -0.24, 0.02, 0.26, 0.5];      // abanico de los 4 dedos largos (+ pulgar)

  // nudillos a lo largo del arco de la palma
  const palmDir = heading;
  for (let f = 1; f < 5; f++) {
    const spread = fan[f] * 0.55;
    const base = at(center, palmDir, scale * 0.72 + Math.abs(spread) * scale * 0.1);
    const knuck = at(base, palmDir + spread, scale * 0.18);
    lm[5 + (f - 1) * 4] = knuck;
  }
  lm[1] = at(center, palmDir + fan[0] - 1.05, scale * 0.5); // metacarpiano del pulgar

  for (let f = 0; f < 5; f++) {
    const chain = FINGERS[f].chain;
    const c = clamp(curls[f], 0, 1);
    const n = chain.length - 1;                      // 3 falanges por dedo
    const base = f === 0 ? lm[1] : lm[chain[0]];
    let cur = base;
    let dir = f === 0 ? palmDir + fan[0] - 0.55 : palmDir + fan[f] * 0.55;
    const step = scale * knuckles[f] / n;
    for (let s = 1; s <= n; s++) {
      dir += c * 1.5;   // c=1 => puño cerrado (punta casi tocando el nudillo)
      cur = at(cur, dir, step * (1 - c * 0.18), c);
      lm[chain[s]] = cur;
    }
  }
  lm[0] = { ...center, z: center.z ?? 0, visibility: 1 };
  // Pinza: el pulgar viaja hacia la punta del índice (posición interpolada por falange).
  const pk = clamp(pinch, 0, 1);
  if (pk > 0) {
    for (let i = 2; i <= 4; i++) {
      const t = (i - 1) / 3;
      lm[i] = {
        x: lerp(lm[i].x, lm[8].x, pk * t),
        y: lerp(lm[i].y, lm[8].y, pk * t),
        z: lerp(lm[i].z ?? 0, lm[8].z ?? 0, pk * t),
        visibility: 1,
      };
    }
  }
  return lm;
}


/** Cara: 478 puntos aproximados sobre un óvalo (suficiente para máscara y HUD). */
function makeFace(center, r, t) {
  const out = new Array(478).fill(0).map(() => ({ x: center.x, y: center.y, z: 0, visibility: 1 }));
  const open = 0.5 + 0.5 * Math.sin(t * 2.3);
  for (let i = 0; i < 478; i++) {
    const a = (i / 478) * Math.PI * 2 * 3 + (i % 17) * 0.16;
    const rr = r * (0.72 + 0.28 * Math.abs(Math.sin(a * 0.5)));
    out[i] = { x: center.x + Math.cos(a) * rr * 0.75, y: center.y + Math.sin(a) * rr * (i % 7 === 0 ? 1.05 : 0.9), z: -0.02 + 0.01 * Math.sin(i), visibility: 1 };
  }
  out[13].y += open * r * 0.18;
  out[14].y -= open * r * 0.1;
  return out;
}

export class SimBody {
  constructor({ seed = 7, hands = true, face = true, pose = true } = {}) {
    this.rnd = mulberry32(seed);
    this.opts = { hands, face, pose };
    this.t = 0;
  }

  /** Avanza la simulación y devuelve un "frame" con la forma de la salida de MediaPipe. */
  frame(dt) {
    this.t += dt;
    const t = this.t;
    const { P, sway } = skeleton(t);
    const { pose, world } = poseFromWorld(P, sway);
    const H = 1.9;
    const img = (p) => ({ x: 0.5 + (p.x + sway) / H, y: 0.5 - p.y / H, z: -(p.z || 0) / H });

    const gestOf = (base) => {
      const ph = ((t * 0.5 + base) % 1 + 1) % 1;      // ciclo de 4 poses
      const k = Math.floor(ph * 4);
      const c = clamp((Math.sin(ph * Math.PI * 8) + 1) / 2, 0, 1);
      const poses = [
        { curls: [0, 0, 0, 0, 0], pinch: 0 },          // palma abierta
        { curls: [0.1, 0.15, 1, 1, 1], pinch: 0.92 }, // pinza (agarra un núcleo)
        { curls: [1, 1, 1, 1, 1], pinch: 0.2 },        // puño
        { curls: [0.2, 0, 1, 1, 1], pinch: 0.1 },      // señalar
      ];
      return { ...poses[k], c };
    };
    const scale = 0.052;
    const gR = gestOf(0), gL = gestOf(0.5);
    const hands = this.opts.hands
      ? [
        { handedness: 'Right', score: 0.97, landmarks: makeHand({ center: img(P.rWrist), heading: -1.1 + Math.sin(t) * 0.3, scale, curls: gR.curls, pinch: gR.pinch }) },
        { handedness: 'Left', score: 0.97, landmarks: makeHand({ center: img(P.lWrist), heading: -2.1 + Math.sin(t + 1.4) * 0.3, scale, curls: gL.curls, pinch: gL.pinch }) },
      ]
      : [];

    const head = img(P.nose);
    const face = this.opts.face ? makeFace(head, 0.075, t) : null;
    return { pose, world, hands, face, ts: t * 1000, sim: true, connections: { HAND_CONNECTIONS, FINGERS } };
  }
}

export default SimBody;
