/**
 * rig.js — cuerpo robótico procedural (sin modelos externos: se arma con primitivas).
 *
 * El rig NO conoce la cámara ni WebXR: recibe un "esqueleto" (joints con nombres) y
 * una función `toRender(p)` que el modo visor o el modo XR usa para llevar cada punto a
 * su espacio de render. Así el mismo robot sirve para:
 *   - visor 2D sobre el video (pixeles alineados al cuerpo real),
 *   - RA/VR inmersiva (metros reales, anclado al pecho),
 *   - modo gafas estéreo.
 *
 * Cada parte del cuerpo tiene su propio material, y su nivel de mejora (0..4) cambia
 * emisivo, anillos de armadura y color de acento: el cuerpo se ve literalmente "más
 * robótico" a medida que conectas núcleos de servo.
 */

import { CONFIG, BODY_PARTS } from '../config.js';
import { HAND_CONNECTIONS, FINGERS } from '../track/parts.js';

import { clamp, damp, lerp } from '../util.js';

const DEG = Math.PI / 180;

const PART_GROUP = {
  cabeza: 'head', torso: 'torso', cuello: 'torso',
  brazo_izq: 'armL', mano_izq: 'handL',
  brazo_der: 'armR', mano_der: 'handR',
  pierna_izq: 'legL', pierna_der: 'legR',
};

/** Huesos por nombre de joint (igual que POSE en js/track/parts.js). */
const BODY_BONES = [
  ['l_shoulder', 'r_shoulder', 'torso', 0.9],
  ['l_shoulder', 'l_elbow', 'brazo_izq', 0.55],
  ['l_elbow', 'l_wrist', 'brazo_izq', 0.45],
  ['r_shoulder', 'r_elbow', 'brazo_der', 0.55],
  ['r_elbow', 'r_wrist', 'brazo_der', 0.45],
  ['l_shoulder', 'l_hip', 'torso', 0.6],
  ['r_shoulder', 'r_hip', 'torso', 0.6],
  ['l_hip', 'r_hip', 'torso', 0.85],
  ['nose', 'l_shoulder', 'cuello', 0.3],
  ['nose', 'r_shoulder', 'cuello', 0.3],
  ['l_hip', 'l_knee', 'pierna_izq', 0.62],
  ['l_knee', 'l_ankle', 'pierna_izq', 0.5],
  ['l_ankle', 'l_foot', 'pierna_izq', 0.4],
  ['r_hip', 'r_knee', 'pierna_der', 0.62],
  ['r_knee', 'r_ankle', 'pierna_der', 0.5],
  ['r_ankle', 'r_foot', 'pierna_der', 0.4],
];

const KEY_JOINTS = ['l_shoulder', 'r_shoulder', 'l_elbow', 'r_elbow', 'l_wrist', 'r_wrist', 'l_hip', 'r_hip', 'l_knee', 'r_knee', 'l_ankle', 'r_ankle', 'nose'];

export class RobotRig {
  /**
   * @param {object} THREE namespace de three.js
   * @param {{quality?:'bajo'|'medio'|'alto', env?:THREE.Texture}} opts
   */
  constructor(THREE, opts = {}) {
    this.THREE = THREE;
    this.quality = opts.quality || 'medio';
    this.env = opts.env || null;
    this.root = new THREE.Group();
    this.root.name = 'robot-rig';
    this.groupBody = new THREE.Group();
    this.groupHands = new THREE.Group();
    this.groupFx = new THREE.Group();
    this.root.add(this.groupBody, this.groupHands, this.groupFx);

    this.bones = [];
    this.joints = [];
    this.mats = new Map();
    this.geos = {};
    this.head = null;
    this.reactor = null;
    this.palms = {};
    this.rings = new Map();
    this.beams = {};
    this.energy = 0;
    this.time = 0;
    this.visible = false;
    this.#buildGeometry();
    this.#buildMaterials();
    this.#buildBody();
    this.#buildHands();
    this.#buildHead();
    this.#buildFx();
    this.setQuality(this.quality);
  }

  /* ------------------------------------------------------------- construcción */

  #buildGeometry() {
    const { THREE } = this;
    const detail = this.quality === 'bajo' ? 6 : this.quality === 'alto' ? 14 : 10;
    this.geos.bone = new THREE.CylinderGeometry(0.5, 0.5, 1, detail, 1, true);
    this.geos.joint = new THREE.SphereGeometry(0.5, detail, Math.max(6, detail - 2));
    this.geos.palm = new THREE.BoxGeometry(1, 0.42, 1);
    this.geos.helmet = new THREE.SphereGeometry(0.5, detail + 6, detail + 2, 0, Math.PI * 2, 0, Math.PI * 0.62);
    this.geos.visor = new THREE.SphereGeometry(0.5, detail + 4, 6, -0.75, 1.5, Math.PI * 0.3, Math.PI * 0.26);
    this.geos.eye = new THREE.SphereGeometry(0.5, 10, 8);
    this.geos.ring = new THREE.TorusGeometry(0.5, 0.11, 6, detail + 10);
    this.geos.reactor = new THREE.TorusGeometry(0.5, 0.16, 8, 24);
    this.geos.disc = new THREE.CircleGeometry(0.42, 24);
    this.geos.spike = new THREE.ConeGeometry(0.5, 1, detail);
    this.geos.beam = new THREE.CylinderGeometry(0.05, 0.5, 1, 8, 1, true);
  }

  #buildMaterials() {
    const { THREE } = this;
    for (const part of [...BODY_PARTS.map((p) => p.id), 'cuello']) {
      const group = PART_GROUP[part] || 'torso';
      const base = {
        metalness: 1,
        roughness: group === 'head' ? 0.22 : 0.34,
        color: new THREE.Color(group === 'handL' || group === 'handR' ? 0x9fb2c4 : 0x8f9faf),
        emissive: new THREE.Color(CONFIG.robotize.colors.accent),
        emissiveIntensity: 0.22,
        envMap: this.env,
        envMapIntensity: 1.25,
      };
      this.mats.set(part, new THREE.MeshStandardMaterial(base));
    }
    this.mats.set('accent', new THREE.MeshStandardMaterial({ color: 0x223038, metalness: 1, roughness: 0.28, emissive: new THREE.Color(CONFIG.robotize.colors.accent), emissiveIntensity: 1.4, envMap: this.env }));
    this.mats.set('glow', new THREE.MeshBasicMaterial({ color: CONFIG.robotize.colors.accent, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.mats.set('glowWarn', new THREE.MeshBasicMaterial({ color: CONFIG.robotize.colors.warn, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.mats.set('dark', new THREE.MeshStandardMaterial({ color: 0x141a20, metalness: 0.85, roughness: 0.62, envMap: this.env }));
  }

  mat(part) { return this.mats.get(part) || this.mats.get('torso'); }

  #boneMesh(part) {
    const { THREE } = this;
    const m = new THREE.Mesh(this.geos.bone, this.mat(part));
    m.castShadow = false;
    m.receiveShadow = false;
    return m;
  }

  #buildBody() {
    const { THREE } = this;
    for (const [a, b, part, w] of BODY_BONES) {
      const mesh = this.#boneMesh(part);
      this.groupBody.add(mesh);
      const bone = { a, b, part, width: w, mesh, len: 1 };
      this.bones.push(bone);
    }
    for (const name of KEY_JOINTS) {
      const mesh = new THREE.Mesh(this.geos.joint, this.mats.get('accent'));
      this.groupBody.add(mesh);
      this.joints.push({ name, mesh });
    }
    // Columna de servo + placa dorsal.
    this.spine = [];
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(this.geos.palm, this.mats.get('dark'));
      this.groupBody.add(m);
      this.spine.push(m);
    }
    // Placas de hombro.
    this.shoulders = {};
    for (const side of ['l', 'r']) {
      const m = new THREE.Mesh(this.geos.palm, this.mat(side === 'l' ? 'brazo_izq' : 'brazo_der'));
      this.groupBody.add(m);
      this.shoulders[side] = m;
    }
  }

  #buildHands() {
    this.hands = {};
    for (const side of ['Left', 'Right']) {
      const part = side === 'Left' ? 'mano_izq' : 'mano_der';
      const g = new THREE.Group();
      this.groupHands.add(g);
      const bones = [];
      for (const [a, b] of HAND_CONNECTIONS) {
        const mesh = this.#boneMesh(part);
        g.add(mesh);
        bones.push({ a, b, mesh, part });
      }
      const palm = new THREE.Mesh(this.geos.palm, this.mats.get('dark'));
      g.add(palm);
      const knuckles = [];
      for (let i = 0; i < 5; i++) {
        const m = new THREE.Mesh(this.geos.joint, this.mats.get('accent'));
        g.add(m);
        knuckles.push(m);
      }
      const nails = [];
      for (let i = 0; i < 5; i++) {
        const m = new THREE.Mesh(this.geos.spike, this.mat(part));
        g.add(m);
        nails.push(m);
      }
      // Haz de sujeción (aparece al hacer la pinza).
      const beam = new THREE.Mesh(this.geos.beam, this.mats.get('glow'));
      beam.visible = false;
      this.groupFx.add(beam);
      this.beams[side] = beam;
      this.hands[side] = { g, bones, palm, knuckles, nails, part, beam };
    }
  }

  #buildHead() {
    const { THREE } = this;
    const g = new THREE.Group();
    const helmet = new THREE.Mesh(this.geos.helmet, this.mat('cabeza'));
    const visor = new THREE.Mesh(this.geos.visor, this.mats.get('glow'));
    const eyes = [];
    for (let i = 0; i < 2; i++) {
      const e = new THREE.Mesh(this.geos.eye, this.mats.get('glow'));
      g.add(e);
      eyes.push(e);
    }
    const antenna = new THREE.Mesh(this.geos.bone, this.mats.get('dark'));
    const tip = new THREE.Mesh(this.geos.eye, this.mats.get('glowWarn'));
    g.add(helmet, visor, antenna, tip);
    this.groupBody.add(g);
    this.head = { g, helmet, visor, eyes, antenna, tip };
  }

  #buildFx() {
    const { THREE } = this;
    const g = new THREE.Group();
    this.reactor = {
      ring: new THREE.Mesh(this.geos.reactor, this.mats.get('glow')),
      disc: new THREE.Mesh(this.geos.disc, this.mats.get('glow')),
    };
    g.add(this.reactor.ring, this.reactor.disc);
    this.groupFx.add(g);
    this.reactor.group = g;

    // Anillos de mejora por parte (nivel 1..4).
    for (const part of BODY_PARTS) {
      const arr = [];
      for (let i = 0; i < CONFIG.game.maxPartLevel; i++) {
        const m = new THREE.Mesh(this.geos.ring, this.mats.get(i >= 3 ? 'glowWarn' : 'glow'));
        m.visible = false;
        this.groupFx.add(m);
        arr.push(m);
      }
      this.rings.set(part.id, arr);
    }
  }

  /* ------------------------------------------------------------------ ajustes */

  setQuality(q) {
    this.quality = q;
    const legs = q !== 'bajo';
    for (const b of this.bones) {
      if (/pierna/.test(b.part)) b.mesh.visible = legs;
    }
    for (const h of Object.values(this.hands || {})) {
      for (const m of h.nails) m.visible = q === 'alto';
    }
    for (const j of this.joints) if (/knee|ankle/.test(j.name)) j.mesh.visible = legs;
  }

  setVisible(v) {
    this.visible = !!v;
    this.root.visible = this.visible;
  }

  dispose() {
    for (const g of Object.values(this.geos)) g.dispose?.();
    for (const m of this.mats.values()) m.dispose?.();
  }

  /* -------------------------------------------------------------------- frame */

  /**
   * @param {{joints:Object, hands:Object, face?:Array, parts:Object, head?:Object}} skel
   *        joints/hands en el espacio de origen del modo actual.
   * @param {{toRender:(p:any,out?:any)=>any, radiusAt:(p:any,r:number)=>number, dt:number,
   *          energy?:number, glitch?:number, levels?:Object, pulse?:number}} opts
   */
  update(skel, opts = {}) {
    const THREE = this.THREE;
    const toR = opts.toRender || ((p, o) => Object.assign(o || { x: 0, y: 0, z: 0 }, p));
    const rad = opts.radiusAt || ((p, r) => r);
    const dt = opts.dt ?? 0.016;
    this.time += dt;
    this.energy = damp(this.energy, opts.energy ?? 0, 6, dt);
    const levels = opts.levels || {};
    if (!skel?.joints) { this.setVisible(false); return; }

    const J = skel.joints;
    const tmpA = {}, tmpB = {}, mid = {}, dir = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion();
    const v3 = (p) => toR(p, tmpA);
    const bodyVisible = !!J.l_shoulder || !!J.nose;
    this.setVisible(bodyVisible || !!skel.hands?.Left || !!skel.hands?.Right);
    if (!this.visible) return;

    // --- Huesos del cuerpo
    const baseScale = this.#bodyScale(J, toR);
    for (const b of this.bones) {
      const pa = J[b.a], pb = J[b.b];
      const mesh = b.mesh;
      if (!pa || !pb) { mesh.visible = false; continue; }
      mesh.visible = true;
      const A = toR(pa, tmpA), B = toR(pb, tmpB);
      dir.set(B.x - A.x, B.y - A.y, B.z - A.z);
      const len = dir.length() || 1e-4;
      const r = Math.max(0.004, rad(pa, baseScale * 0.075 * b.width));
      mesh.position.set((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
      q.setFromUnitVectors(up, dir.normalize());
      mesh.quaternion.copy(q);
      mesh.scale.set(r * 2, len, r * 2);
    }

    // --- Articulaciones
    for (const j of this.joints) {
      const p = J[j.name];
      if (!p) { j.mesh.visible = false; continue; }
      j.mesh.visible = true;
      const P = toR(p, mid);
      const r = Math.max(0.006, rad(p, baseScale * 0.085));
      j.mesh.position.set(P.x, P.y, P.z);
      j.mesh.scale.setScalar(r * 2);
    }

    // --- Columna y hombreras
    const shC = J.l_shoulder && J.r_shoulder ? avg3(toR(J.l_shoulder, {}), toR(J.r_shoulder, {})) : null;
    const hipC = J.l_hip && J.r_hip ? avg3(toR(J.l_hip, {}), toR(J.r_hip, {})) : null;
    if (shC && hipC) {
      for (let i = 0; i < this.spine.length; i++) {
        const t = i / (this.spine.length - 1);
        const m = this.spine[i];
        m.position.set(lerp(shC.x, hipC.x, t), lerp(shC.y, hipC.y, t), lerp(shC.z, hipC.z, t) - baseScale * 0.06);
        const w = baseScale * (0.11 + 0.02 * i);
        m.scale.set(w, baseScale * 0.055, w * 0.55);
        m.rotation.set(0, 0, 0);
      }
      for (const side of ['l', 'r']) {
        const p = J[`${side}_shoulder`];
        if (!p) continue;
        const P = toR(p, mid);
        const m = this.shoulders[side];
        m.position.set(P.x + (side === 'l' ? -1 : 1) * baseScale * 0.03, P.y + baseScale * 0.02, P.z);
        const w = baseScale * 0.13;
        m.scale.set(w, w * 0.28, w * 0.75);
        m.rotation.set(0, 0, (side === 'l' ? 1 : -1) * 0.28);
      }
    }

    // --- Reactor pectoral
    if (shC && hipC && this.reactor) {
      const g = this.reactor.group;
      const cx = shC.x * 0.65 + hipC.x * 0.35, cy = shC.y * 0.6 + hipC.y * 0.4;
      g.position.set(cx, cy, Math.max(shC.z, hipC.z) + baseScale * 0.10);
      const pulse = 1 + Math.sin(this.time * 6 + (opts.pulse || 0)) * 0.06 * (1 + this.energy * 3);
      const w = baseScale * 0.15 * pulse;
      this.reactor.ring.scale.set(w, w, w);
      this.reactor.disc.scale.setScalar(w * 0.9);
      this.reactor.ring.rotation.x = Math.PI / 2 - 0.35;
      this.reactor.ring.rotation.z = this.time * (0.6 + this.energy);
      this.reactor.disc.rotation.set(0, 0, 0);
      g.visible = !!J.l_shoulder;
      const em = 0.9 + this.energy * 2.6 + (opts.glitch || 0) * 1.5;
      this.mats.get('glow').opacity = clamp(0.35 + this.energy * 0.55, 0.25, 0.95);
      this.mats.get('accent').emissiveIntensity = clamp(em, 0.4, 4.5);
    }

    // --- Cabeza
    if (this.head) {
      const nose = J.nose;
      const sh = shC;
      const headVisible = !!nose && !!sh;
      this.head.g.visible = headVisible;
      if (headVisible) {
        const N = toR(nose, mid);
        const faceR = skel.head?.radius ? toR({ x: N.x, y: N.y, z: N.z }, {}) : null;
        void faceR;
        const r = Math.max(0.02, baseScale * 0.19);
        this.head.g.position.set(N.x, N.y + r * 0.35, N.z);
        // Orientación: inclinación según la línea de hombros y giro según la nariz.
        let roll = 0, yaw = 0;
        if (J.l_shoulder && J.r_shoulder) {
          const A = toR(J.l_shoulder, {}), B = toR(J.r_shoulder, {});
          roll = Math.atan2(B.y - A.y, B.x - A.x);
        }
        if (J.l_ear && J.r_ear) {
          const A = toR(J.l_ear, {}), B = toR(J.r_ear, {});
          yaw = clamp(Math.atan2(B.z - A.z, B.x - A.x), -0.8, 0.8);
        }
        this.head.g.rotation.set(clamp((nose.y - (sh?.y ?? nose.y)) * 0.6, -0.5, 0.5), yaw, roll * 0.55);
        this.head.g.scale.setScalar(r * 2);
        const eyeOn = 0.55 + 0.45 * Math.sin(this.time * 3) + this.energy;
        for (let i = 0; i < 2; i++) {
          const e = this.head.eyes[i];
          e.position.set((i ? 1 : -1) * 0.18, 0.02, 0.42);
          e.scale.setScalar(0.075);
          e.material = i % 2 ? this.mats.get('glowWarn') : this.mats.get('glow');
          void eyeOn;
        }
        this.head.antenna.position.set(0.1, 0.42, -0.05);
        this.head.antenna.scale.set(0.02, 0.4, 0.02);
        this.head.tip.position.set(0.1, 0.62, -0.05);
        this.head.tip.scale.setScalar(0.05 + 0.01 * Math.sin(this.time * 5));
      }
    }

    // --- Manos robóticas
    for (const side of ['Left', 'Right']) {
      const h = skel.hands?.[side];
      const rigH = this.hands?.[side];
      if (!rigH) continue;
      if (!h) { rigH.g.visible = false; rigH.beam.visible = false; continue; }
      rigH.g.visible = true;
      const pts = h;
      for (const b of rigH.bones) {
        const pa = pts[b.a], pb = pts[b.b];
        if (!pa || !pb) { b.mesh.visible = false; continue; }
        const A = toR(pa, tmpA), B = toR(pb, tmpB);
        dir.set(B.x - A.x, B.y - A.y, B.z - A.z);
        const len = dir.length() || 1e-4;
        const r = Math.max(0.0035, len * 0.17);
        b.mesh.visible = true;
        b.mesh.position.set((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
        q.setFromUnitVectors(up, dir.normalize());
        b.mesh.quaternion.copy(q);
        b.mesh.scale.set(r * 2, len, r * 2);
      }
      // Palma: caja orientada por la base de los dedos.
      const palmPts = [0, 5, 9, 13, 17].map((i) => toR(pts[i], {}));
      const c = avg3(...palmPts);
      const wide = dist(palmPts[1], palmPts[4]) || baseScale * 0.1;
      const long = dist(palmPts[0], palmPts[2]) || wide;
      rigH.palm.position.set(c.x, c.y, c.z);
      rigH.palm.scale.set(wide * 0.95, long * 0.16, long * 0.9);
      rigH.palm.rotation.set(0, Math.atan2(pts[9].x - pts[0].x, -(pts[9].y - pts[0].y)) + Math.PI / 2, 0);
      for (let f = 0; f < 5; f++) {
        const mcp = toR(pts[FINGERS[f].chain[0]], {});
        const tip = toR(pts[FINGERS[f].chain[3]], {});
        const k = rigH.knuckles[f];
        k.position.set(mcp.x, mcp.y, mcp.z);
        k.scale.setScalar(Math.max(0.004, wide * 0.16));
        const n = rigH.nails[f];
        if (n.visible) {
          n.position.set(tip.x, tip.y, tip.z);
          const d = dir.set(tip.x - mcp.x, tip.y - mcp.y, tip.z - mcp.z).normalize();
          q.setFromUnitVectors(up, d);
          n.quaternion.copy(q);
          n.scale.setScalar(wide * 0.09);
        }
      }
      // Haz de agarre durante la pinza (pinch: 0 = dedos tocándose).
      const beam = rigH.beam;
      const pinch = opts.pinchByHand?.[side] ?? 1;
      const grab = clamp((0.5 - pinch) / 0.35, 0, 1);
      beam.visible = grab > 0.05;
      if (beam.visible) {
        const A = toR(pts[4], {}), B = toR(pts[8], {});
        dir.set(B.x - A.x, B.y - A.y, B.z - A.z);
        const len = dir.length() || 1e-3;
        beam.position.set((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
        q.setFromUnitVectors(up, dir.normalize());
        beam.quaternion.copy(q);
        const r = Math.max(0.006, len * (0.55 + 0.45 * grab));
        beam.scale.set(r, len * 1.6, r);
        beam.material.opacity = 0.25 + 0.6 * grab;
      }
    }

    // --- Anillos de mejora por parte conectada
    for (const [partId, arr] of this.rings) {
      const lvl = levels[partId] ?? 0;
      const anchor = this.#anchorFor(J, partId, toR, baseScale);
      for (let i = 0; i < arr.length; i++) {
        const m = arr[i];
        const on = lvl > i && !!anchor;
        m.visible = on;
        if (!on) continue;
        m.position.set(anchor.x + (i % 2 ? 1 : -1) * baseScale * 0.02 * i, anchor.y - i * baseScale * 0.035, anchor.z);
        const w = baseScale * (0.10 + 0.012 * i);
        m.scale.set(w, w, w);
        m.rotation.set(Math.PI / 2 + Math.sin(this.time * 1.4 + i) * 0.15, this.time * (0.5 + i * 0.2), 0);
      }
    }

    // Color/emisivo por nivel de la parte: el cuerpo se ve más "mejorado".
    for (const [part, m] of this.mats) {
      if (!m.emissive || part === 'accent' || part === 'dark') continue;
      const lvl = levels[part] ?? 0;
      const k = lvl / CONFIG.game.maxPartLevel;
      m.emissiveIntensity = 0.2 + k * 1.5 + this.energy * 0.8;
      m.roughness = lerp(0.36, 0.14, k);
      m.color.setRGB(lerp(0.56, 0.72, k), lerp(0.62, 0.68, k), lerp(0.68, 0.82, k));
    }
  }

  #bodyScale(J, toR) {
    if (J.l_shoulder && J.r_shoulder) {
      const A = toR(J.l_shoulder, {}), B = toR(J.r_shoulder, {});
      const w = dist(A, B);
      if (w > 1e-4) return clamp(w, 0.02, 4);
    }
    if (J.l_hip && J.r_hip) {
      const A = toR(J.l_hip, {}), B = toR(J.r_hip, {});
      const w = dist(A, B) * 1.9;
      if (w > 1e-4) return clamp(w, 0.02, 4);
    }
    return 0.4;
  }

  #anchorFor(J, partId, toR, baseScale) {
    const map = {
      cabeza: ['nose'], torso: ['l_shoulder', 'r_shoulder'],
      brazo_izq: ['l_elbow'], brazo_der: ['r_elbow'],
      pierna_izq: ['l_knee'], pierna_der: ['r_knee'],
      mano_izq: ['l_wrist'], mano_der: ['r_wrist'],
    };
    const keys = map[partId] || [];
    const pts = keys.map((k) => J[k]).filter(Boolean);
    if (!pts.length) return null;
    const p = toR(avg3(...pts), {});
    return { x: p.x, y: p.y + baseScale * 0.02, z: p.z };
  }

  /** Ráfaga de partículas al conectar un núcleo (sin sistemas externos). */
  burst(pos, color = CONFIG.robotize.colors.ok, power = 1) {
    const { THREE } = this;
    if (!this._pools) this._pools = [];
    const pool = this._pools.find((p) => !p.alive);
    const fx = pool || { points: null, alive: false, t: 0 };
    if (!fx.points) {
      const n = 34;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      const vel = [];
      for (let i = 0; i < n; i++) vel.push(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(0.35 + Math.random() * 0.75));
      geo.setAttribute('aVel', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      for (let i = 0; i < n; i++) { geo.attributes.aVel.setXYZ(i, vel[i].x, vel[i].y, vel[i].z); }
      const mat = new THREE.PointsMaterial({ color, size: 0.012, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
      fx.points = new THREE.Points(geo, mat);
      fx.points.frustumCulled = false;
      this.groupFx.add(fx.points);
      fx.vel = vel;
    }
    fx.points.visible = true;
    fx.points.position.set(pos.x, pos.y, pos.z);
    fx.points.material.color.set(color);
    fx.points.material.opacity = 1;
    fx.points.scale.setScalar(clamp(power, 0.4, 3));
    fx.alive = true;
    fx.t = 0;
    if (!pool) this._pools.push(fx);
  }

  updateFx(dt) {
    if (!this._pools) return;
    for (const fx of this._pools) {
      if (!fx.alive) continue;
      fx.t += dt;
      const k = fx.t / 0.65;
      const pos = fx.points.geometry.attributes.position;
      const n = pos.count;
      for (let i = 0; i < n; i++) {
        const v = fx.vel[i];
        pos.setXYZ(i, v.x * k, v.y * k - 0.5 * k * k * 0.35, v.z * k);
      }
      pos.needsUpdate = true;
      fx.points.material.opacity = clamp(1 - k, 0, 1);
      if (k >= 1) { fx.alive = false; fx.points.visible = false; }
    }
  }
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
function avg3(...pts) {
  const a = pts.filter(Boolean);
  if (!a.length) return { x: 0, y: 0, z: 0 };
  return { x: a.reduce((s, p) => s + p.x, 0) / a.length, y: a.reduce((s, p) => s + p.y, 0) / a.length, z: a.reduce((s, p) => s + (p.z || 0), 0) / a.length };
}

export { PART_GROUP, DEG };
export default RobotRig;
