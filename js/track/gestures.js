/**
 * gestures.js — clasificador de gestos de mano (función pura + tracker con histéresis).
 *
 * Estrategia: cada dedo tiene un `curl` 0..1 (0 = extendido). Los gestos se definen
 * como patrones sobre los 5 curls + distancia de pinza + orientación de la mano.
 * `GestureTracker` exige que el gesto sea estable `holdMs` para declararlo, evitando
 * falsos positivos en movimientos rápidos.
 */

import { GESTURES } from '../config.js';

const ORDER = ['pulgar', 'indice', 'medio', 'anular', 'menique'];
const byId = (fingers) => Object.fromEntries(fingers.map((f) => [f.id, f]));

/**
 * @param {{fingers:Array, pinch:number, palm:number, center:Object}} st resultado de handState()
 * @param {{open?:number, closed?:number}} [th] umbrales de curl
 * @returns {{id:string|null, scores:Object}}
 */
export function classifyHand(st, th = {}) {
  if (!st?.fingers) return { id: null, scores: {} };
  const OPEN = th.open ?? 0.45;   // curl por debajo => extendido
  const CLOSED = th.closed ?? 0.6; // curl por encima => cerrado
  const f = byId(st.fingers);
  const ex = (id) => f[id].curl < OPEN;
  const cu = (id) => f[id].curl > CLOSED;
  const c = ORDER.map((id) => f[id].curl);
  const scores = {};

  // Puño: los cuatro dedos largos cerrados (el pulgar puede quedar por encima).
  const fourClosed = c[1] > CLOSED && c[2] > CLOSED && c[3] > CLOSED && c[4] > CLOSED;
  scores.punho = fourClosed ? (c[1] + c[2] + c[3] + c[4]) / 4 : 0;

  // Palma abierta: los cinco extendidos y separados.
  if (ex('indice') && ex('medio') && ex('anular') && ex('menique') && f.pulgar.curl < 0.65) scores.palma = 1;

  // Pinza (AGARRE del juego): pulgar tocando el índice. Si el contacto es inequívoco,
  // manda sobre cualquier otro gesto para que atrapar núcleos se sienta respondeño.
  const strongPinch = st.pinch < 0.3;
  if (st.pinch < 0.45) scores.pinza = strongPinch ? 1.2 : (0.45 - st.pinch) / 0.15;

  // Señalar: solo índice extendido (y sin pinza, que es el mismo dedo abajo).
  if (!strongPinch && ex('indice') && cu('medio') && cu('anular') && cu('menique') && st.pinch > 0.55) scores.indice = 1;

  // Paz: índice + medio extendidos, resto cerrado.
  if (!strongPinch && ex('indice') && ex('medio') && cu('anular') && cu('menique')) scores.paz = 1;

  // Pulgar arriba: puño con el pulgar muy por encima de la muñeca.
  if (!strongPinch && c[1] > CLOSED && c[2] > CLOSED && c[3] > CLOSED && c[4] > CLOSED && f.pulgar.curl < 0.55) {
    const up = f.pulgar.tip.y < (st.center?.y ?? 0) - st.palm * 0.35;
    if (up) scores.pulgar = 1;
  }

  let best = null, bestScore = 0;
  for (const [id, s] of Object.entries(scores)) if (s > bestScore) { best = id; bestScore = s; }
  return { id: bestScore >= 0.5 ? best : null, score: bestScore, scores };
}

/**
 * Tracker con histéresis + enfriamiento. Emite un gesto una sola vez por gesto sostenido.
 */
export class GestureTracker {
  constructor(opts = {}) {
    this.holdMs = opts.holdMs ?? 180;
    this.cooldownMs = opts.cooldownMs ?? 520;
    this.state = new Map(); // key -> {id, since, lastEmit, candidate, candSince}
  }

  reset(key = 'default') { this.state.delete(key); }

  /**
   * @param {string} key identificador (handLeft/handRight)
   * @param {Object} handState handState()
   * @param {number} nowMs
   * @returns {{id:string,hand:string,startedAt:number}|null} gesto recién confirmado
   */
  update(key, handState, nowMs) {
    const { id } = classifyHand(handState);
    let s = this.state.get(key);
    if (!s) { s = { id: null, since: 0, lastEmit: -1e9, candidate: id ?? null, candSince: nowMs }; this.state.set(key, s); }

    if ((id ?? null) !== s.candidate) { s.candidate = id ?? null; s.candSince = nowMs; }

    let fired = null;
    if (s.candidate && s.candidate !== s.id && nowMs - s.candSince >= this.holdMs && nowMs - s.lastEmit >= this.cooldownMs) {
      s.id = s.candidate;
      s.since = nowMs;
      s.lastEmit = nowMs;
      fired = { id: s.id, hand: key, startedAt: nowMs, label: GESTURES.find((g) => g.id === s.id)?.label ?? s.id };
    } else if (!s.candidate) {
      s.id = null;
    }
    return fired;
  }

  /** Gestos actualmente sostenidos (para el HUD). */
  held() {
    const out = {};
    for (const [k, v] of this.state) if (v.id) out[k] = v.id;
    return out;
  }
}

export const GESTURE_IDS = GESTURES.map((g) => g.id);
