/**
 * rules.js — máquina de estados del juego (100% pura, sin DOM ni three.js).
 *
 * Se prueba en Node (tests/rules.test.mjs). El renderizador y la interfaz sólo leen
 * `state` y consumen la cola de `events`, y le envían acciones discretas.
 *
 * Bucle de juego:
 *  1. El protocolo de calibración pide objetivos (gestos, escaneo con cámara trasera,
 *     cambiar de cámara, conectar núcleos).
 *  2. Los NÚCLEOS DE SERVO flotan alrededor del cuerpo; se atrapan con PINZA.
 *  3. Un núcleo se conecta en el zócalo de SU parte del cuerpo. Solo partes humanas
 *     detectadas aceptan zócalos: conectar contra el fondo es un fallo de calibración.
 *  4. Completar todo antes del tiempo => bonus y siguiente protocolo (más rápido).
 *  5. Perder núcleos o equivocarte drena INTEGRIDAD; a 0 termina la sesión.
 */

import { BODY_PARTS } from '../config.js';
import { clamp, mulberry32, shuffle, uid } from '../util.js';

export const PHASE = { IDLE: 'idle', PLAY: 'play', ROUND_END: 'roundEnd', OVER: 'over' };

export class Rules {
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.rnd = opts.seed != null ? mulberry32(opts.seed) : Math.random;
    this.listeners = new Set();
    this.state = this.#initial();
  }

  #initial() {
    const parts = {};
    for (const p of BODY_PARTS) {
      parts[p.id] = { id: p.id, label: p.label, level: 0, socketsTotal: p.sockets, socketsLeft: p.sockets, visible: false, hp: 0 };
    }
    return {
      phase: PHASE.IDLE,
      round: 1,
      score: 0,
      best: 0,
      combo: 0,
      comboTimer: 0,
      integrity: this.cfg.integrityMax,
      timeLeft: this.cfg.roundSeconds,
      spawnTimer: 0.6,
      parts,
      cores: [],
      objectives: [],
      held: { Left: null, Right: null },
      scan: { progress: 0, active: false },
      facing: 'front',
      rearTime: 0,
      center: { x: 0.5, y: 0.5, z: 0 },
      stats: { gestures: 0, installs: 0, lostCores: 0, rejects: 0, scans: 0, camSwitches: 0, bestCombo: 0 },
      events: [],
      log: [],
    };
  }

  /* ------------------------------------------------------------------ helpers */

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  #emit(type, data = {}) {
    const ev = { type, ...data, at: this.#now() };
    this.state.events.push(ev);
    if (this.state.events.length > 64) this.state.events.splice(0, this.state.events.length - 64);
    for (const fn of this.listeners) fn(ev);
    return ev;
  }
  #now() { return this.clock ?? 0; }
  /** Reloj del juego, lo inyecta el bucle principal. */
  setClock(t) { this.clock = t; }
  drainEvents() { const e = this.state.events; this.state.events = []; return e; }
  get state_() { return this.state; }

  #mult() { return Math.min(this.cfg.comboMax, 1 + this.state.combo * this.cfg.comboStep); }
  #addScore(base, why) {
    const pts = Math.round(base * this.#mult());
    this.state.score += pts;
    this.#emit('score', { points: pts, why });
    return pts;
  }
  #bumpCombo() {
    this.state.combo += 1;
    this.state.comboTimer = this.cfg.comboWindowSeconds;
    this.state.stats.bestCombo = Math.max(this.state.stats.bestCombo, this.state.combo);
    this.#emit('combo', { combo: this.state.combo, mult: this.#mult() });
  }
  #breakCombo(reason) {
    if (this.state.combo > 1) this.#emit('comboBreak', { combo: this.state.combo, reason });
    this.state.combo = 0;
    this.state.comboTimer = 0;
  }
  #damage(amount, reason) {
    this.state.integrity = clamp(this.state.integrity - amount, 0, this.cfg.integrityMax);
    this.#emit('damage', { amount, reason, integrity: this.state.integrity });
    if (this.state.integrity <= 0) this.gameOver('integrity');
  }

  #difficulty() {
    const r = this.state.round;
    return {
      maxCores: clamp(3 + Math.floor(r / 2), 3, this.cfg.maxCores),
      spawnEvery: Math.max(1.05, this.cfg.coreSpawnSeconds / (1 + (r - 1) * 0.12)),
      coreLife: Math.max(4.6, 10.5 - r * 0.55),
      objectiveCount: clamp(3 + Math.floor(r / 2), 3, 7),
      drift: this.cfg.coreDriftSpeed * (1 + (r - 1) * 0.16),
    };
  }

  /* ------------------------------------------------------------------- flow */

  start(best = 0) {
    const keepBest = Math.max(best, this.state.best);
    this.state = this.#initial();
    this.state.best = keepBest;
    this.state.phase = PHASE.PLAY;
    this.#rollObjectives();
    this.#emit('start', { round: 1 });
    return this.state;
  }

  restart() { return this.start(this.state.best); }
  pause() { if (this.state.phase === PHASE.PLAY) { this.state.phase = 'paused'; this.#emit('pause'); } }
  resume() { if (this.state.phase === 'paused') { this.state.phase = PHASE.PLAY; this.#emit('resume'); } }

  gameOver(reason = 'time') {
    if (this.state.phase === PHASE.OVER) return;
    this.state.phase = PHASE.OVER;
    if (this.state.score > this.state.best) this.state.best = this.state.score;
    this.#emit('gameOver', { reason, score: this.state.score, best: this.state.best, round: this.state.round });
  }

  /** Objetivos del protocolo: gestos + conexiones + escaneo + cambio de cámara. */
  #rollObjectives() {
    const d = this.#difficulty();
    const rnd = this.rnd;
    const gestureIds = ['punho', 'palma', 'pinza', 'indice', 'paz', 'pulgar'];
    const parts = BODY_PARTS.map((p) => p.id);
    const objs = [];

    const nGest = clamp(2 + Math.floor(this.state.round / 3), 2, 4);
    for (const g of shuffle(gestureIds, rnd).slice(0, nGest)) {
      objs.push({ id: uid('o'), kind: 'gesture', gesture: g, need: 1 + Math.floor(rnd() * 2) + (this.state.round > 3 ? 1 : 0), progress: 0, reward: this.cfg.points.gesture });
    }
    const nPlace = clamp(1 + Math.floor(this.state.round / 2), 1, 3);
    for (const p of shuffle(parts, rnd).slice(0, nPlace)) {
      objs.push({ id: uid('o'), kind: 'place', partId: p, need: 1, progress: 0, reward: this.cfg.points.place });
    }
    if (this.state.round >= 1) objs.push({ id: uid('o'), kind: 'scan', need: 1, progress: 0, reward: this.cfg.points.scan });
    if (this.state.round % 2 === 1) objs.push({ id: uid('o'), kind: 'cam', facing: 'rear', need: 1, progress: 0, reward: this.cfg.points.switchCam });

    this.state.objectives = objs.slice(0, d.objectiveCount + 2);
    this.#emit('objectives', { round: this.state.round, count: this.state.objectives.length });
  }

  #objectiveDone(o) { o.done = true; this.#addScore(o.reward, `objetivo:${o.kind}`); this.#bumpCombo(); this.#emit('objective', { id: o.id, kind: o.kind }); }

  #checkRoundClear() {
    if (this.state.phase !== PHASE.PLAY) return;
    if (!this.state.objectives.length) return;
    if (!this.state.objectives.every((o) => o.done)) return;
    const timeBonus = Math.round(this.state.timeLeft * 10);
    const perfect = this.state.stats.rejects === 0 && this.state.integrity >= this.cfg.integrityMax;
    this.state.score += timeBonus + this.cfg.points.roundClear + (perfect ? this.cfg.points.perfect : 0);
    this.#emit('roundClear', { round: this.state.round, timeBonus, perfect });
    this.state.round += 1;
    this.state.timeLeft = this.cfg.roundSeconds;
    this.state.integrity = clamp(this.state.integrity + 12, 0, this.cfg.integrityMax);
    for (const p of Object.values(this.state.parts)) p.socketsLeft = p.socketsTotal;
    for (const c of this.state.cores) this.#dropCore(c, 'round');
    this.state.cores = [];
    this.#rollObjectives();
  }

  /* ------------------------------------------------------------------ clock */

  tick(dt) {
    const s = this.state;
    if (s.phase !== PHASE.PLAY) return;
    s.timeLeft = Math.max(0, s.timeLeft - dt);
    if (s.comboTimer > 0) { s.comboTimer = Math.max(0, s.comboTimer - dt); if (s.comboTimer === 0 && s.combo > 0) this.#breakCombo('tiempo'); }
    s.rearTime += s.facing === 'rear' ? dt : 0;

    const d = this.#difficulty();
    s.spawnTimer -= dt;
    if (s.spawnTimer <= 0 && s.cores.length < d.maxCores) {
      this.spawnCore();
      s.spawnTimer = d.spawnEvery;
    }

    for (const c of s.cores.slice()) {
      c.age += dt;
      if (c.state !== 'held' && c.age > d.coreLife) this.#dropCore(c, 'expirado');
    }

    if (s.scan.active) s.scan.progress = Math.max(0, s.scan.progress - dt * 18);

    if (s.timeLeft <= 0) this.gameOver('tiempo');
    this.#checkRoundClear();
  }

  /* ------------------------------------------------------------------- cores */

  /**
   * Centro alrededor del cual flotan los núcleos. Se alimenta del bbox del cuerpo
   * detectado, así el juego ocurre SOBRE tu cuerpo y no en un rincón de la pantalla.
   * Coordenadas en espacio de imagen (0..1).
   */
  setPlayCenter(c) {
    if (!c) return;
    const s = this.state.center;
    s.x = s.x + (clamp(c.x, 0.12, 0.88) - s.x) * 0.12;
    s.y = s.y + (clamp(c.y, 0.15, 0.85) - s.y) * 0.12;
    s.z = s.z + ((c.z || 0) - s.z) * 0.12;
  }

  spawnCore(seedPos) {
    const s = this.state;
    const d = this.#difficulty();
    if (s.cores.length >= d.maxCores) return null;
    const human = BODY_PARTS.filter((p) => s.parts[p.id].visible && s.parts[p.id].socketsLeft > 0);
    const pool = human.length ? human : BODY_PARTS;
    const part = pool[Math.floor(this.rnd() * pool.length) % pool.length];
    const c = s.center;
    const p0 = seedPos
      ? { x: clamp(seedPos.x, 0.05, 0.95), y: clamp(seedPos.y, 0.07, 0.93), z: clamp(seedPos.z || 0, -0.1, 0.1) }
      : {
        x: clamp(c.x + (this.rnd() - 0.5) * 0.62, 0.05, 0.95),
        y: clamp(c.y + (this.rnd() - 0.5) * 0.5, 0.07, 0.93),
        z: clamp(c.z + (this.rnd() - 0.5) * 0.06, -0.1, 0.1),
      };
    const core = {
      id: uid('core'), partId: part.id, label: part.label,
      x: p0.x, y: p0.y, z: p0.z || 0,
      vx: (this.rnd() - 0.5) * d.drift, vy: (this.rnd() - 0.5) * d.drift, vz: (this.rnd() - 0.5) * d.drift * 0.4,
      spin: this.rnd() * Math.PI, age: 0, state: 'floating', heldBy: null, life: d.coreLife,
    };
    s.cores.push(core);
    this.#emit('coreSpawn', { id: core.id, partId: core.partId });
    return core;
  }

  #dropCore(core, reason) {
    const s = this.state;
    const i = s.cores.indexOf(core);
    if (i >= 0) s.cores.splice(i, 1);
    if (core.heldBy) s.held[core.heldBy] = null;
    if (reason === 'expirado') {
      s.stats.lostCores += 1;
      this.#breakCombo('perdido');
      this.#damage(this.cfg.penaltyLostCore, 'núcleo perdido');
    }
    this.#emit('coreLost', { id: core.id, partId: core.partId, reason });
  }

  /**
   * Deriva de los núcleos, rebotando dentro del área jugable (centrada en el cuerpo).
   * @param {number} dt
   * @param {{x?:number,y?:number,z?:number}} [half] semiamplitud en espacio de imagen
   */
  updateCores(dt, half = { x: 0.4, y: 0.34, z: 0.07 }) {
    const s = this.state;
    if (s.phase !== PHASE.PLAY) return;
    const c0 = s.center;
    for (const c of s.cores) {
      c.spin += dt * 1.6;
      if (c.state === 'held') continue;
      // Atracción suave hacia el cuerpo: los núcleos orbitan al humano, no a la pantalla.
      c.vx += (c0.x - c.x) * dt * 0.35;
      c.vy += (c0.y - c.y) * dt * 0.35;
      c.vx *= 0.995; c.vy *= 0.995;
      c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
      const lim = (v, center, h) => {
        if (Math.abs(v - center) > h) { const d = v > center ? 1 : -1; return [center + d * h, -1]; }
        return [v, 0];
      };
      let r = lim(c.x, c0.x, half.x); c.x = r[0]; if (r[1]) c.vx = -c.vx;
      r = lim(c.y, c0.y, half.y); c.y = r[0]; if (r[1]) c.vy = -c.vy;
      r = lim(c.z, c0.z, half.z); c.z = r[0]; if (r[1]) c.vz = -c.vz;
      // Red de seguridad: si el cuerpo se movió rápido, el núcleo nunca se va del cuadro
      // (si se saliera, sería inagarrable y castigaría al jugador sin culpa).
      if (c.x < 0.04 || c.x > 0.96) { c.x = clamp(c.x, 0.04, 0.96); c.vx = Math.abs(c.vx) * (c.x < 0.5 ? 1 : -1); }
      if (c.y < 0.06 || c.y > 0.94) { c.y = clamp(c.y, 0.06, 0.94); c.vy = Math.abs(c.vy) * (c.y < 0.5 ? 1 : -1); }
      c.z = clamp(c.z, -0.12, 0.12);
    }
  }

  /** Atrapar un núcleo con una mano (la detección de proximidad la hace el modo). */
  grab(coreId, hand) {
    const s = this.state;
    if (s.phase !== PHASE.PLAY) return false;
    const core = s.cores.find((c) => c.id === coreId);
    if (!core || core.state !== 'floating' || s.held[hand]) return false;
    core.state = 'held'; core.heldBy = hand;
    s.held[hand] = core.id;
    this.#emit('grab', { id: core.id, hand, partId: core.partId });
    return true;
  }

  release(coreId, hand) {
    const s = this.state;
    const core = s.cores.find((c) => c.id === coreId);
    if (!core || core.state !== 'held') return false;
    core.state = 'floating'; core.heldBy = null;
    core.vx = (this.rnd() - 0.5) * 0.06; core.vy = (this.rnd() - 0.5) * 0.06;
    s.held[hand ?? core.heldBy] = null;
    this.#emit('release', { id: core.id });
    return true;
  }

  /**
   * Conectar el núcleo en una parte del cuerpo.
   * @param {string} coreId
   * @param {string} partId
   * @param {{humanVisible:boolean}} ctx si la parte está realmente detectada como humana
   */
  place(coreId, partId, ctx = { humanVisible: true }) {
    const s = this.state;
    if (s.phase !== PHASE.PLAY) return { ok: false, why: 'phase' };
    const core = s.cores.find((c) => c.id === coreId);
    const part = s.parts[partId];
    if (!core || !part) return { ok: false, why: 'noexiste' };

    // Regla de oro del visor: SOLO se alteran partes humanas.
    if (!ctx.humanVisible || !part.visible) {
      s.stats.rejects += 1;
      this.#breakCombo('no-humano');
      this.#damage(this.cfg.penaltyNotHuman, 'zona no humana');
      this.#emit('reject', { why: 'not-human', partId, id: coreId });
      this.release(coreId, core.heldBy);
      return { ok: false, why: 'not-human' };
    }
    if (core.partId !== partId) {
      s.stats.rejects += 1;
      this.#breakCombo('incompatible');
      this.#damage(this.cfg.penaltyWrongSocket, 'zócalo incorrecto');
      this.#emit('reject', { why: 'mismatch', partId, expected: core.partId, id: coreId });
      this.release(coreId, core.heldBy);
      return { ok: false, why: 'mismatch' };
    }
    if (part.socketsLeft <= 0) {
      s.stats.rejects += 1;
      this.#damage(Math.round(this.cfg.penaltyWrongSocket / 2), 'sin zócalos');
      this.#emit('reject', { why: 'socket-full', partId, id: coreId });
      this.release(coreId, core.heldBy);
      return { ok: false, why: 'socket-full' };
    }

    part.socketsLeft -= 1;
    part.level = clamp(part.level + 1, 0, this.cfg.maxPartLevel);
    part.hp += 1;
    s.stats.installs += 1;
    const gained = this.#addScore(this.cfg.points.place + part.level * this.cfg.upgradePointsPerLevel, `instalar:${partId}`);
    this.#bumpCombo();
    const idx = s.cores.indexOf(core);
    if (idx >= 0) s.cores.splice(idx, 1);
    s.held[core.heldBy || 'Left'] = null;
    this.#emit('installed', { id: core.id, partId, level: part.level, points: gained, hand: core.heldBy });
    for (const o of s.objectives) if (!o.done && o.kind === 'place' && o.partId === partId) { o.progress += 1; if (o.progress >= o.need) this.#objectiveDone(o); }
    this.#checkRoundClear();
    return { ok: true, level: part.level };
  }

  /** Marca la visibilidad de partes (llamado por el tracker cada frame). */
  setPartsVisible(visibleMap) {
    let changed = false;
    for (const p of Object.values(this.state.parts)) {
      const v = !!visibleMap[p.id];
      if (p.visible !== v) { p.visible = v; changed = true; }
    }
    if (changed) this.#emit('bodyVisible', { visible: Object.keys(visibleMap).filter((k) => visibleMap[k]) });
  }

  /* -------------------------------------------------------------- gestos/etc */

  gesture({ id, hand }) {
    const s = this.state;
    if (s.phase !== PHASE.PLAY) return 0;
    s.stats.gestures += 1;
    let hit = 0;
    for (const o of s.objectives) {
      if (o.done || o.kind !== 'gesture' || o.gesture !== id) continue;
      o.progress += 1; hit = 1;
      if (o.progress >= o.need) this.#objectiveDone(o);
    }
    const pts = this.#addScore(this.cfg.points.gesture * (hit ? 1.6 : 0.5), `gesto:${id}`);
    if (hit) this.#bumpCombo();
    this.#emit('gesture', { id, hand, points: pts, objective: !!hit });
    this.#checkRoundClear();
    return pts;
  }

  /** Progreso del escáner de sujeto (cámara trasera). value en 0..1 por frame. */
  scanTick(dt, humanVisible, distance = 0) {
    const s = this.state;
    if (s.phase !== PHASE.PLAY) return;
    s.scan.active = true;
    if (humanVisible) {
      const rate = 46 * dt * (1 - clamp(distance, 0, 0.6));
      s.scan.progress = clamp(s.scan.progress + rate, 0, 100);
      if (s.scan.progress >= 100) {
        s.scan.progress = 0;
        s.stats.scans += 1;
        for (const o of s.objectives) if (!o.done && o.kind === 'scan') { o.progress += 1; if (o.progress >= o.need) this.#objectiveDone(o); }
        this.#addScore(this.cfg.points.scan, 'escaneo');
        this.#bumpCombo();
        this.#emit('scanned', {});
        this.spawnCore();
        this.#checkRoundClear();
      }
    } else {
      s.scan.progress = Math.max(0, s.scan.progress - dt * 24);
    }
  }

  cameraSwitched(facing) {
    const s = this.state;
    s.facing = facing;
    s.stats.camSwitches += 1;
    if (s.phase !== PHASE.PLAY) return;
    for (const o of s.objectives) if (!o.done && o.kind === 'cam' && o.facing === facing) { o.progress = o.need; this.#objectiveDone(o); }
    this.#addScore(this.cfg.points.switchCam / 2, 'cambio-camara');
    this.#emit('cameraSwitch', { facing });
    this.#checkRoundClear();
  }

  /** Nivel medio de mejora del cuerpo (para el HUD y el aspecto del rig). */
  upgradeLevel() {
    const ps = Object.values(this.state.parts);
    return ps.reduce((a, p) => a + p.level, 0) / Math.max(1, ps.length);
  }
}

export default Rules;
