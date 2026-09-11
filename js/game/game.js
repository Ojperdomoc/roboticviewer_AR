/**
 * game.js — orquestador: cámara → percepción → reglas → rig robótico → HUD.
 *
 * Dos espacios, siempre:
 *  - `image`: puntos (x,y,z) del cuadro de la cámara (x/y en 0..1, z profundidad relativa).
 *    Es el espacio del JUGADOR: Rules/Play viven aquí, así el visor 2D, el modo gafas y
 *    WebXR comparten exactamente la misma lógica de juego.
 *  - `render`: lo que ve three.js. `view.toRender(p)` traduce image→render
 *    (proyección del visor, o metros en XR/gafas).
 *
 * Modos:
 *  visor  → video a pantalla completa + rig proyectado encima (2D, cualquier celular).
 *  ar     → WebXR immersive-ar: la cámara real la entrega el sistema y el cuerpo
 *            robótico se ancla delante de ti.
 *  vr     → WebXR immersive-vr: sala holográfica + cuerpo robótico.
 *  gafas  → estéreo Cardboard con giroscopio: el video robotizado flota como pantalla y
 *            el cuerpo sale de ella hacia ti.
 *
 * La percepción corre a su propio ritmo (`#perceive`, sin await en el loop de render)
 * para que el dibujado mantenga 60 fps aunque MediaPipe tarde 35 ms.
 */

import { CONFIG, BODY_PARTS, PART_BY_ID } from '../config.js';
import { buildBody, handState, socketsFor } from '../track/parts.js';
import { GestureTracker } from '../track/gestures.js';
import { Rules, PHASE } from './rules.js';
import { Play } from './play.js';
import { MaskBuilder } from '../robot/mask.js';
import { Compositor } from '../robot/compositor.js';
import { RobotRig } from '../robot/rig.js';
import { CoreField } from '../robot/objects.js';
import { studioEnv, holoRoom } from '../robot/envmap.js';
import { VisorProjector, coverFactors } from '../robot/project.js';
import { XRManager, OrientationPose, Glasses } from '../xr/xr.js';
import { SimBody } from '../sim.js';
import { clamp, damp, lerp, store } from '../util.js';

export const MODES = { VISOR: 'visor', AR: 'ar', VR: 'vr', GLASSES: 'gafas' };

/** En modos métricos: cuánto vale (en metros) una unidad del cuadro de cámara. */
const METRIC = { kx: 0.62, ky: 0.82, kz: 0.4, forward: 0.42 };

export class RoboGame {
  /**
   * @param {{THREE:any, canvas:HTMLCanvasElement, video:HTMLVideoElement, overlay:HTMLElement,
   *          ui:Object, sfx:Object, tracker:Object, cam:Object, quality?:string}} deps
   */
  constructor(deps) {
    this.THREE = deps.THREE;
    this.canvas = deps.canvas;
    this.video = deps.video;
    this.overlay = deps.overlay;
    this.ui = deps.ui;
    this.sfx = deps.sfx;
    this.tracker = deps.tracker;
    this.cam = deps.cam;
    this.quality = deps.quality || 'medio';

    this.mode = MODES.VISOR;
    this.running = false;
    this.paused = false;
    this.t = 0;
    this.frames = 0;
    this.fps = 60;
    this.energy = 0;
    this.glitch = 0;
    this.alterStrength = 1;
    this.haptics = true;

    this.sim = null;
    this.lastFrame = null;
    this._perceiving = false;
    this._perceiveEvery = 1;
    this.pointer = { active: false, x: 0.5, y: 0.5, down: false };
    this.body = buildBody({});
  }

  /* ------------------------------------------------------------- construcción */

  async init() {
    const THREE = this.THREE;
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.quality !== 'bajo',
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x05080b, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CONFIG.visor.fov, 1, 0.01, 80);
    this.camera.position.set(0, 0, CONFIG.visor.depthPlane);

    this.bodyRoot = new THREE.Group();
    this.scene.add(this.bodyRoot);

    this.hemi = new THREE.HemisphereLight(0x9fd8ff, 0x0a1218, 1.2);
    this.key = new THREE.DirectionalLight(0xdff4ff, 2.2);
    this.key.position.set(1.2, 2.4, 2.2);
    this.rim = new THREE.DirectionalLight(0xffb03a, 1.3);
    this.rim.position.set(-1.8, 0.6, -1.4);
    this.scene.add(this.hemi, this.key, this.rim);

    this.env = studioEnv(THREE, this.renderer);
    if (this.env) this.scene.environment = this.env;

    this.mask = new MaskBuilder(this.quality === 'bajo' ? 288 : CONFIG.robotize.maskWidth);
    this.compositor = new Compositor(THREE, { maskCanvas: this.mask.canvas, videoEl: this.video });
    this.projector = new VisorProjector({ fov: CONFIG.visor.fov, depthPlane: CONFIG.visor.depthPlane });

    this.rig = new RobotRig(THREE, { quality: this.quality, env: this.env });
    this.bodyRoot.add(this.rig.root);
    this.cores = new CoreField(THREE, { env: this.env, labels: this.quality !== 'bajo' });
    this.bodyRoot.add(this.cores.group);

    this.room = holoRoom(THREE);
    this.scene.add(this.room.group);
    this.room.group.visible = false;

    // "Pantalla" flotante del modo gafas: muestra el video ya robotizado.
    this.rt = new THREE.WebGLRenderTarget(1024, 576, { depthBuffer: false });
    this.screen = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.07), new THREE.MeshBasicMaterial({ map: this.rt.texture, toneMapped: false }));
    this.screen.position.set(0, 0.06, -1.3);
    this.screen.visible = false;
    this.scene.add(this.screen);

    this.best = store.get(CONFIG.storageKeys.best, 0) || 0;
    this.rules = new Rules({ ...CONFIG.game }, { seed: (Date.now() % 100000) | 0 });
    this.rules.state.best = this.best;
    this.play = new Play(this.rules, { ...CONFIG.visor });
    this.gestures = new GestureTracker({ holdMs: 170, cooldownMs: 460 });

    this.xr = new XRManager(THREE, { renderer: this.renderer, overlayRoot: this.overlay });
    this.glasses = new Glasses(THREE, this.renderer);
    this.pose = new OrientationPose(THREE);

    this._view = this.#makeVisorView(0.016);
    this.#bindEvents();
    this.#resize();
    return this;
  }

  #bindEvents() {
    this._off = [];
    const on = (t, f, o, c) => { (t || window).addEventListener(f, o, c); return () => (t || window).removeEventListener(f, o, c); };
    this._off.push(on(window, 'resize', () => this.#resize()));
    this._off.push(on(window, 'orientationchange', () => setTimeout(() => this.#resize(), 250)));
    this._off.push(on(document, 'visibilitychange', () => {
      if (document.hidden && this.autoPause !== false) this.pause();
      this.ui?.onVisibility?.(!document.hidden);
    }));
    this.#bindPointer();
    if (this.xr.onSelect) this._off.push(this.xr.onSelect((e) => this.#xrSelect(e)));
    // Si el sistema cierra la sesión (botón del visor, "atrás" en Android) hay que volver
    // al visor 2D: si no, el render seguiría asumiendo una cámara XR que ya no existe.
    if (this.xr.onEnd) {
      const off = this.xr.onEnd(() => {
        if (this._switching) return;                       // lo cerramos nosotros desde setMode()
        if (this.mode !== MODES.AR && this.mode !== MODES.VR) return;
        this.ui?.toast?.('Sesión inmersiva terminada — volviste al visor', 'info');
        this.setMode(MODES.VISOR).catch(() => { /* ya estamos en visor */ });
      });
      if (typeof off === 'function') this._off.push(off);
    }
  }

  /** Puntero/teclado: permite jugar sin cámara y sirve de "mano derecha" de reserva. */
  #bindPointer() {
    const el = this.canvas;
    const set = (ev) => {
      const r = el.getBoundingClientRect();
      const cx = ev.touches?.[0]?.clientX ?? ev.clientX ?? 0;
      const cy = ev.touches?.[0]?.clientY ?? ev.clientY ?? 0;
      this.pointer.x = clamp((cx - r.left) / Math.max(1, r.width), 0, 1);
      this.pointer.y = clamp((cy - r.top) / Math.max(1, r.height), 0, 1);
    };
    const down = (ev) => { set(ev); this.pointer.down = true; this.pointer.active = true; this.ui?.onPointerActive?.(); };
    const move = (ev) => { set(ev); };
    const up = () => { this.pointer.down = false; };
    this._off.push(on(el, 'pointerdown', down), on(el, 'pointermove', move), on(window, 'pointerup', up));
    this._off.push(on(el, 'touchstart', down, { passive: true }), on(el, 'touchmove', move, { passive: true }), on(window, 'touchend', up));
  }

  #resize() {
    if (!this.renderer) return;
    const THREE = this.THREE;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, false);
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    this.vw = size.x; this.vh = size.y;
    this.camera.aspect = w / Math.max(1, h);
    this.camera.fov = this.isMetric ? 62 : CONFIG.visor.fov;
    this.camera.updateProjectionMatrix();

    const vs = this.cam?.size || { w: 1280, h: 720 };
    this.videoSize = vs;
    this.projector.setScreenSize(w, h);
    this.projector.setVideoSize(vs.w, vs.h);
    const { xF, yF } = coverFactors(vs.w, vs.h, w, h);
    this.crop = [1 / xF, 1 / yF];
    this.mask.setSize(vs.w, vs.h);
    this.compositor.update({ crop: this.crop, res: [size.x, size.y] });
    this.rt?.setSize(this.quality === 'bajo' ? 768 : 1024, Math.round((this.quality === 'bajo' ? 768 : 1024) * (h / Math.max(1, w))));
  }

  /* --------------------------------------------------------------------- modo */

  get isMetric() { return this.mode !== MODES.VISOR; }

  /** @param {'visor'|'ar'|'vr'|'gafas'} mode */
  async setMode(mode) {
    const THREE = this.THREE;
    if (mode === this.mode) return this.mode;
    this._switching = true;
    try {
      if (this.xr.presenting) await this.xr.exit().catch(() => {});
    } finally { this._switching = false; }
    this.glasses.setEnabled(false);
    this.pose.stop();
    this.mode = mode;
    this._bodyAnchored = false;

    const metric = mode !== MODES.VISOR;
    this.room.group.visible = metric;
    this.screen.visible = mode === MODES.GLASSES;
    this.scene.fog = metric ? new THREE.FogExp2(0x081016, 0.06) : null;
    this.camera.fov = metric ? 62 : CONFIG.visor.fov;
    this.camera.updateProjectionMatrix();

    if (mode === MODES.AR || mode === MODES.VR) {
      await this.xr.enter(mode === MODES.AR ? 'ar' : 'vr');
      this.renderer.setAnimationLoop((time, frame) => this.#loop(time, frame));
    } else if (mode === MODES.GLASSES) {
      const ok = await OrientationPose.request();
      this.ui?.onGyro?.(ok);
      this.pose.start();
      this.glasses.setEnabled(true);
      this.renderer.setAnimationLoop((time) => this.#loop(time, null));
    } else {
      this.renderer.setAnimationLoop((time) => this.#loop(time, null));
    }
    this.#resize();
    this.running = true;
    this.ui?.onMode?.(mode);
    return this.mode;
  }

  /* -------------------------------------------------------------------- ciclo */

  start() {
    this._overSent = false;
    this.rules.start(this.best);
    this.running = true;
    this.paused = false;
    this.sfx.hum(true);
    this.ui?.onPhase?.('play');
    if (!this._looping) {
      this._looping = true;
      this.renderer.setAnimationLoop((time, frame) => this.#loop(time, frame));
    }
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.rules.pause();
    this.sfx.hum(false);
    this.ui?.onPhase?.('paused');
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.rules.resume();
    this.sfx.hum(true);
    this.ui?.onPhase?.('play');
  }

  stop() {
    this.running = false;
    this._looping = false;
    this.renderer?.setAnimationLoop(null);
    this.sfx.hum(false);
  }

  /** Cuerpo sintético: demo, pruebas y dispositivos sin cámara. */
  useDemoBody(on) {
    this.sim = on ? new SimBody({ face: this.quality !== 'bajo' }) : null;
    if (!on) this.lastFrame = null;
    return this.sim;
  }

  #loop(timeMs, xrFrame) {
    const dt = this._last == null ? 0.016 : clamp((timeMs - this._last) / 1000, 0.001, 0.08);
    this._last = timeMs;
    this.t += dt;
    this.frames++;
    try {
      this.#step(dt, this.t, xrFrame);
    } catch (err) {
      console.error('[loop]', err);
      this.ui?.onFatal?.(err);
      this.stop();
    }
  }

  /** El video avanza a 30 fps y el render a 60: solo detectamos ante frame nuevo. */
  #videoAdvanced() {
    const v = this.video;
    if (!v) return true;
    if (typeof v.videoFrameNumber === 'number') {
      if (v.videoFrameNumber === this._vfn) return false;
      this._vfn = v.videoFrameNumber;
      return true;
    }
    if (v.currentTime === this._vct) return false;
    this._vct = v.currentTime;
    return true;
  }

  /** Percepción desacoplada: un detección a la vez, sin bloquear el dibujado. */
  #perceive() {
    if (this.sim) { this.lastFrame = this.sim.frame(1 / 30); return; }
    if (this._perceiving) return;
    if (!this.cam?.ready || !this.tracker?.ready) return;
    if (!this.#videoAdvanced()) return;
    if (this.frames % this._perceiveEvery !== 0) return;
    this._perceiving = true;
    const p = this.tracker.process(this.video, this.cam.nextTs());
    Promise.resolve(p)
      .then((f) => { if (f) this.lastFrame = f; })
      .catch((err) => { console.warn('[perception]', err?.message); })
      .finally(() => { this._perceiving = false; });
  }

  #step(dt, time, xrFrame) {
    const rules = this.rules;
    if (!this.paused) {
      this.#perceive();
      rules.setClock(this.t * 1000);

      const frame = this.lastFrame;
      const body = buildBody(frame || {});
      this.body = body;
      const hands = this.#hands(body, dt);

      rules.setPartsVisible(Object.fromEntries(BODY_PARTS.map((p) => [p.id, !!body.parts[p.id]?.visible])));
      if (body.humanVisible && body.bbox) rules.setPlayCenter({ x: (body.bbox.x0 + body.bbox.x1) / 2, y: (body.bbox.y0 + body.bbox.y1) / 2, z: 0 });
      const events = this.play.update({ dt, body, hands, facing: this.cam?.actualFacing || 'front', xr: this.mode === MODES.AR, now: this.t * 1000 });
      this.#handle(events, body, dt);

      if (rules.state.phase === PHASE.OVER && !this._overSent) {
        this._overSent = true;
        this.best = Math.max(this.best, rules.state.best);
        store.set(CONFIG.storageKeys.best, this.best);
        this.sfx.play('over');
        this.sfx.hum(false);
        this.#buzz([40, 40, 90, 40, 160]);
        this.ui?.onGameOver?.(rules.state);
      }
      this.energy = damp(this.energy, rules.state.combo > 0 ? clamp(0.25 + rules.state.combo * 0.16, 0, 1) : 0.06, 2.2, dt);
      this.glitch = damp(this.glitch, 0, 2.4, dt);
      this._dt = dt;
      this._hands = hands;
    }

    /* ---- vista, máscara, compositor, rig, núcleos ---- */
    const view = (this._view = this.isMetric ? this.#makeMetricView(dt) : this.#makeVisorView(dt));
    const sockets = this.#sockets(this.body, view);

    if (!this.isMetric) {
      this.mask.update(this.body, { seg: this.lastFrame?.seg || null, mirror: !!this.cam?.mirror, sockets, energy: this.energy });
      this.#updateCompositor(time, dt, this.vw, this.vh, !!this.lastFrame?.seg?.data);
    } else if (this.mode === MODES.GLASSES) {
      this.mask.update(this.body, { seg: this.lastFrame?.seg || null, mirror: !!this.cam?.mirror, sockets, energy: this.energy });
      this.#updateCompositor(time, dt, this.rt.width, this.rt.height, !!this.lastFrame?.seg?.data);
      this.renderer.setRenderTarget(this.rt);
      this.renderer.clear(true, false, false);
      this.compositor.render(this.renderer);
      this.renderer.setRenderTarget(null);
    }

    const levels = Object.fromEntries(BODY_PARTS.map((p) => [p.id, rules.state.parts[p.id].level]));
    this.rig.update({
      joints: this.body.joints,
      hands: { Left: this.body.hands.Left?.landmarks || null, Right: this.body.hands.Right?.landmarks || null },
      parts: this.body.parts,
    }, {
      toRender: view.toRender,
      radiusAt: view.radiusAt,
      dt,
      energy: this.energy,
      glitch: this.glitch,
      levels,
      pinchByHand: { Left: this._hands?.Left?.pinch ?? 1, Right: this._hands?.Right?.pinch ?? 1 },
    });
    this.rig.updateFx(dt);
    this.cores.sync(rules.state.cores, view);
    this.cores.syncSockets(sockets, view);
    this.socketsForHud = sockets;

    /* ---- cámara + render ---- */
    if (this.mode === MODES.VISOR) {
      this.camera.position.set(0, 0, CONFIG.visor.depthPlane);
      this.camera.quaternion.identity();
      this.renderer.setRenderTarget(null);
      this.renderer.clear(true, true, true);
      this.compositor.render(this.renderer);
      this.renderer.clearDepth();
      this.renderer.render(this.scene, this.camera);
    } else if (this.mode === MODES.GLASSES) {
      const q = this.pose.update();
      this.camera.position.set(0, 0.06, 0);
      this.camera.quaternion.copy(q);
      this.#placeBodyRoot(this.headForward(q));
      this.bodyRoot.updateMatrixWorld(true);
      this.room.spin(dt);
      this.glasses.render(this.scene, this.camera);
    } else {
      const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
      const q = new THREE.Quaternion();
      cam.getWorldQuaternion(q);
      this.#placeBodyRoot(this.headForward(q));
      this.bodyRoot.updateMatrixWorld(true);
      if (this.mode === MODES.VR) this.room.spin(dt);
      this.renderer.render(this.scene, this.camera);
    }

    /* ---- HUD a baja frecuencia ---- */
    this._fpsAcc = (this._fpsAcc || 0) + dt;
    this._fpsN = (this._fpsN || 0) + 1;
    if (this._fpsAcc > 0.4) {
      this.fps = this._fpsN / this._fpsAcc;
      this._fpsAcc = 0; this._fpsN = 0;
      this.#autoQuality();
      this.ui?.onFrame?.({
        fps: this.fps,
        cost: this.tracker?.status?.cost ?? 0,
        coverage: this.mask.coverage,
        body: this.body,
        state: rules.state,
        tracker: this.tracker?.status || null,
        cam: this.cam ? { facing: this.cam.actualFacing, ready: this.cam.ready, torch: this.cam.torchSupported, mirror: !!this.cam.mirror } : null,
        mode: this.mode,
        pointer: { ...this.pointer, active: this.pointer.active && !this.cam?.ready },
        hands: Object.keys(this._hands || {}).length,
        held: this.heldPartId,
        sockets: this.socketsForHud?.filter?.((x) => x.visible).length ?? 0,
        demo: !!this.sim,
        quality: this.quality,
      });
    }
    this.sfx.setEnergy?.(this.energy);
  }

  #updateCompositor(time, dt, w, h, hasSeg) {
    this.compositor.update({
      time,
      energy: this.energy,
      glitch: this.glitch,
      hasSeg,
      mirror: !!this.cam?.mirror,
      showVideo: !!this.cam?.ready,
      strength: this.alterStrength,
      scan: this.rules.state.scan.progress / 100,
      res: [w, h],
    });
    this.compositor.markTexturesDirty();
  }

  /** Manos del jugador para Play: reales (MediaPipe) y puntero de respaldo. */
  #hands(body, dt) {
    const hands = {};
    for (const side of ['Left', 'Right']) {
      const raw = body.hands[side];
      if (!raw?.landmarks?.length) continue;
      const st = handState(raw.landmarks);
      if (!st) continue;
      hands[side] = {
        pos: { x: st.center.x, y: st.center.y, z: raw.landmarks[9]?.z ?? 0 },
        pinch: st.pinch,
        open: st.openCount >= 4,
        state: st,
      };
      const fired = this.gestures.update(side === 'Left' ? 'handL' : 'handR', st, this.t * 1000);
      if (fired && this.rules.state.phase === PHASE.PLAY) {
        this.rules.gesture({ id: fired.id, hand: side });
        this._pendingGesture = fired;
      }
    }
    // Puntero = mano derecha sintética (escritorio, o apoyo en móvil sin manos visibles).
    if (this.pointer.active && !hands.Right) {
      hands.Right = {
        pos: { x: this.pointer.x, y: this.pointer.y, z: 0 },
        pinch: this.pointer.down ? 0.05 : 0.95,
        open: !this.pointer.down,
        pointer: true,
      };
    }
    return hands;
  }

  /* ------------------------------------------------------------------ vistas */

  #makeVisorView(dt) {
    const pr = this.projector;
    const mirror = !!this.cam?.mirror;
    return {
      dt,
      mode: 'visor',
      toRender: (p, out = {}) => pr.toWorld(p, out, mirror),
      toImage: (p, out = {}) => pr.toImage(p, out, mirror),
      radiusAt: (_p, r) => r,
      scaleFor: () => clamp(pr.halfW * 0.11, 0.02, 0.6),
      socketFor: (partId) => this.#socketOf(this.body, partId),
    };
  }

  #makeMetricView(dt) {
    const K = METRIC;
    const toRender = (p, out = {}) => {
      out.x = ((p.x ?? 0.5) - 0.5) * 2 * K.kx;
      out.y = -((p.y ?? 0.5) - 0.5) * 2 * K.ky;
      out.z = (p.z || 0) * K.kz - 0.05;
      return out;
    };
    const toImage = (v, out = {}) => {
      out.x = 0.5 + v.x / (2 * K.kx);
      out.y = 0.5 - v.y / (2 * K.ky);
      out.z = (v.z + 0.05) / Math.max(1e-4, K.kz);
      return out;
    };
    return {
      dt,
      mode: 'metric',
      toRender,
      toImage,
      radiusAt: (_p, r) => r * 0.9,
      scaleFor: () => 0.035,
      socketFor: (partId) => this.#socketOf(this.body, partId),
    };
  }

  #socketOf(body, partId) {
    const list = body ? socketsFor(body, partId) : [];
    return list[0] || null;
  }

  #sockets(body, view) {
    const out = [];
    const hov = this.play.socketHover;
    const hoverKey = hov ? `${hov.partId}:${hov.name}` : null;
    const heldPart = this.heldPartId;
    for (const p of BODY_PARTS) {
      const geo = body?.parts?.[p.id];
      const rp = this.rules.state.parts[p.id];
      if (!geo) continue;
      const list = socketsFor(body, p.id);
      const pts = list.length ? list : (geo.center ? [{ x: geo.center.x, y: geo.center.y, z: geo.center.z || 0, name: p.id }] : []);
      for (const s of pts) {
        out.push({
          ...s,
          partId: p.id,
          label: p.label,
          visible: !!geo.visible,
          human: !!geo.visible,
          level: rp?.level ?? 0,
          open: (rp?.socketsLeft ?? 0) > 0,
          match: heldPart === p.id,
          hover: hoverKey === `${p.id}:${s.name}`,
        });
      }
    }
    return out;
  }

  get heldPartId() {
    const s = this.rules.state;
    const id = s.held.Left || s.held.Right;
    return s.cores.find((c) => c.id === id)?.partId || null;
  }

  headForward(q) {
    const THREE = this.THREE;
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    f.y = 0;
    if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
    return f.normalize();
  }

  /** Posición de la cabeza en el mundo (XR) o de la cámara del modo gafas. */
  #headPosition(out) {
    const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
    cam.getWorldPosition(out);
    return out;
  }

  /**
   * Ancla el cuerpo robótico:
   *  - AR: una vez, delante del usuario, y rota con la cabeza (así no "flota").
   *  - gafas: cuelga de la cámara con suavizado, siempre a la vista.
   *  - VR: a la altura del pecho, delante del usuario.
   */
  #placeBodyRoot(fwd) {
    this._headTmp ||= new this.THREE.Vector3();
    this.#headPosition(this._headTmp);
    const yaw = Math.atan2(fwd.x, fwd.z);
    if (this.mode === MODES.AR) {
      if (!this._bodyAnchored) {
        this._anchor = this._anchor || new this.THREE.Vector3();
        this._anchor.set(
          this._headTmp.x + fwd.x * METRIC.forward,
          Math.max(0, this._headTmp.y - 0.42),
          this._headTmp.z + fwd.z * METRIC.forward
        );
        this._bodyAnchored = true;
      }
      this.bodyRoot.position.copy(this._anchor);
    } else if (this.mode === MODES.GLASSES) {
      const t = new this.THREE.Vector3(
        this._headTmp.x + fwd.x * METRIC.forward,
        this._headTmp.y - 0.36,
        this._headTmp.z + fwd.z * METRIC.forward
      );
      this.bodyRoot.position.lerp(t, 0.22);
    } else {
      this.bodyRoot.position.set(
        this._headTmp.x + fwd.x * METRIC.forward,
        this._headTmp.y - 0.4,
        this._headTmp.z + fwd.z * METRIC.forward
      );
    }
    this.bodyRoot.rotation.set(0, yaw, 0);
  }

  /* ------------------------------------------------------------------ entrada */

  /** Ángulo entre la dirección de mira y un punto del mundo (menor = más apuntado). */
  #angleTo(origin, dir, worldPos, out) {
    out.copy(worldPos).sub(origin);
    const d = out.length();
    if (d < 1e-4) return 0;
    return Math.acos(Math.max(-1, Math.min(1, out.dot(dir) / d)));
  }

  /** Punto del mundo (escena) correspondiente a un punto en espacio de imagen. */
  #worldOf(pImage, out) {
    const v = this._view.toRender(pImage, { x: 0, y: 0, z: 0 });
    return out.set(v.x, v.y, v.z).applyMatrix4(this.bodyRoot.matrixWorld);
  }

  /**
   * Gatillo/toque dentro de WebXR: mirar + seleccionar = agarrar el núcleo apuntado;
   * soltar = conectarlo en la parte humana mirada (o soltarlo si no hay ninguna).
   */
  #xrSelect(e) {
    if (this.rules.state.phase !== PHASE.PLAY) return;
    const THREE = this.THREE;
    const ray = this.xr.pickRay() || {};
    const origin = ray.origin || this.camera.getWorldPosition(new THREE.Vector3());
    const dir = ray.direction || this.camera.getWorldDirection(new THREE.Vector3());
    const wp = new THREE.Vector3();

    if (e.type === 'selectstart') {
      let best = null, bestAng = 0.55;
      for (const c of this.rules.state.cores) {
        if (c.state !== 'floating') continue;
        const ang = this.#angleTo(origin, dir, this.#worldOf(c, wp), new THREE.Vector3());
        if (ang < bestAng) { bestAng = ang; best = c; }
      }
      if (best) { this.rules.grab(best.id, 'Right'); this.sfx.play('grab'); }
      return;
    }

    const side = this.rules.state.held.Right ? 'Right' : this.rules.state.held.Left ? 'Left' : null;
    const held = side ? this.rules.state.held[side] : null;
    if (!held) return;
    let best = null, bestAng = 0.62;
    for (const s of this.socketsForHud || []) {
      if (!s.visible) continue;
      const ang = this.#angleTo(origin, dir, this.#worldOf(s, wp), new THREE.Vector3());
      if (ang < bestAng) { bestAng = ang; best = s; }
    }
    if (best) this.rules.place(held, best.partId, { humanVisible: best.human !== false });
    else this.rules.release(held, side);
  }

  /* ------------------------------------------------------------------ efectos */

  #handle(events, body, dt) {
    if (!events?.length) return;
    for (const e of events) {
      switch (e.type) {
        case 'grab':
          this.sfx.play('grab'); this.ui?.flash?.('AGARRE', 'ok'); this.#buzz(16);
          break;
        case 'release':
          this.sfx.play('release');
          break;
        case 'installed': {
          this.sfx.play('installed');
          this.energy = 1;
          const label = PART_BY_ID[e.partId]?.label || e.partId;
          this.ui?.flash?.(`${label} NIVEL ${e.level}`, 'ok');
          this.ui?.toast?.(`Núcleo conectado en ${label} · +${e.points}`, 'ok');
          this.#buzz([12, 22, 42]);
          const p = this.#socketOf(body, e.partId);
          if (p) { const w = this._view.toRender(p, {}); this.rig.burst(w, CONFIG.robotize.colors.ok, 1.2); }
          break;
        }
        case 'reject':
          this.sfx.play('reject');
          this.glitch = 1;
          this.ui?.flash?.(e.why === 'not-human'
            ? 'SOLO LAS PARTES HUMANAS SE ALTERAN · CALIBRACIÓN RECHAZADA'
            : e.why === 'mismatch' ? 'ZÓCALO INCOMPATIBLE' : 'SIN ZÓCALOS LIBRES', 'bad');
          this.#buzz([28, 28, 28]);
          break;
        case 'damage':
          this.sfx.play('damage');
          this.glitch = 1;
          this.#buzz(24);
          break;
        case 'objective':
          this.sfx.play('objective');
          this.ui?.toast?.('Protocolo: objetivo cumplido', 'ok');
          this.energy = Math.max(this.energy, 0.7);
          break;
        case 'roundClear':
          this.sfx.play('round');
          this.ui?.onRound?.(e);
          this.energy = 1;
          this.#buzz([10, 40, 10, 40, 30]);
          break;
        case 'scanned':
          this.sfx.play('objective');
          this.ui?.toast?.('Sujeto escaneado · planos robóticos desbloqueados', 'ok');
          this.energy = Math.max(this.energy, 0.85);
          break;
        case 'cameraSwitch':
          this.sfx.play('ui');
          this.ui?.toast?.(e.facing === 'rear' ? 'Cámara trasera: escáner de sujetos activo' : 'Cámara frontal: auto-visión', 'info');
          break;
        case 'gesture':
          this.sfx.play('gesture', { up: e.objective });
          if (e.objective) this.#buzz(10);
          break;
        default:
          break;
      }
    }
    void dt;
  }

  #buzz(pattern) {
    if (!this.haptics) return;
    try { navigator.vibrate?.(pattern); } catch { /* sin háptica */ }
  }

  /* --------------------------------------------------------- calidad adaptiva */

  #autoQuality() {
    if (this._qLock) return;
    const fps = this.fps;
    this._lowStreak = fps < 26 ? (this._lowStreak || 0) + 1 : 0;
    if (this._lowStreak === 4) {
      this._qLock = true;
      this._perceiveEvery = 2;
      this.tracker?.setProfile?.('bajo');
      this.quality = 'bajo';
      this.rig?.setQuality?.('bajo');
      this.ui?.toast?.('Rendimiento bajo: modo ligero (menos detectores y máscara chica).', 'warn');
      setTimeout(() => { this._qLock = false; }, 9000);
    }
  }

  /* -------------------------------------------------------------------- varios */

  hudState() {
    const st = this.rules.state;
    return {
      facing: this.cam?.actualFacing || 'front',
      mode: this.mode,
      score: st.score,
      best: Math.max(this.best, st.best),
      round: st.round,
      timeLeft: st.timeLeft,
      combo: st.combo,
      integrity: st.integrity,
      cores: st.cores.length,
      held: this.heldPartId,
      fps: this.fps,
      coverage: this.mask?.coverage ?? 0,
    };
  }

  /** Botones de gesto (accesibilidad, y para probar sin moverse). */
  injectGesture(id, hand = 'Right') {
    this.rules.gesture({ id, hand });
    this.sfx.play('gesture');
  }

  async switchCamera() {
    if (!this.cam) return null;
    const f = this.cam.facing === 'front' ? 'rear' : 'front';
    await this.cam.open(f);
    this.#resize();
    this.rules.cameraSwitched(this.cam.actualFacing);
    return this.cam.actualFacing;
  }

  setTorch(on) { return this.cam?.setTorch?.(on) ?? false; }
  setAlterStrength(v) { this.alterStrength = clamp(v, 0, 1); }
  setHaptics(on) { this.haptics = !!on; }
  setQuality(q) {
    this.quality = q;
    this.rig?.setQuality?.(q);
    this.mask = this.mask || new MaskBuilder(288);
    this._qLock = false;
    this._lowStreak = 0;
    this._perceiveEvery = q === 'bajo' ? 2 : 1;
    this.ui?.toast?.(`Calidad: ${q}`, 'info');
  }

  async snapshot() {
    try {
      this.renderer.render(this.scene, this.camera);
      return this.canvas.toDataURL('image/png');
    } catch { return null; }
  }

  dispose() {
    this.stop();
    for (const fn of this._off || []) { try { fn(); } catch { /* noop */ } }
    this.xr?.exit?.().catch(() => {});
    this.pose.stop();
    this.rig.dispose();
    this.cores.dispose();
    this.compositor.dispose();
    this.room.dispose();
    this.rt?.dispose();
    this.tracker?.close();
    this.cam?.close();
    this.renderer?.dispose();
  }
}

export default RoboGame;
