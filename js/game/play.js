/**
 * play.js — capa jugable AGNÓSTICA del dispositivo (pura, testeable en Node).
 *
 * Convierte el estado del cuerpo (partes + manos) en acciones del juego:
 *  - PINZA cerca de un núcleo  → `grab`
 *  - PALMA abierta cerca de un zócalo → `place` (con la bandera `humanVisible` real)
 *  - Soltar la pinza sin zócalo → `release`
 *  - Cámara trasera mirando a un humano → progreso de `scanTick`
 *
 * Todas las posiciones están en "espacio de imagen" (x,y en 0..1, z en profundidad
 * relativa), que es el mismo espacio donde el modo dibuja los núcleos. Así el visor
 * 2D, el modo gafas y el modo XR comparten exactamente la misma lógica de juego.
 */

import { BODY_PARTS } from '../config.js';
import { clamp, dist2 } from '../util.js';

export const DEFAULTS = {
  grabRadius: 0.085,
  placeRadius: 0.1,
  zTolerance: 0.09,
  pinchOpen: 0.45,
  palmOpen: 0.45,
};

export class Play {
  /**
   * @param {import('./rules.js').Rules} rules
   * @param {typeof DEFAULTS} [cfg]
   */
  constructor(rules, cfg = {}) {
    this.rules = rules;
    this.cfg = { ...DEFAULTS, ...cfg };
    this.hover = null;        // núcleo bajo el cursor de una mano
    this.socketHover = null;  // zócalo bajo la mano que sostiene un núcleo
    this.bodyParts = {};      // geometría del último frame (centros/radios), para zócalos
  }

  /** @returns {Array} eventos emitidos por las reglas en este step */
  update({ dt, body, hands, facing = 'front', xr = false, now = 0 }) {
    const R = this.rules;
    R.setClock(now);
    R.updateCores(dt);
    R.tick(dt);
    if (R.state.phase !== 'play') return R.drainEvents();

    this.bodyParts = body?.parts ?? this.bodyParts;

    const hs = this.#handStates(hands);
    for (const [side, h] of hs) {
      if (!h) continue;
      if (h.held) { this.#followHand(h.held, h.pos); this.#placeOrRelease(side, h); }
      else this.#tryGrab(side, h);
    }

    // Escaneo de sujeto: sólo avanza si hay partes humanas en cuadro; con la cámara
    // trasera (u en XR) va a velocidad completa y de frente al 60 %.
    const human = !!(body?.humanVisible && body?.bbox);
    const distance = human ? this.#subjectDistance(body) : 1;
    const rate = facing === 'rear' || xr ? 1 : 0.6;
    R.scanTick(dt * rate, human, distance);

    return R.drainEvents();
  }

  #handStates(hands) {
    const out = [];
    for (const side of ['Left', 'Right']) {
      const h = hands?.[side];
      out.push([side, h ? {
        pos: h.pos,
        pinch: h.pinch ?? 1,
        open: h.open ?? false,
        held: this.rules.state.held[side] ?? null,
      } : null]);
    }
    return out;
  }

  /** El núcleo agarrado viaja con la mano: es la única fuente de verdad del agarre. */
  #followHand(coreId, pos) {
    const core = this.rules.state.cores.find((c) => c.id === coreId);
    if (!core || core.state !== 'held') return;
    core.x += (pos.x - core.x) * 0.6;
    core.y += (pos.y - core.y) * 0.6;
    core.z += ((pos.z || 0) - core.z) * 0.45;
    core.vx = core.vy = core.vz = 0;
  }

  #tryGrab(side, h) {
    if (h.pinch > this.cfg.pinchOpen) return;
    const core = this.#nearestCore(h.pos);
    if (!core) return;
    this.rules.grab(core.id, side);
  }

  #placeOrRelease(side, h) {
    const coreId = h.held;
    const core = this.rules.state.cores.find((c) => c.id === coreId);
    if (!core) { this.rules.state.held[side] = null; return; }

    const socket = this.#nearestSocket(h.pos, core.partId);
    this.socketHover = socket;
    if (!h.open) return; // sigue agarrado hasta abrir la palma

    if (socket) {
      // `human` llega del detector: si la zona no es cuerpo humano, las reglas penalizan.
      this.rules.place(coreId, socket.partId, { humanVisible: socket.human !== false });
    } else {
      this.rules.release(coreId, side);
    }
  }

  /** Núcleo más cercano dentro del radio (usa z como margen de profundidad). */
  #nearestCore(pos) {
    let best = null, bestD = this.cfg.grabRadius;
    for (const c of this.rules.state.cores) {
      if (c.state !== 'floating') continue;
      const d = this.#d(pos, c);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  /**
   * Zócalo más cercano. El del propio núcleo tiene un radio generoso (x1.9): acertar
   * el zócalo correcto debe ser fácil; conectar en el equivocado, un error de cálculo.
   */
  #nearestSocket(pos, partId) {
    const s = this.rules.state;
    const matchR = this.cfg.placeRadius * 1.9;
    let best = null, bestD = matchR;
    let fallback = null, fbD = this.cfg.placeRadius;
    for (const part of BODY_PARTS) {
      const geo = this.bodyParts[part.id];   // centro + radio (del frame de percepción)
      const rp = s.parts[part.id];           // nivel + zócalos libres (del motor de reglas)
      if (!geo || !rp) continue;
      const sockets = this.socketProvider ? this.socketProvider(part.id, geo, rp) : partSocketHints(part.id, geo);
      for (const sk of sockets || []) {
        const cand = { ...sk, partId: part.id, human: !!geo.visible, level: rp.level, socketsLeft: rp.socketsLeft };
        const d = this.#d(pos, cand);
        if (part.id === partId) { if (d < bestD) { bestD = d; best = { ...cand, match: true }; } }
        else if (d < fbD) { fbD = d; fallback = cand; }
      }
    }
    return best ?? fallback;
  }

  #d(pos, o) {
    const plane = dist2(pos, o);
    const dz = Math.abs((pos.z || 0) - (o.z || 0));
    return plane + (dz > this.cfg.zTolerance ? (dz - this.cfg.zTolerance) * 0.8 : 0);
  }

  /** Qué tan "grande" está el sujeto en el cuadro (0 cerca .. 1 lejos). */
  #subjectDistance(body) {
    const b = body?.bbox;
    if (!b) return 1;
    return clamp(1 - Math.max(b.w, b.h), 0, 1);
  }
}

/**
 * Pistas de zócalo por parte. En el visor 2D el modo inyecta posiciones reales
 * (`part.socketPos`); si no hay, se estiman desde el centro/radio de la parte.
 */
function partSocketHints(partId, part) {
  const c = part.center;
  if (!c) return [];
  if (part.socketPos?.length) return part.socketPos;
  const r = part.radius ?? 0.05;
  const at = (dx, dy, name) => ({ x: c.x + dx * r, y: c.y + dy * r, z: c.z || 0, name });
  switch (partId) {
    case 'cabeza': return [at(0, -0.15, 'visor'), at(0, 0.6, 'mandíbula')];
    case 'torso': return [at(0, -0.3, 'reactor'), at(-0.6, 0.2, 'pleural izq.'), at(0.6, 0.2, 'pleural der.')];
    case 'brazo_izq':
    case 'brazo_der': return [at(0, 0, 'hidráulico'), at(0, -0.8, 'codo')];
    case 'mano_izq':
    case 'mano_der': return [at(0, 0.4, 'muñeca'), at(0, -0.5, 'nudillos')];
    case 'pierna_izq':
    case 'pierna_der': return [at(0, 0, 'rodilla')];
    default: return [at(0, 0, partId)];
  }
}

export { partSocketHints };
