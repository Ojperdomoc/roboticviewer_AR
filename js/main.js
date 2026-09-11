/**
 * main.js — arranque y cableado del ROBOVISOR AR.
 *
 * Orden de arranque (pensado para que NUNCA quede una pantalla negra muda):
 *   1. UI + capacidades del navegador
 *   2. WebGL (three.js) — si falla, aviso y salgo
 *   3. cámara (getUserMedia) y motor de visión (MediaPipe) en paralelo
 *   4. RoboGame: escena, rig robótico, compositor, reglas
 *   5. modo (visor 2D / RA / VR / gafas) y start()
 * Cada paso degrada: sin cámara → demo con cuerpo sintético; sin MediaPipe → visor sin
 * detección pero jugable con el puntero; sin WebXR → modo gafas estéreo.
 */

import * as THREE from '../vendor/three/three.module.js';
import { CONFIG } from './config.js';
import { UI, friendlyError } from './ui.js';
import { CameraRig } from './camera.js';
import { Tracker } from './track/tracker.js';
import { Sfx } from './audio.js';
import { RoboGame, MODES } from './game/game.js';
import { mergePrefs, store, clamp } from './util.js';

const KEYS = CONFIG.storageKeys;

const prefs = mergePrefs(
  { quality: 'medio', alter: 1, haptics: true, audio: true, autopause: true, modelBase: '', demo: false },
  store.get(KEYS.prefs, {}) || {}
);
const savePrefs = () => store.set(KEYS.prefs, prefs);

/* ------------------------------------------------------------------ arranque */

const video = document.getElementById('cam-video');
const canvas = document.getElementById('stage');
const overlay = document.getElementById('hud');

const sfx = new Sfx();
try { sfx.enabled = prefs.audio !== false; } catch { /* noop */ }

let game = null;
let tracker = null;
let cam = null;
let booted = false;

const ui = new UI({
  onStartCamera: () => boot({ withCamera: true }),
  onStartDemo: () => boot({ withCamera: false, demo: true }),
  onStartVr: () => boot({ withCamera: true, immersive: true }),
  onSwitchCamera: async () => {
    if (!game) return;
    try {
      const f = await game.switchCamera();
      ui.toast(f === 'rear' ? 'Cámara trasera activa: apuntá a una persona para escanearla' : 'Cámara frontal activa', 'info');
      ui.onTorchAvailable(!!game.cam?.torchSupported);
      sfx.play('ui');
    } catch (err) { ui.toast(friendlyError(err), 'bad', 4200); }
  },
  onTorch: async () => {
    if (!game?.cam) return;
    const on = !game.cam.torch;
    const ok = await game.setTorch(on);
    ui.toast(ok ? (on ? 'Linterna encendida' : 'Linterna apagada') : 'Este dispositivo no expone la linterna.', ok ? 'info' : 'warn');
  },
  onScanPulse: () => {
    if (!game) return;
    ui.toast('Escáner listo: mantené al sujeto en cuadro (cámara trasera) o hacé una pinza frente a tu cara', 'info');
    sfx.play('scan');
  },
  onToggleMode: async () => {
    if (!game) { await boot({ withCamera: true, immersive: true }); return; }
    const back = game.mode !== MODES.VISOR;
    try {
      await game.setMode(back ? MODES.VISOR : nextImmersiveMode());
      ui.toast(back ? 'Volviendo al visor de pantalla' : 'Modo inmersivo: mirá hacia abajo para ver tu cuerpo robótico', 'info', 3600);
    } catch (err) { ui.toast(friendlyError(err), 'bad', 5200); }
  },
  onToggleDemo: () => {
    if (!game) return;
    const on = !game.sim;
    game.useDemoBody(on);
    prefs.demo = on;
    savePrefs();
    ui.toast(on ? 'Cuerpo sintético activado (demo)' : 'Volvemos a tu cuerpo real', 'info');
  },
  onTogglePause: () => {
    if (!game) return;
    if (game.paused) { game.resume(); sfx.play('ui'); } else { game.pause(); sfx.play('ui'); }
  },
  onToggleSettings: () => ui.onFrame?.({}) , // noop defensivo
  onGesture: (id) => game?.injectGesture(id),
  onRestart: () => { ui.el.result.hidden = true; game?.start(); },
  onQuality: (q) => { prefs.quality = q; savePrefs(); game?.setQuality(q); tracker?.setProfile?.(q); },
  onAlter: (v) => { prefs.alter = clamp(v, 0, 1); savePrefs(); game?.setAlterStrength(prefs.alter); },
  onHaptics: (on) => { prefs.haptics = on; savePrefs(); game?.setHaptics(on); },
  onAudio: (on) => { prefs.audio = on; savePrefs(); sfx.enabled = on; if (!on) sfx.hum(false); else sfx.hum(true); },
  onAutopause: (on) => { prefs.autopause = on; savePrefs(); if (game) game.autoPause = on; },
  onModelBase: (base) => { prefs.modelBase = base; savePrefs(); ui.toast('Fuente de modelos guardada. Recargá para volver a intentarlo.', 'info', 4000); },
  onClearCache: async () => {
    const { cacheClear } = await import('./idb.js');
    await cacheClear();
    ui.toast('Caché de modelos borrada: la próxima descarga va a la red.', 'ok');
  },
});

/* Hilo de arranque de la hoja de ajustes (se enlaza aquí para mantener UI tonta). */
document.getElementById('btn-settings')?.addEventListener('click', () => {
  if (tracker) ui.onModelsInfo(describeModels(tracker.status));
});

ui.el.setQuality.value = prefs.quality;
ui.el.setAlter.value = Math.round(prefs.alter * 100);
ui.el.setHaptics.checked = prefs.haptics !== false;
ui.el.setAudio.checked = prefs.audio !== false;
ui.el.setAutopause.checked = prefs.autopause !== false;
ui.el.setModelBase.value = prefs.modelBase || '';

probeCapabilities().then(async (caps) => {
  ui.bootInfo(caps);
  // Precarga: si hay WebGL, armamos la escena para que el primer frame no tartamudee.
  try {
    game = new RoboGame({ THREE, canvas, video, overlay, ui, sfx, quality: prefs.quality });
    game.caps = caps;
    await game.init();
    game.autoPause = prefs.autopause !== false;
    game.setAlterStrength(prefs.alter);
    game.setHaptics(prefs.haptics !== false);
    ui.status('listo: elegí cámara, demo o VR');
  } catch (err) {
    ui.onFatal(err);
    console.error('[init]', err);
  }
});

/* --------------------------------------------------------------------- boot */

async function boot({ withCamera = true, demo = false, immersive = false } = {}) {
  if (booted || !game) return;
  booted = true;
  ui.progress(0.01, 'solicitando permiso de cámara…');
  sfx.resume();

  if (withCamera) {
    cam = new CameraRig(video);
    game.cam = cam;
    tracker = new Tracker({ profile: prefs.quality, modelBase: prefs.modelBase });
    game.tracker = tracker;
    tracker.on('status', (status) => { ui.onTrackerStatus(status); ui.onModelsInfo(describeModels(status)); });

    // Cámara y modelos en paralelo: lo que llegue primero, ya suma.
    const cameraTask = cam.open('front')
      .then(() => {
        ui.onTorchAvailable(!!cam.torchSupported);
        ui.progress(0.08, 'cámara abierta · cargando modelos de visión');
      })
      .catch((err) => {
        ui.onCameraError(err);
        return false;
      });
    const modelTask = tracker.init().catch((err) => {
      ui.toast(`Motor de visión: ${friendlyError(err)}`, 'warn', 5000);
      return false;
    });

    const [hasCam, hasVision] = await Promise.all([cameraTask, modelTask]);
    if (!hasCam) {
      // Sin cámara no hay nada que robotizar: seguimos con el cuerpo sintético.
      ui.toast('Cámara no disponible: el visor corre con un cuerpo sintético para que veas todo funcionando.', 'warn', 5600);
      booted = false;
    }
    if (!hasVision) {
      ui.toast('Sin detectores de MediaPipe: podés jugar con el puntero (mantener presionado = pinza).', 'warn', 5600);
    }
    game.useDemoBody(!hasCam);
  } else {
    ui.progress(0.55, 'modo demo: cuerpo sintético, sin cámara ni modelos');
    game.useDemoBody(true);
  }

  ui.hideBoot();
  ui.setHudVisible(true);
  try {
    if (immersive) await game.setMode(nextImmersiveMode());
  } catch (err) {
    ui.toast(`Modo inmersivo no disponible: ${friendlyError(err)}`, 'warn', 4800);
  }
  game.start();
  ui.status(game.sim ? 'DEMO · cuerpo sintético en pantalla' : 'visor en línea');
}

/** Elige la mejor sesión inmersiva disponible en este dispositivo. */
function nextImmersiveMode() {
  if (CAPS.ar) return MODES.AR;
  if (CAPS.vr) return MODES.VR;
  return MODES.GLASSES;
}

const CAPS = { camera: false, secure: false, webgl2: false, xr: false, ar: false, vr: false };

async function probeCapabilities() {
  CAPS.camera = !!(navigator.mediaDevices?.getUserMedia);
  CAPS.secure = !!window.isSecureContext;
  try {
    const c = document.createElement('canvas');
    CAPS.webgl2 = !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { CAPS.webgl2 = false; }
  try {
    if (navigator.xr) {
      CAPS.xr = true;
      CAPS.ar = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
      CAPS.vr = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
    }
  } catch { /* navegador sin WebXR */ }
  ui.onCapabilities(CAPS);
  return CAPS;
}

function describeModels(status) {
  const loaded = Object.entries(status.loaded || {}).map(([k, v]) => `${k} (${v.from}, ${(v.bytes / 1048576).toFixed(1)} MB)`);
  const errs = Object.entries(status.errors || {}).map(([k, v]) => `${k}: ${v}`);
  const bits = [
    `motor: ${status.delegate || '—'}`,
    loaded.length ? `modelos: ${loaded.join(', ')}` : 'modelos: ninguno cargado',
    errs.length ? `alertas: ${errs.length}` : 'sin alertas',
  ];
  return bits.join(' · ');
}

/* ------------------------------------------------------------- extras menores */

// Puntero: refleja la "mano B" en pantalla cuando no hay manos detectadas.
canvas.addEventListener('pointermove', (ev) => {
  if (!game?.pointer?.active) return;
  const r = canvas.getBoundingClientRect();
  ui.reticle(true, (ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height, game.pointer.down);
});
canvas.addEventListener('pointerup', () => ui.reticle(false));
canvas.addEventListener('pointercancel', () => ui.reticle(false));

// Evita el scroll/pull-to-refresh nativo sobre el lienzo.
document.addEventListener('touchmove', (ev) => { if (ev.target === canvas) ev.preventDefault(); }, { passive: false });

window.addEventListener('pagehide', () => { try { game?.dispose(); } catch { /* noop */ } });

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* sin offline: no es crítico */ });
  });
}

console.info('%cROBOVISOR AR', 'color:#35f0ff;font-weight:700', '— visor robótico corporal. Atajos: P pausa · C cámara · V modo inmersivo · D demo · 1..6 gestos · S ajustes · H ayuda');
