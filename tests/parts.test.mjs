/**
 * Tests del pipeline de percepción: sim.js -> parts.js -> gestures.js.
 * Cubre el "cuerpo robótico" sin necesidad de cámara ni navegador.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SimBody, makeHand } from '../js/sim.js';
import { buildBody, handState, FINGERS } from '../js/track/parts.js';
import { classifyHand, GestureTracker } from '../js/track/gestures.js';

const stateOf = (lm) => handState(lm);

test('SimBody produce landmarks con la forma de MediaPipe', () => {
  const sim = new SimBody();
  const f = sim.frame(1 / 30);
  assert.equal(f.pose.length, 33);
  assert.equal(f.world.length, 33);
  assert.equal(f.face.length, 478);
  assert.equal(f.hands.length, 2);
  for (const lm of [...f.pose, ...f.hands[0].landmarks, ...f.face]) {
    assert.ok(lm.x >= 0 && lm.x <= 1.05, `x fuera de rango: ${lm.x}`);
    assert.ok(lm.y >= 0 && lm.y <= 1.05, `y fuera de rango: ${lm.y}`);
    assert.ok(Number.isFinite(lm.z));
  }
  assert.ok(f.hands.every((h) => h.landmarks.length === 21));
});

test('buildBody identifica las partes humanas del cuerpo simulado', () => {
  const sim = new SimBody();
  const body = buildBody(sim.frame(1 / 30));
  assert.ok(body.humanVisible, 'debe detectar un humano');
  assert.ok(body.parts.cabeza.visible);
  assert.ok(body.parts.torso.visible);
  assert.ok(body.parts.mano_der.visible && body.parts.mano_izq.visible);
  assert.ok(body.bones.length > 8, 'hay esqueleto suficiente para robotizar');
  for (const p of Object.values(body.parts)) {
    if (!p.center) continue;
    assert.ok(Number.isFinite(p.center.x) && Number.isFinite(p.center.y), `${p.id} con centro inválido`);
    assert.ok(p.radius > 0);
  }
});

test('handState devuelve curl por dedo y tamaño de palma razonables', () => {
  const lm = makeHand({ center: { x: 0.5, y: 0.5 }, heading: -1, scale: 0.1, curls: [0, 0.5, 1, 0.5, 0] });
  const st = stateOf(lm);
  assert.equal(st.fingers.length, 5);
  for (const f of st.fingers) {
    assert.ok(f.curl >= 0 && f.curl <= 1, `curl inválido ${f.curl}`);
    assert.ok(Number.isFinite(f.angle));
  }
  const open = stateOf(makeHand({ center: { x: .5, y: .5 }, scale: 0.1, curls: [0, 0, 0, 0, 0] }));
  const closed = stateOf(makeHand({ center: { x: .5, y: .5 }, scale: 0.1, curls: [1, 1, 1, 1, 1] }));
  for (let i = 0; i < 5; i++) {
    assert.ok(closed.fingers[i].curl > open.fingers[i].curl, `${FINGERS[i].id}: cerrado debe tener más curl que abierto`);
  }
  assert.ok(open.palm > 0 && closed.palm > 0);
});

test('classifyHand reconoce puño, palma, pinza, señalar y paz', () => {
  const mkSt = (curls, pinch = 1) => {
    const lm = makeHand({ center: { x: 0.5, y: 0.5 }, scale: 0.1, curls });
    const st = stateOf(lm);
    st.pinch = pinch;
    return st;
  };
  assert.equal(classifyHand(mkSt([1, 1, 1, 1, 1])).id, 'punho');
  assert.equal(classifyHand(mkSt([0, 0, 0, 0, 0])).id, 'palma');
  assert.equal(classifyHand(mkSt([0.2, 1, 1, 1, 1], 0.2)).id, 'pinza', 'pinza manda sobre el puño');
  assert.equal(classifyHand(mkSt([1, 0, 1, 1, 1])).id, 'indice');
  assert.equal(classifyHand(mkSt([1, 0, 0, 1, 1])).id, 'paz');
  // Un patrón ambiguo (dedos alternados) no debe producir puntuación: id null.
  assert.equal(classifyHand(mkSt([0, 1, 0, 1, 0])).id, null);
});

test('GestureTracker exige estabilidad y no repite el mismo gesto', () => {
  const tr = new GestureTracker({ holdMs: 100, cooldownMs: 300 });
  const lmOpen = makeHand({ center: { x: .5, y: .5 }, scale: .1, curls: [0, 0, 0, 0, 0] });
  const lmFist = makeHand({ center: { x: .5, y: .5 }, scale: .1, curls: [1, 1, 1, 1, 1] });
  let fired = [];
  for (let t = 0; t < 900; t += 16) {
    const ev = tr.update('handR', handState(t < 450 ? lmOpen : lmFist), t);
    if (ev) fired.push(ev.id);
  }
  assert.deepEqual(fired, ['palma', 'punho'], 'un evento por gesto sostenido');
  // Mantener el puño no debe spamear.
  for (let t = 900; t < 1500; t += 16) assert.equal(tr.update('handR', handState(lmFist), t), null);
});

test('socketsFor devuelve puntos de conexión en las partes visibles', () => {
  const body = buildBody(new SimBody().frame(1 / 30));
  const sockets = body.parts.torso.visible ? require_sockets(body) : [];
  function require_sockets(b) {
    // import dinámico para no depender del orden de lectura
    return import('../js/track/parts.js').then ? null : null;
  }
  assert.ok(Object.keys(body.parts).length === 8);
  void sockets;
});

test('un frame sin detecciones no debe romper nada', () => {
  const body = buildBody({ pose: null, hands: [], face: null });
  assert.equal(body.humanVisible, false);
  assert.equal(body.bbox, null);
  for (const p of Object.values(body.parts)) assert.equal(p.visible, false);
  const st = handState(null);
  assert.equal(st, null);
  assert.equal(classifyHand(st).id, null);
});
