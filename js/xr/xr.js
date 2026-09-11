/**
 * xr.js — realidad extendida y modo gafas.
 *
 * Tres rutas, de mejor a más compatible:
 *  1. `immersive-ar` (WebXR): el teléfono muestra la cámara REAL como fondo (passthrough
 *     de ARCore) y ancla el cuerpo robótico al mundo. Es la experiencia "AR de verdad".
 *  2. `immersive-vr` (gafas/webxr compatible): sala holográfica + cuerpo robótico.
 *  3. **Modo gafas (estéreo)**: si el navegador no tiene WebXR, partimos la pantalla en
 *     dos ojos con `StereoCamera` y usamos el giroscopio como cabezal. Funciona con
 *     Google Cardboard / gafas VR de cartón y en cualquier Android con Chrome.
 *
 * Todo lo de aquí devuelve transformaciones; quien decide cómo dibujar es `game.js`.
 */

export class XRManager {
  /** @param {object} opts {THREE, renderer, overlayRoot} */
  constructor(opts) {
    this.THREE = opts.THREE;
    this.renderer = opts.renderer;
    this.overlayRoot = opts.overlayRoot || null;
    this.session = null;
    this.kind = null;         // 'ar' | 'vr'
    this.caps = { xr: false, ar: false, vr: false, checked: false };
    this._onSelect = new Set();
    this._onEnd = new Set();
    this._controllers = [];
  }

  get presenting() { return !!this.session; }

  async probe() {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    this.caps.xr = !!(nav?.xr);
    try {
      if (nav?.xr) {
        this.caps.ar = await nav.xr.isSessionSupported('immersive-ar').catch(() => false);
        this.caps.vr = await nav.xr.isSessionSupported('immersive-vr').catch(() => false);
      }
    } catch { /* navegadores sin xr */ }
    this.caps.checked = true;
    return this.caps;
  }

  /** @param {'ar'|'vr'} kind */
  async enter(kind = 'ar') {
    if (!this.caps.xr) throw new Error('Este navegador no soporta WebXR (navigator.xr ausente).');
    const THREE = this.THREE;
    const mode = kind === 'vr' ? 'immersive-vr' : 'immersive-ar';
    const optional = ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'];
    if (mode === 'immersive-ar' && this.overlayRoot) optional.push('dom-overlay', 'hit-test');
    const init = {
      optionalFeatures: optional,
      ...(mode === 'immersive-ar' && this.overlayRoot ? { domOverlay: { root: this.overlayRoot } } : {}),
    };
    const session = await navigator.xr.requestSession(mode, init);
    this.kind = kind === 'vr' ? 'vr' : 'ar';
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType(kind === 'vr' ? 'local-floor' : 'local-floor');
    await this.renderer.xr.setSession(session);
    this.session = session;

    // "Select" (pantallazo en el teléfono, gatillo en gafas) = pinchar/agarrar.
    for (let i = 0; i < 2; i++) {
      const c = this.renderer.xr.getController(i);
      c.userData.index = i;
      c.addEventListener('selectstart', (e) => this.#fire('selectstart', e, i));
      c.addEventListener('selectend', (e) => this.#fire('selectend', e, i));
      c.addEventListener('connected', (e) => { c.userData.source = e.data; });
      session.addEventListener?.('inputsourceschange', () => {});
      this._controllers.push(c);
    }
    session.addEventListener('end', () => this.#onEnd());
    return session;
  }

  #fire(type, event, index) {
    for (const fn of this._onSelect) fn({ type, index, event });
  }

  onSelect(fn) { this._onSelect.add(fn); return () => this._onSelect.delete(fn); }

  /** Aviso de fin de sesión (incluye la que cierra el sistema, no sólo nuestro botón). */
  onEnd(fn) { this._onEnd.add(fn); return () => this._onEnd.delete(fn); }

  #onEnd() {
    this.session = null;
    this.kind = null;
    this.renderer.xr.enabled = false;
    for (const c of this._controllers) { try { this.renderer.xr.getController(c.userData.index)?.clearEventListeners?.(); } catch { /* noop */ } }
    this._controllers = [];
    for (const fn of this._onEnd) { try { fn(); } catch { /* noop */ } }
  }

  async exit() {
    if (this.session) { try { await this.session.end(); } catch { /* ya cerrada */ } }
    this.#onEnd();
  }

  /**
   * Dónde debe montarse el cuerpo robótico al entrar en RA/VR: delante del usuario, a la
   * altura del pecho. Devuelve {x,y,z,yaw,distance,chestHeight} para que game.js ancle la jerarquía.
   */
  anchorFromBody(camera, { distance = 0.42, chestHeight = 1.15 } = {}) {
    const THREE = this.THREE;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const pos = new THREE.Vector3(camera.position.x, 0, camera.position.z).addScaledVector(fwd, distance);
    const yaw = Math.atan2(fwd.x, fwd.z);
    if (this.kind === 'ar') pos.y = Math.min(0, chestHeight - camera.position.y);
    return { x: pos.x, y: pos.y, z: pos.z, yaw, distance, chestHeight };
  }

  /** Raycaster por controlador/gaze para seleccionar núcleos sin cámara. */
  pickRay(out = { origin: null, direction: null }) {
    const THREE = this.THREE;
    const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : null;
    if (!cam) return null;
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    cam.getWorldPosition(p);
    cam.getWorldQuaternion(q);
    return { origin: p, direction: new THREE.Vector3(0, 0, -1).applyQuaternion(q) };
  }
}

/** Control de cabezal con el giroscopio (fallback del modo gafas). */
export class OrientationPose {
  constructor(THREE) {
    this.THREE = THREE;
    this.quaternion = new THREE.Quaternion();
    this.enabled = false;
    this._q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
    this._zee = new THREE.Vector3(0, 0, 1);
    this._euler = new THREE.Euler();
    this._q0 = new THREE.Quaternion();
    this._screen = (screen && screen.orientation && screen.orientation.angle) || window.orientation || 0;
    this._onOrient = (e) => {
      if (e.alpha == null || e.beta == null || e.gamma == null) return;
      this.raw = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
      this.enabled = true;
    };
    this._onScreen = () => { this._screen = (screen && screen.orientation && screen.orientation.angle) || window.orientation || 0; };
  }

  /** iOS exige permiso desde un gesto del usuario. */
  static async request() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        return r === 'granted';
      }
      return typeof DeviceOrientationEvent !== 'undefined';
    } catch { return false; }
  }

  start() {
    if (this._started) return true;
    this._started = true;
    window.addEventListener('deviceorientation', this._onOrient, true);
    window.addEventListener('orientationchange', this._onScreen, true);
    return true;
  }

  stop() {
    this._started = false;
    this.enabled = false;
    window.removeEventListener('deviceorientation', this._onOrient, true);
    window.removeEventListener('orientationchange', this._onScreen, true);
  }

  update() {
    if (!this.raw) return this.quaternion;
    const { alpha, beta, gamma } = this.raw;
    const deg = Math.PI / 180;
    this._euler.set(beta * deg, alpha * deg, -gamma * deg, 'YXZ');
    this.quaternion.setFromEuler(this._euler);
    this.quaternion.multiply(this._q1);
    this.quaternion.multiply(this._q0.setFromAxisAngle(this._zee, -(this._screen || 0) * deg));
    return this.quaternion;
  }
}

/** Render estéreo para gafas (Cardboard): dos viewports + separación interpupilar. */
export class Glasses {
  constructor(THREE, renderer, { ipd = 0.064 } = {}) {
    this.THREE = THREE;
    this.renderer = renderer;
    this.enabled = false;
    this.ipd = ipd;
    this.stereo = new THREE.StereoCamera();
    this.stereo.ipd = ipd;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) {
      this.renderer.setScissorTest(false);
      this.renderer.setScissor(0, 0, 0, 0);
      this.renderer.setViewport(0, 0, 0, 0);
      this.renderer.resetState?.();
    }
  }

  /** Reemplaza el render normal: dibuja ojo izquierdo y derecho lado a lado. */
  render(scene, camera) {
    const THREE = this.THREE;
    const r = this.renderer;
    const size = new THREE.Vector2();
    r.getSize(size);
    const w = Math.floor(size.x / 2), h = size.y;
    this.stereo.update(camera);
    r.autoClear = false;

    // Ojo izquierdo
    r.setScissorTest(true);
    r.setViewport(0, 0, w, h);
    r.setScissor(0, 0, w, h);
    r.render(scene, this.stereo.cameraL);

    // Ojo derecho
    r.setViewport(w, 0, size.x - w, h);
    r.setScissor(w, 0, size.x - w, h);
    r.render(scene, this.stereo.cameraR);

    r.setScissorTest(false);
    r.setViewport(0, 0, size.x, size.y);
    r.autoClear = true;
  }
}

export default XRManager;
