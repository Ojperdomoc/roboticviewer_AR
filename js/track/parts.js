/**
 * partes.js — de landmarks de MediaPipe a "partes del cuerpo humano".
 *
 * Todo lo de aquí abajo es FUNCIÓN PURA: recibe datos, devuelve datos. Eso permite
 * testearlo en Node (ver tests/parts.test.mjs) y reutilizarlo en los tres modos
 * (visor 2D, RA inmersiva, modo gafas/Cardboard).
 *
 * Convenciones:
 *  - Las posiciones están en el ESPACIO DE LA IMAGEN [0..1] (x derecha, y abajo),
 *    SIN espejo. El renderizador aplica el espejo si la cámara es frontal.
 *  - La nomenclatura es ANATÓMICA: `*_der` es la mano derecha de la persona,
 *    venga o no en espejo (MediaPipe entrega handedness sobre el frame original).
 */

import { clamp } from '../util.js';

/** Índices del esqueleto de PoseLandmarker (33 landmarks). */
export const POSE = {
  NOSE: 0, L_EYE: 2, R_EYE: 5, L_EAR: 7, R_EAR: 8,
  L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16, L_PINKY: 17, R_PINKY: 18, L_INDEX: 19, R_INDEX: 20,
  L_THUMB: 21, R_THUMB: 22, L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28, L_HEEL: 29, R_HEEL: 30, L_FOOT: 31, R_FOOT: 32,
};

/** Huesos relevantes para dibujar/robotizar el cuerpo. */
export const BONES = [
  ['L_SHOULDER', 'R_SHOULDER', 'torso'],
  ['L_SHOULDER', 'L_ELBOW', 'brazo_izq'],
  ['L_ELBOW', 'L_WRIST', 'brazo_izq'],
  ['R_SHOULDER', 'R_ELBOW', 'brazo_der'],
  ['R_ELBOW', 'R_WRIST', 'brazo_der'],
  ['L_SHOULDER', 'L_HIP', 'torso'],
  ['R_SHOULDER', 'R_HIP', 'torso'],
  ['L_HIP', 'R_HIP', 'torso'],
  ['L_HIP', 'L_KNEE', 'pierna_izq'],
  ['L_KNEE', 'L_ANKLE', 'pierna_izq'],
  ['L_ANKLE', 'L_FOOT', 'pierna_izq'],
  ['R_HIP', 'R_KNEE', 'pierna_der'],
  ['R_KNEE', 'R_ANKLE', 'pierna_der'],
  ['R_ANKLE', 'R_FOOT', 'pierna_der'],
  ['NOSE', 'L_EAR', 'cabeza'],
  ['NOSE', 'R_EAR', 'cabeza'],
  ['L_SHOULDER', 'NOSE', 'cuello'],
  ['R_SHOULDER', 'NOSE', 'cuello'],
];

/** Cadenas de dedos por mano (HandLandmarker, 21 landmarks). */
export const FINGERS = [
  { id: 'pulgar', chain: [1, 2, 3, 4] },
  { id: 'indice', chain: [5, 6, 7, 8] },
  { id: 'medio', chain: [9, 10, 11, 12] },
  { id: 'anular', chain: [13, 14, 15, 16] },
  { id: 'menique', chain: [17, 18, 19, 20] },
];

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const vis = (p) => (p?.visibility ?? 1);
const ok = (p, t = 0.5) => !!p && vis(p) >= t;

const avg = (pts) => {
  const a = pts.filter(Boolean);
  if (!a.length) return null;
  let x = 0, y = 0, z = 0;
  for (const p of a) { x += p.x; y += p.y; z += p.z || 0; }
  return { x: x / a.length, y: y / a.length, z: z / a.length, visibility: Math.min(...a.map(vis)) };
};

const len = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0);

/**
 * Construye el estado del cuerpo a partir de un frame de detección.
 * @param {{pose?:Array,world?:Array,hands?:Array,face?:Array}} frame
 * @param {{mirror?:boolean,visThreshold?:number}} [opts]
 */
export function buildBody(frame, opts = {}) {
  const t = opts.visThreshold ?? 0.5;
  const pose = frame?.pose?.length ? frame.pose : null;
  const g = (i) => (pose ? pose[i] : null);
  const G = (k) => g(POSE[k]);

  const shoulderW = len(G('L_SHOULDER'), G('R_SHOULDER'));
  const torsoLen = len(avg([G('L_SHOULDER'), G('R_SHOULDER')]), avg([G('L_HIP'), G('R_HIP')]));
  const scale = Math.max(0.03, shoulderW || torsoLen || 0.25);

  const hands = { Left: null, Right: null };
  for (const h of frame?.hands || []) {
    if (!h || !h.landmarks?.length) continue;
    const side = h.handedness === 'Right' ? 'Right' : h.handedness === 'Left' ? 'Left' : h.screenSide === 'left' ? 'Left' : 'Right';
    if (!hands[side]) hands[side] = h;
  }

  const head = avg([G('NOSE'), G('L_EAR'), G('R_EAR'), ...(frame.face?.length ? [frame.face[1], frame.face[152]] : [])]);
  const shoulders = avg([G('L_SHOULDER'), G('R_SHOULDER')]);
  const hips = avg([G('L_HIP'), G('R_HIP')]);

  const parts = {
    cabeza: {
      id: 'cabeza', label: 'Cráneo / visor',
      center: head || shoulders,
      radius: scale * 0.55,
      visible: ok(G('NOSE'), t) || !!frame.face?.length,
      conf: Math.max(G('NOSE') ? vis(G('NOSE')) : 0, frame.face?.length ? 0.9 : 0),
    },
    torso: {
      id: 'torso', label: 'Torso',
      center: avg([shoulders, hips]) || shoulders,
      radius: Math.max(scale * 0.75, torsoLen * 0.55 || 0),
      visible: ok(G('L_SHOULDER'), t) && ok(G('R_SHOULDER'), t),
      conf: Math.min(G('L_SHOULDER') ? vis(G('L_SHOULDER')) : 0, G('R_SHOULDER') ? vis(G('R_SHOULDER')) : 0),
    },
    brazo_izq: limb('brazo_izq', 'Brazo izq.', G('L_SHOULDER'), G('L_ELBOW'), G('L_WRIST'), t),
    brazo_der: limb('brazo_der', 'Brazo der.', G('R_SHOULDER'), G('R_ELBOW'), G('R_WRIST'), t),
    pierna_izq: limb('pierna_izq', 'Pierna izq.', G('L_HIP'), G('L_KNEE'), G('L_ANKLE'), t),
    pierna_der: limb('pierna_der', 'Pierna der.', G('R_HIP'), G('R_KNEE'), G('R_ANKLE'), t),
    mano_izq: handPart('mano_izq', 'Mano izq.', hands.Left),
    mano_der: handPart('mano_der', 'Mano der.', hands.Right),
  };

  // Joints en espacio de imagen para el rig robótico + máscara corporal.
  const joints = {};
  if (pose) for (const [k, i] of Object.entries(POSE)) joints[k.toLowerCase()] = pose[i];
  if (frame.face?.length) joints.face = frame.face;
  if (hands.Left) joints.hand_left = hands.Left.landmarks;
  if (hands.Right) joints.hand_right = hands.Right.landmarks;

  const bones = [];
  for (const [a, b, part] of BONES) {
    const pa = joints[a.toLowerCase()], pb = joints[b.toLowerCase()];
    if (pa && pb && (ok(pa, t) || ok(pb, t))) bones.push({ a: pa, b: pb, part, length: len(pa, pb) });
  }
  for (const side of ['Left', 'Right']) {
    const h = hands[side];
    if (!h) continue;
    for (const [a, b] of HAND_CONNECTIONS) bones.push({ a: h.landmarks[a], b: h.landmarks[b], part: side === 'Left' ? 'mano_izq' : 'mano_der', hand: side, length: len(h.landmarks[a], h.landmarks[b]) });
  }

  const humanVisible = Object.values(parts).some((p) => p.visible);
  const bbox = humanVisible ? bodyBounds(parts) : null;
  return { parts, joints, bones, hands, scale, shoulderW, torsoLen, humanVisible, bbox, ts: frame?.ts ?? 0 };
}

function limb(id, label, sh, el, wr, t) {
  const center = avg([sh, el, wr]);
  const a = len(sh, el), b = len(el, wr);
  const r = Math.max(0.02, (a || 0.25) * 0.32);
  return {
    id, label, joints: { sh, el, wr }, center,
    radius: r,
    visible: (ok(sh, t) && ok(el, t)) || (ok(el, t) && ok(wr, t)),
    conf: Math.max(sh ? vis(sh) : 0, wr ? vis(wr) : 0),
    a, b,
  };
}

function handPart(id, label, h) {
  if (!h?.landmarks?.length) return { id, label, center: null, radius: 0.03, visible: false, conf: 0, hand: null };
  const lm = h.landmarks;
  return {
    id, label,
    hand: h.landmarks,
    handedness: h.handedness ?? null,
    center: avg([lm[0], lm[5], lm[9], lm[13], lm[17]]),
    radius: Math.max(0.02, len(lm[0], lm[9]) * 1.15),
    visible: true,
    conf: h.score ?? 0.9,
  };
}

function bodyBounds(parts) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0, n = 0;
  for (const p of Object.values(parts)) {
    if (!p.visible || !p.center) continue;
    const r = p.radius * 1.3;
    x0 = Math.min(x0, p.center.x - r); y0 = Math.min(y0, p.center.y - r);
    x1 = Math.max(x1, p.center.x + r); y1 = Math.max(y1, p.center.y + r);
    n++;
  }
  if (!n) return null;
  return { x0, y0, x1, y1, w: Math.max(0.001, x1 - x0), h: Math.max(0.001, y1 - y0), parts: n };
}

/**
 * Estado de una mano: curl de cada dedo, tamaño de palma, punto de pinza.
 * `curl` va de 0 (extendido) a 1 (cerrado), con umbrales estables.
 */
export function handState(lm) {
  if (!lm || lm.length < 21) return null;
  const wrist = lm[0], palmBase = lm[9];
  const palm = Math.max(1e-4, len(wrist, palmBase));
  const fingers = FINGERS.map(({ id, chain }) => {
    const [mcp, pip, dip, tip] = chain.map((i) => lm[i]);
    // Envergadura de la cadena (suma de falanges): no cambia al plegar el dedo.
    const span = Math.max(1e-4, len(mcp, pip) + len(pip, dip) + len(dip, tip));
    // curl = cuánto se acercó la punta a la base del dedo (invariante a escala y rotación).
    const curl = clamp01((1 - len(tip, mcp) / span) / 0.62);
    const spread = len(mcp, palmBase) / palm;
    return {
      id, curl, span,
      folded: len(tip, palmBase) / palm,
      extended: curl < 0.42,
      spread, tip, pip, mcp,
      angle: angleAt(mcp, pip, tip),
    };
  });
  const center = avg([lm[0], lm[5], lm[9], lm[13], lm[17]]);
  const pinch = len(lm[4], lm[8]) / palm;
  return {
    fingers, center, palm, pinch,
    indexTip: lm[8], thumbTip: lm[4], middleTip: lm[12], ringTip: lm[16], pinkyTip: lm[20],
    pinchPoint: avg([lm[4], lm[8]]),
    // Vector de la mano en imagen (muñeca -> nudillo medio): define su orientación.
    axis: Math.atan2(lm[9].y - lm[0].y, lm[9].x - lm[0].x),
    closedCount: fingers.filter((f) => f.curl > 0.55).length,
    openCount: fingers.filter((f) => f.curl < 0.42).length,
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function angleAt(a, b, c) {
  const ab = len(a, b), bc = len(b, c), ac = len(a, c);
  if (!ab || !bc) return Math.PI;
  const cos = clamp((ac * ac - ab * ab - bc * bc) / (-2 * ab * bc), -1, 1);
  return Math.acos(cos);
}

/** Zócalos (sockets) de cada parte: dónde aparecen/anclarse los núcleos de servo. */
export function socketsFor(body, partId) {
  const p = body.parts?.[partId];
  if (!p || !p.visible) return [];
  const out = [];
  const push = (pos, name) => pos && out.push({ partId, name, x: pos.x, y: pos.y, z: pos.z || 0 });
  switch (partId) {
    case 'cabeza':
      push(p.center, 'visor'); push({ x: p.center.x, y: p.center.y + p.radius * 0.7 }, 'mandibula');
      break;
    case 'torso':
      push({ x: p.center.x, y: p.center.y - p.radius * 0.35 }, 'reactor');
      push({ x: p.center.x - p.radius * 0.55, y: p.center.y + p.radius * 0.2 }, 'pleural_izq');
      push({ x: p.center.x + p.radius * 0.55, y: p.center.y + p.radius * 0.2 }, 'pleural_der');
      break;
    case 'brazo_izq':
    case 'brazo_der':
      push(p.center, 'hidraulico'); push({ x: p.center.x, y: p.center.y - p.radius * 0.9 }, 'codo');
      break;
    case 'mano_izq':
    case 'mano_der': {
      push(p.center, 'muneca');
      const hand = partId === 'mano_izq' ? joints.hand_left : joints.hand_right;
      push(hand?.[9] || p.center, 'nudillos');
      break;
    }
    case 'pierna_izq':
    case 'pierna_der':
      push(p.center, 'rodilla');
      break;
  }
  return out.slice(0, 3);
}
