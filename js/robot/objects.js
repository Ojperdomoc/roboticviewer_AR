/**
 * objects.js — núcleos de servo, zócalos y líneas de conexión del juego.
 *
 * Todos los objetos se construyen a partir de la lista `cores`/`sockets` que produce
 * `Play`, y de una función `toRender(p)` aportada por el modo (visor 2D o XR). Nada de
 * aquí sabe de cámaras ni de WebXR, así que el mismo visor funciona en pantalla plana,
 * en estéreo y en sesión inmersiva.
 */

import { CONFIG, PART_BY_ID } from '../config.js';

const COLORS = CONFIG.robotize.colors;

const PART_COLOR = {
  cabeza: 0x8ef0ff, torso: 0x35f0ff, brazo_izq: 0x6cff9b, brazo_der: 0x6cff9b,
  mano_izq: 0xffb03a, mano_der: 0xffb03a, pierna_izq: 0xff7ad1, pierna_der: 0xff7ad1,
};

/** Etiqueta de texto en canvas (cacheada por parte). */
function labelTexture(THREE, text, colorHex) {
  if (!labelTexture.cache) labelTexture.cache = new Map();
  const key = `${text}|${colorHex}`;
  if (labelTexture.cache.has(key)) return labelTexture.cache.get(key);
  const c = document.createElement('canvas');
  c.width = 256; c.height = 80;
  const g = c.getContext('2d');
  const col = '#' + colorHex.toString(16).padStart(6, '0');
  g.fillStyle = 'rgba(4,10,14,0.72)';
  roundRect(g, 6, 14, 244, 52, 10); g.fill();
  g.strokeStyle = col; g.lineWidth = 3;
  roundRect(g, 6, 14, 244, 52, 10); g.stroke();
  g.fillStyle = col;
  g.font = '600 30px ui-monospace, Menlo, Consolas, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(text).toUpperCase(), 128, 41);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  labelTexture.cache.set(key, tex);
  return tex;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export class CoreField {
  constructor(THREE, { env = null, labels = true } = {}) {
    this.THREE = THREE;
    this.env = env;
    this.labels = labels;
    this.group = new THREE.Group();
    this.group.name = 'cores';
    this.items = new Map();     // coreId -> {mesh, wire, sprite, line}
    this.sockets = new Map();  // "partId:name" -> {mesh}
    this.shared = {
      core: new THREE.IcosahedronGeometry(0.5, 0),
      cage: new THREE.IcosahedronGeometry(0.78, 0),
      ring: new THREE.TorusGeometry(0.62, 0.075, 6, 28),
      disc: new THREE.CircleGeometry(0.5, 26),
      line: new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    };
    this.time = 0;
  }

  #coreMats(colorHex) {
    if (!this._mats) this._mats = new Map();
    if (this._mats.has(colorHex)) return this._mats.get(colorHex);
    const THREE = this.THREE;
    const solid = new THREE.MeshStandardMaterial({ color: 0x0d151b, metalness: 1, roughness: 0.28, envMap: this.env, emissive: new THREE.Color(colorHex), emissiveIntensity: 0.65 });
    const cage = new THREE.MeshBasicMaterial({ color: colorHex, wireframe: true, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
    const out = { solid, cage };
    this._mats.set(colorHex, out);
    return out;
  }

  #make(THREE, id, core) {
    const color = PART_COLOR[core.partId] ?? COLORS.accent;
    const { solid, cage } = this.#coreMats(color);
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(this.shared.core, solid);
    const wire = new THREE.Mesh(this.shared.cage, cage);
    g.add(mesh, wire);
    let sprite = null;
    if (this.labels) {
      const label = PART_BY_ID[core.partId]?.label || core.partId;
      sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(THREE, label, color), transparent: true, depthWrite: false, opacity: 0.95 }));
      sprite.scale.set(1.5, 0.47, 1);
      sprite.position.set(0, -0.9, 0);
      g.add(sprite);
    }
    const line = new THREE.Line(this.shared.line, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
    line.visible = false;
    this.group.add(g, line);
    const item = { g, mesh, wire, sprite, line, color, core, baseSolid: solid, baseCage: cage };
    this.items.set(id, item);
    return item;
  }

  /** Sincroniza las mallas con la lista de núcleos de las reglas. */
  sync(cores, view) {
    const THREE = this.THREE;
    this.time += view.dt ?? 0.016;
    const alive = new Set();
    for (const core of cores || []) {
      alive.add(core.id);
      const item = this.items.get(core.id) || this.#make(THREE, core.id, core);
      item.core = core;
      const p = view.toRender(core, {});
      const s = view.scaleFor ? view.scaleFor(core) : 0.06;
      item.g.visible = true;
      item.g.position.set(p.x, p.y, p.z);
      const held = core.state === 'held';
      const k = (held ? 1.28 : 1) * s;
      const wob = 1 + Math.sin(this.time * 4 + core.age * 3) * 0.06;
      item.mesh.scale.setScalar(k * 2 * wob);
      item.wire.scale.setScalar(k * 2 * wob);
      item.wire.rotation.set(this.time * 0.7 + core.age, this.time * (held ? 3.2 : 1.1) + core.spin, 0);
      item.mesh.rotation.set(-this.time * 0.5, this.time * 0.8, this.time * 0.3);
      if (item.sprite) {
        item.sprite.scale.set(s * 6.2, s * 1.95, 1);
        item.sprite.position.set(0, -s * 3.4, 0);
        item.sprite.material.opacity = held ? 1 : 0.9;
      }
      // Urgencia: cuando el núcleo está por expirar, parpadea en rojo.
      const lifeLeft = core.life ? Math.max(0, 1 - core.age / core.life) : 1;
      const urgency = lifeLeft < 0.34 ? (1 - lifeLeft / 0.34) : 0;
      const danger = urgency > 0.05;
      item.mesh.material = danger ? this.#coreMats(COLORS.danger).solid : item.baseSolid;
      item.wire.material = danger ? this.#coreMats(COLORS.danger).cage : item.baseCage;
      if (item.mesh.material.emissive) item.mesh.material.emissiveIntensity = 0.5 + urgency * 2.4 + (held ? 0.6 : 0);

      // Hilo guía hacia el zócalo correcto mientras se sostiene.
      if (held && view.socketFor) {
        const target = view.socketFor(core.partId);
        if (target) {
          const a = item.g.position;
          const b = view.toRender(target, {});
          const pos = item.line.geometry.attributes.position;
          pos.setXYZ(0, a.x, a.y, a.z);
          pos.setXYZ(1, b.x, b.y, b.z);
          pos.needsUpdate = true;
          item.line.visible = true;
          item.line.geometry.computeBoundingSphere();
        } else item.line.visible = false;
      } else item.line.visible = false;
    }
    for (const [id, item] of this.items) {
      if (alive.has(id)) continue;
      item.g.visible = false;
      item.line.visible = false;
      this.items.delete(id);
    }
  }

  /** Anillos de zócalo sobre las partes del cuerpo. */
  syncSockets(sockets, view) {
    if (!this._socketGroup) {
      this._socketGroup = new THREE.Group();
      this.group.add(this._socketGroup);
    }
    const THREE = this.THREE;
    const seen = new Set();
    for (const sk of sockets || []) {
      const key = `${sk.partId}:${sk.name}`;
      seen.add(key);
      let item = this.socketCache?.get(key);
      if (!item) {
        const mat = new THREE.MeshBasicMaterial({ color: sk.human ? COLORS.warn : COLORS.danger, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
        const ring = new THREE.Mesh(this.shared.ring, mat);
        const disc = new THREE.Mesh(this.shared.disc, new THREE.MeshBasicMaterial({ color: sk.human ? COLORS.accent : COLORS.danger, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        item = { ring, disc, mat };
        this._socketGroup.add(ring, disc);
        (this.socketCache ||= new Map()).set(key, item);
      }
      const p = view.toRender(sk, {});
      const s = (view.scaleFor ? view.scaleFor(sk) : 0.05) * (sk.hover ? 1.5 : 1);
      const pulse = 1 + Math.sin(this.time * 3 + (sk.level || 0)) * 0.08;
      item.ring.visible = item.disc.visible = !!sk.visible;
      item.ring.position.set(p.x, p.y, p.z);
      item.disc.position.set(p.x, p.y, p.z);
      item.ring.scale.setScalar(s * 2.1 * pulse);
      item.disc.scale.setScalar(s * 1.7);
      item.ring.rotation.set(Math.PI / 2, 0, this.time * (sk.hover ? 2.6 : 0.5));
      item.mat.color.set(!sk.human ? COLORS.danger : sk.hover ? COLORS.ok : sk.match ? COLORS.accent : COLORS.warn);
      item.mat.opacity = sk.hover ? 0.98 : 0.55 + 0.2 * Math.sin(this.time * 4);
    }
    for (const [key, item] of this.socketCache || []) {
      if (seen.has(key)) continue;
      item.ring.visible = item.disc.visible = false;
    }
  }

  dispose() {
    for (const g of Object.values(this.shared)) g.dispose?.();
    for (const item of this.items.values()) { item.g.removeFromParent(); item.line.removeFromParent(); }
    for (const m of this._mats?.values() || []) { m.solid.dispose(); m.cage.dispose(); }
    for (const i of this.socketCache?.values() || []) { i.ring.material.dispose(); i.disc.material.dispose(); }
  }
}

export { PART_COLOR };
