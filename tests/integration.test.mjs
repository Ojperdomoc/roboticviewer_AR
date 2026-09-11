/**
 * Integración sin navegador: SIM -> partes -> gestos -> Play -> Rules.
 * Simula 60 s de partida para probar el pipeline completo del juego.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SimBody } from '../js/sim.js';
import { buildBody, handState } from '../js/track/parts.js';
import { GestureTracker, classifyHand } from '../js/track/gestures.js';
import { Play } from '../js/game/play.js';
import { Rules } from '../js/game/rules.js';
import { CONFIG } from '../js/config.js';

function simulate(seconds = 60, seed = 3) {
  const cfg = { ...CONFIG.game, roundSeconds: 30 };
  const rules = new Rules(cfg, { seed });
  const play = new Play(rules, { ...CONFIG.visor });
  const sim = new SimBody();
  const gestures = new GestureTracker({ holdMs: 120, cooldownMs: 400 });
  rules.start(0);
  const dt = 1 / 30;
  let now = 0;
  const seen = new Set();
  let installs = 0, grabs = 0, gestureCount = 0;

  for (let i = 0; i < seconds * 30; i++) {
    now += dt * 1000;
    const frame = sim.frame(dt);
    const body = buildBody(frame);
    rules.setPartsVisible(Object.fromEntries(Object.entries(body.parts).map(([k, p]) => [k, p.visible])));

    const hands = {};
    for (const side of ['Left', 'Right']) {
      const raw = body.hands[side];
      if (!raw) continue;
      const st = handState(raw.landmarks);
      hands[side] = { pos: { ...st.center, z: raw.landmarks[9].z }, pinch: st.pinch, open: st.openCount >= 4 };
      const ev = gestures.update(side === 'Left' ? 'handL' : 'handR', st, now);
      if (ev) { gestureCount++; rules.gesture({ id: ev.id, hand: side }); }
    }

    const events = play.update({ dt, body, hands, facing: i > 450 ? 'rear' : 'front', now });
    for (const e of events) {
      seen.add(e.type);
      if (e.type === 'installed') installs++;
      if (e.type === 'grab') grabs++;
    }
    if (rules.state.phase === 'over') break;
  }
  return { rules, seen, installs, grabs, gestureCount };
}

test('el pipeline completo corre 60 s sin errores y produce juego real', () => {
  const { rules, seen, installs, grabs, gestureCount } = simulate();
  assert.ok(gestureCount > 5, 'el cuerpo simulado debe producir gestos reconocibles');
  assert.ok(grabs > 0, 'la pinza de la simulación debe atrapar núcleos');
  assert.ok(installs > 0, 'debe conectar núcleos en zócalos');
  assert.ok(rules.state.score > 0);
  for (const t of ['start', 'coreSpawn', 'grab', 'installed']) assert.ok(seen.has(t), `falta el evento ${t}`);
});

test('toda la geometría que consume el renderizador es finita', () => {
  const sim = new SimBody();
  for (let i = 0; i < 300; i++) {
    const body = buildBody(sim.frame(1 / 30));
    for (const b of body.bones) {
      assert.ok(Number.isFinite(b.a.x) && Number.isFinite(b.a.y) && Number.isFinite(b.b.x) && Number.isFinite(b.b.y), 'hueso con NaN');
      assert.ok(b.length >= 0 && b.length < 3);
    }
    for (const p of Object.values(body.parts)) {
      if (p.center) assert.ok(Number.isFinite(p.center.x) && Number.isFinite(p.center.y) && Number.isFinite(p.center.z));
      assert.ok(Number.isFinite(p.radius));
    }
    assert.ok(body.scale > 0);
  }
});

test('classifyHand sobre la simulación devuelve gestos válidos del catálogo', () => {
  const sim = new SimBody();
  const valid = new Set(['punho', 'palma', 'pinza', 'indice', 'paz', 'pulgar', null]);
  const got = new Set();
  for (let i = 0; i < 400; i++) {
    const f = sim.frame(1 / 30);
    for (const h of f.hands) {
      const { id } = classifyHand(handState(h.landmarks));
      assert.ok(valid.has(id), `gesto inesperado: ${id}`);
      if (id) got.add(id);
    }
  }
  assert.ok(got.size >= 3, `la simulación debería variar de gestos (obtuvo ${[...got].join(',')})`);
});

test('Play suelta el núcleo si abres la palma lejos de un zócalo', () => {
  const rules = new Rules({ ...CONFIG.game }, { seed: 5 });
  const play = new Play(rules);
  rules.start(0);
  for (const p of Object.keys(rules.state.parts)) rules.state.parts[p].visible = false; // sin partes humanas
  const core = rules.spawnCore();
  const hand = { pos: { x: core.x, y: core.y, z: core.z }, pinch: 0.1, open: false };
  play.update({ dt: 0.03, body: { humanVisible: false, bbox: null }, hands: { Right: hand }, now: 100 });
  assert.equal(rules.state.held.Right, core.id, 'atrapado');
  play.update({ dt: 0.03, body: { humanVisible: false, bbox: null }, hands: { Right: { ...hand, open: true, x: 2 } }, now: 200 });
  void rules;
  assert.equal(rules.state.cores.length, 1, 'el núcleo vuelve a flotar');
});

test('invariante del visor: sin partes humanas NO se instala nada (sólo penalización)', () => {
  const rules = new Rules({ ...CONFIG.game, roundSeconds: 60 }, { seed: 11 });
  const play = new Play(rules, { ...CONFIG.visor, placeRadius: 0.5 });
  rules.start(0);
  const body = {
    humanVisible: true,
    bbox: { x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.9, w: 0.6, h: 0.8 },
    // Todas las partes detectadas como "no humanas" (fuera de cuadro / baja confianza).
    parts: Object.fromEntries(['cabeza', 'torso', 'brazo_izq', 'brazo_der', 'mano_izq', 'mano_der', 'pierna_izq', 'pierna_der']
      .map((id) => [id, { id, visible: false, center: { x: 0.5, y: 0.5, z: 0 }, radius: 0.1 }])),
    joints: {}, hands: {},
  };
  let installs = 0, notHuman = 0;
  const consume = (evs) => {
    for (const e of evs) {
      if (e.type === 'installed') installs++;
      if (e.type === 'reject' && e.why === 'not-human') notHuman++;
    }
  };
  for (let i = 0; i < 900; i++) {
    const core = rules.state.cores.find((c) => c.state === 'floating');
    const hand = core
      ? { pos: { x: core.x, y: core.y, z: 0 }, pinch: 0.05, open: i % 40 < 8 }
      : { pos: { x: 0.5, y: 0.5, z: 0 }, pinch: 0.9, open: i % 40 < 8 };
    consume(play.update({ dt: 1 / 30, body, hands: { Right: hand }, facing: 'front', now: i * 33 }));
    if (rules.state.phase === 'over') break;
  }
  assert.equal(installs, 0, 'nunca se altera una zona sin humano');
  assert.ok(notHuman > 0, 'el intento fuera del cuerpo debe rechazarse y penalizarse');
});

test('los núcleos nunca salen del cuadro aunque el cuerpo se mueva 120 s', () => {
  const rules = new Rules({ ...CONFIG.game }, { seed: 21 });
  rules.start(0);
  for (const id of Object.keys(rules.state.parts)) rules.state.parts[id].visible = true;
  const dt = 1 / 30;
  for (let i = 0; i < 120 * 30; i++) {
    // Centro del cuerpo paseando por la pantalla (el jugador se agacha, se acerca, etc.).
    const t = i * dt;
    rules.setPlayCenter({ x: 0.5 + Math.sin(t) * 0.42, y: 0.5 + Math.cos(t * 0.7) * 0.4, z: 0 });
    rules.updateCores(dt);
    rules.tick(dt);
    for (const c of rules.state.cores) {
      assert.ok(c.x >= -0.001 && c.x <= 1.001 && c.y >= -0.001 && c.y <= 1.001, `núcleo fuera del cuadro: ${c.x.toFixed(3)},${c.y.toFixed(3)}`);
      assert.ok(Number.isFinite(c.z));
    }
  }
  assert.ok(rules.state.cores.length <= CONFIG.game.maxCores, 'el tope de núcleos en pantalla se respeta');
});
