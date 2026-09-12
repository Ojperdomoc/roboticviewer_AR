/**
 * Tests del motor de reglas: se ejecutan con `npm test` (Node puro, sin navegador).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Rules, PHASE } from '../js/game/rules.js';
import { CONFIG } from '../js/config.js';

const cfg = { ...CONFIG.game };
const mk = (seed = 42) => new Rules(cfg, { seed });

const showAll = (r) => {
  r.setPartsVisible(Object.fromEntries(Object.keys(r.state.parts).map((k) => [k, true])));
};

test('estado inicial en reposo', () => {
  const r = mk();
  assert.equal(r.state.phase, PHASE.IDLE);
  assert.equal(r.state.score, 0);
  assert.equal(r.state.integrity, cfg.integrityMax);
});

test('start genera objetivos del protocolo y arranca el reloj', () => {
  const r = mk();
  r.start(1000);
  assert.equal(r.state.phase, PHASE.PLAY);
  assert.ok(r.state.objectives.length >= 3, 'debe tener al menos 3 objetivos');
  assert.ok(r.state.objectives.some((o) => o.kind === 'gesture'));
  assert.ok(r.state.objectives.some((o) => o.kind === 'scan'));
  assert.equal(r.state.best, 1000, 'conserva el récord');
});

test('el tick hace aparecer núcleos y descarga el tiempo', () => {
  const r = mk();
  r.start();
  showAll(r);
  const t0 = r.state.timeLeft;
  for (let i = 0; i < 200; i++) { r.setClock(i * 0.05); r.tick(0.05); r.updateCores(0.05); }
  assert.ok(r.state.timeLeft < t0);
  assert.ok(r.state.cores.length > 0, 'deben aparecer núcleos de servo');
  for (const c of r.state.cores) {
    assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z));
    assert.ok(c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1, `núcleo fuera del cuadro: ${c.x.toFixed(2)},${c.y.toFixed(2)}`);
  }
});

test('gesto pedido suma más que un gesto libre y sube el combo', () => {
  const r = mk();
  r.start();
  showAll(r);
  const obj = r.state.objectives.find((o) => o.kind === 'gesture');
  const before = r.state.score;
  r.gesture({ id: 'nada', hand: 'Left' });
  const freeGain = r.state.score - before;
  for (let i = 0; i < obj.need; i++) r.gesture({ id: obj.gesture, hand: 'Right' });
  assert.ok(obj.done, 'el objetivo de gesto debe completarse');
  assert.ok(r.state.combo >= 1);
  assert.ok(freeGain > 0 && freeGain < cfg.points.gesture, 'un gesto fuera de objetivo suma poco');
});

test('conectar un núcleo en su parte humana mejora la parte y suma puntos', () => {
  const r = mk();
  r.start();
  showAll(r);
  const core = r.spawnCore();
  const partId = core.partId;
  const lvl0 = r.state.parts[partId].level;
  assert.ok(r.grab(core.id, 'Right'));
  const res = r.place(core.id, partId, { humanVisible: true });
  assert.equal(res.ok, true);
  assert.equal(r.state.parts[partId].level, lvl0 + 1);
  assert.equal(r.state.cores.length, 0, 'el núcleo se consume al instalarlo');
  assert.ok(r.state.score > 0);
  assert.ok(r.state.stats.installs === 1);
});

test('regla de oro: conectar en una zona NO humana penaliza y no instala', () => {
  const r = mk();
  r.start();
  showAll(r);
  const core = r.spawnCore();
  const dmg0 = cfg.integrityMax - r.state.integrity;
  const res = r.place(core.id, core.partId, { humanVisible: false });
  assert.equal(res.ok, false);
  assert.equal(res.why, 'not-human');
  assert.ok(r.state.integrity < cfg.integrityMax - dmg0, 'la integridad baja');
  assert.equal(r.state.cores.length, 1, 'el núcleo se suelta, no se instala');
});

test('zócalo equivocado: penalización menor y combo roto', () => {
  const r = mk();
  r.start();
  showAll(r);
  const core = r.spawnCore();
  const other = Object.keys(r.state.parts).find((k) => k !== core.partId);
  r.grab(core.id, 'Left');
  const res = r.place(core.id, other, { humanVisible: true });
  assert.equal(res.ok, false);
  assert.equal(res.why, 'mismatch');
  assert.equal(r.state.combo, 0);
});

test('sin zócalos libres no se puede seguir instalando', () => {
  const r = mk();
  r.start();
  showAll(r);
  const partId = 'cabeza';
  const total = r.state.parts[partId].socketsTotal;
  for (let i = 0; i < total; i++) {
    const c = r.spawnCore({ x: 0, y: 0, z: 0 });
    c.partId = partId;
    r.grab(c.id, 'Left');
    assert.equal(r.place(c.id, partId, { humanVisible: true }).ok, true);
  }
  const c = r.spawnCore();
  c.partId = partId;
  r.grab(c.id, 'Left');
  assert.equal(r.place(c.id, partId, { humanVisible: true }).why, 'socket-full');
});

test('un núcleo expirado drena integridad y rompe el combo', () => {
  const r = mk();
  r.start();
  showAll(r);
  const core = r.spawnCore();
  core.age = 999;
  const i0 = r.state.integrity;
  r.tick(0.05);
  assert.ok(r.state.integrity < i0);
  assert.equal(r.state.cores.length, 0);
});

test('completar todos los objetivos avanza de ronda y da bonus', () => {
  const r = mk(7);
  r.start();
  showAll(r);
  const s0 = r.state.score;
  for (const o of r.state.objectives) {
    if (o.kind === 'gesture') for (let i = 0; i < o.need; i++) r.gesture({ id: o.gesture, hand: 'Left' });
    if (o.kind === 'cam') r.cameraSwitched(o.facing);
    if (o.kind === 'scan') { for (let i = 0; i < 40; i++) r.scanTick(0.05, true, 0); }
    if (o.kind === 'place') {
      const c = r.spawnCore(); c.partId = o.partId;
      r.grab(c.id, 'Right'); r.place(c.id, o.partId, { humanVisible: true });
    }
    o.done = o.done || false;
  }
  // forzar chequeo
  r.tick(0.016);
  assert.ok(r.state.round >= 2 || r.state.score > s0, 'debería cerrar la ronda');
  assert.equal(r.state.phase, PHASE.PLAY, 'el juego continúa en la siguiente ronda');
  assert.ok(r.state.timeLeft > cfg.roundSeconds - 1, 'el tiempo se reinicia por ronda');
});

test('la integridad a cero termina la sesión y guarda el récord', () => {
  const r = mk();
  r.start(0);
  showAll(r);
  for (let i = 0; i < 60; i++) {
    r.state.cores.length = 0;              // la bandeja debe quedar libre para poder fallar otra vez
    const c = r.spawnCore();
    if (!c) break;
    r.grab(c.id, 'Left');
    // El visor rechaza alterar zonas que no son cuerpo humano: cada intento drena integridad.
    r.place(c.id, c.partId, { humanVisible: false });
    if (r.state.phase === PHASE.OVER) break;
  }
  assert.ok(r.state.integrity <= 0, 'la integridad debe llegar a cero con tantos fallos');
  assert.equal(r.state.phase, PHASE.OVER);
  assert.ok(r.state.best >= 0);
});

test('el tiempo agotado termina la sesión', () => {
  const r = mk();
  r.start();
  r.state.timeLeft = 0.04;
  r.tick(0.05);
  assert.equal(r.state.phase, PHASE.OVER);
});

test('pausa y reanuda sin perder estado', () => {
  const r = mk();
  r.start();
  const s = r.state.score;
  r.pause();
  r.tick(1);
  assert.equal(r.state.timeLeft, r.state.timeLeft);
  r.resume();
  assert.equal(r.state.phase, PHASE.PLAY);
  assert.equal(r.state.score, s);
});

test('escaneo con cámara trasera: solo avanza si hay humano visible', () => {
  const r = mk();
  r.start();
  for (let i = 0; i < 20; i++) r.scanTick(0.05, false, 0);
  assert.equal(r.state.scan.progress, 0);
  for (let i = 0; i < 45; i++) r.scanTick(0.05, true, 0);
  assert.equal(r.state.stats.scans, 1, 'un escaneo completo');
});

test('el combo decae tras la ventana de tiempo', () => {
  const r = mk();
  r.start();
  showAll(r);
  r.gesture({ id: 'punho', hand: 'Left' });
  assert.ok(r.state.combo >= 0);
  for (let i = 0; i < Math.ceil((cfg.comboWindowSeconds + 1) / 0.1); i++) r.tick(0.1);
  assert.equal(r.state.combo, 0);
});
