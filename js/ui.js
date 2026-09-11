/**
 * ui.js — HUD y pantallas. Manipula DOM solamente; no sabe de three.js ni de reglas:
 * recibe datos ya calculados y los refleja. Toda acción delega en `handlers`.
 */

import { GESTURES, BODY_PARTS, PART_BY_ID, T } from './config.js';
import { clamp, mmss } from './util.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export class UI {
  /** @param {{[k:string]: Function}} handlers */
  constructor(handlers = {}) {
    this.h = handlers;
    this.el = {
      hud: $('#hud'),
      score: $('#hud-score'), best: $('#hud-best'), round: $('#hud-round'), time: $('#hud-time'),
      combo: $('#hud-combo'), barCombo: $('#bar-combo'), barIntegrity: $('#bar-integrity'),
      mode: $('#hud-mode'), facing: $('#hud-facing'), scan: $('#hud-scan'),
      objectives: $('#objectives'), parts: $('#parts'), barCoverage: $('#bar-coverage'), coverage: $('#hud-coverage'),
      status: $('#hud-status'), fps: $('#hud-fps'), detectors: $('#hud-detectors'),
      toasts: $('#toasts'), flash: $('#flash'), reticle: $('#reticle'),
      strip: $('#gesture-strip'),
      btnCam: $('#btn-cam'), btnTorch: $('#btn-torch'), btnScan: $('#btn-scan'), btnMode: $('#btn-mode'),
      btnModeLabel: $('#btn-mode-label'), btnDemo: $('#btn-demo'), btnPause: $('#btn-pause'),
      btnSettings: $('#btn-settings'), btnHelp: $('#btn-help'),
      boot: $('#boot'), bootBar: $('#boot-bar'), bootDetail: $('#boot-detail'), bootProgress: $('#boot-progress'),
      compat: $('#compat-line'), startCamera: $('#start-camera'), startDemo: $('#start-demo'), startVr: $('#start-vr'),
      help: $('#help'), helpGestures: $('#help-gestures'), settings: $('#settings'), result: $('#result'),
      resultTitle: $('#result-title'), resultSub: $('#result-sub'), resultScore: $('#result-score'), resultStats: $('#result-stats'),
      fatal: $('#fatal'), fatalMsg: $('#fatal-msg'), fatalDetail: $('#fatal-detail'),
      setQuality: $('#set-quality'), setAlter: $('#set-alter'), setHaptics: $('#set-haptics'),
      setAudio: $('#set-audio'), setAutopause: $('#set-autopause'), setModels: $('#set-models'),
      setClear: $('#set-clear-cache'), setModelBase: $('#set-model-base'),
    };
    this._objRows = new Map();
    this._partRows = new Map();
    this._last = {};
    this.always = true;
    this.#buildGestures();
    this.#wire();
  }

  /* ------------------------------------------------------------- construcción */

  #buildGestures() {
    const frag = document.createDocumentFragment();
    for (const g of GESTURES) {
      const b = document.createElement('button');
      b.className = 'gchip';
      b.type = 'button';
      b.dataset.g = g.id;
      b.title = g.hint;
      b.innerHTML = `<span class="g-ico">${g.icon}</span><span>${g.label}</span>`;
      b.addEventListener('click', () => { this.h.onGesture?.(g.id); this.#chipFlash(b); });
      frag.appendChild(b);
    }
    this.el.strip.appendChild(frag);
    this.el.helpGestures.innerHTML = GESTURES.map((g) => `<li><b>${g.icon} ${g.label}</b> — ${g.hint}</li>`).join('');
  }

  #chipFlash(b) {
    b.classList.add('on');
    setTimeout(() => b.classList.remove('on'), 260);
  }

  #wire() {
    const e = this.el;
    const call = (name, arg) => () => this.h[name]?.(arg);
    e.startCamera.addEventListener('click', call('onStartCamera'));
    e.startDemo.addEventListener('click', call('onStartDemo'));
    e.startVr.addEventListener('click', call('onStartVr'));
    e.btnCam.addEventListener('click', call('onSwitchCamera'));
    e.btnTorch.addEventListener('click', call('onTorch'));
    e.btnScan.addEventListener('click', call('onScanPulse'));
    e.btnMode.addEventListener('click', call('onToggleMode'));
    e.btnDemo.addEventListener('click', call('onToggleDemo'));
    e.btnPause.addEventListener('click', call('onTogglePause'));
    e.btnSettings.addEventListener('click', () => this.#toggleSheet(e.settings));
    e.btnHelp.addEventListener('click', () => this.#toggleSheet(e.help));
    $$('[data-close]').forEach((b) => b.addEventListener('click', () => this.#toggleSheet(null)));
    $$('[data-reload]').forEach((b) => b.addEventListener('click', () => location.reload()));
    document.addEventListener('keydown', (ev) => {
      if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return;
      const k = ev.key.toLowerCase();
      const map = {
        p: 'onTogglePause', s: 'onToggleSettings', h: 'onToggleHelp', c: 'onSwitchCamera',
        r: 'onRestart', t: 'onTorch', d: 'onToggleDemo', v: 'onToggleMode', escape: 'onTogglePause',
      };
      if (map[k]) { ev.preventDefault(); this.h[map[k]]?.(); return; }
      const n = parseInt(k, 10);
      if (n >= 1 && n <= GESTURES.length) this.h.onGesture?.(GESTURES[n - 1].id);
    });

    e.setQuality.addEventListener('change', () => this.h.onQuality?.(e.setQuality.value));
    e.setAlter.addEventListener('input', () => this.h.onAlter?.(Number(e.setAlter.value) / 100));
    e.setHaptics.addEventListener('change', () => this.h.onHaptics?.(e.setHaptics.checked));
    e.setAudio.addEventListener('change', () => this.h.onAudio?.(e.setAudio.checked));
    e.setAutopause.addEventListener('change', () => { this.h.onAutopause?.(e.setAutopause.checked); });
    e.setModelBase.addEventListener('change', () => this.h.onModelBase?.(e.setModelBase.value.trim()));
    e.setClear.addEventListener('click', () => this.h.onClearCache?.());
  }

  toggleSettings() { this.#toggleSheet(this.el.settings); }
  toggleHelp() { this.#toggleSheet(this.el.help); }

  #toggleSheet(node) {
    const sheets = [this.el.help, this.el.settings, this.el.result];
    for (const s of sheets) if (s !== node) s.hidden = true;
    if (node) node.hidden = !node.hidden;
  }

  /* -------------------------------------------------------------------- boot */

  bootInfo(caps) {
    const bits = [];
    bits.push(caps.camera ? 'cámara ✓' : 'cámara ✗ (necesitás HTTPS o un navegador con getUserMedia)');
    bits.push(caps.webgl2 ? 'WebGL2 ✓' : 'WebGL2 ✗ (el visor necesita WebGL2)');
    bits.push(caps.xr ? `WebXR ✓ (${[caps.ar && 'AR', caps.vr && 'VR'].filter(Boolean).join(' + ') || 'sin sesiones inmersivas'})` : 'WebXR ✗ → usarás el modo gafas estéreo');
    bits.push(caps.secure ? 'contexto seguro ✓' : '⚠ contexto no seguro: abrí el juego por HTTPS');
    this.el.compat.textContent = bits.join('  ·  ');
    this.el.startVr.disabled = false;
    if (!caps.camera) this.el.startCamera.disabled = true;
  }

  progress(frac, detail) {
    this.el.bootProgress.hidden = false;
    this.el.bootBar.style.width = `${Math.round(clamp(frac, 0, 1) * 100)}%`;
    if (detail) this.el.bootDetail.textContent = detail;
  }

  hideBoot() {
    this.el.boot.hidden = true;
    this.el.bootProgress.hidden = true;
  }

  showBoot() {
    this.el.boot.hidden = false;
    $$('.screen').forEach((s) => { if (s !== this.el.boot) s.hidden = true; });
  }

  /* -------------------------------------------------------------------- frame */

  onFrame(info = {}) {
    const st = info.state;
    if (!st) return;
    const e = this.el;
    this.#set(e.score, String(st.score));
    this.#set(e.best, String(Math.max(st.best, st.score)));
    this.#set(e.round, String(st.round));
    this.#set(e.time, mmss(st.timeLeft));
    const mult = Math.min(5, 1 + st.combo * 0.25);
    this.#set(e.combo, `x${mult.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`);
    e.barCombo.style.width = `${clamp(st.comboTimer / 5.5, 0, 1) * 100}%`;
    e.barIntegrity.style.width = `${clamp(st.integrity / 100, 0, 1) * 100}%`;
    e.barCoverage.style.width = `${clamp(info.coverage, 0, 1) * 100}%`;
    this.#set(e.coverage, `${Math.round(clamp(info.coverage, 0, 1) * 100)}%`);
    this.#set(e.scan, `${Math.round(st.scan.progress)}%`);
    this.#set(e.fps, `${Math.round(info.fps)} fps`);
    this.#set(e.facing, info.cam?.facing === 'rear' ? 'trasera' : 'frontal');
    this.#set(e.mode, info.mode);
    const det = info.tracker ? Object.keys(info.tracker.loaded || {}).join('+') : 'demo';
    this.#set(e.detectors, info.demo ? 'cuerpo sintético' : `visores: ${det || '—'}${info.quality ? ` · ${info.quality}` : ''}`);

    // Estado del visor: qué ve, qué falta.
    const msgs = [];
    if (info.demo) msgs.push('DEMO: cuerpo sintético en pantalla');
    else if (!info.cam?.ready) msgs.push('esperando cámara…');
    if (!info.body?.humanVisible) msgs.push('buscando un cuerpo humano en cuadro');
    else if (!info.body.parts.mano_der.visible && !info.body.parts.mano_izq.visible) msgs.push('muestrá las manos para agarrar núcleos');
    else if (st.phase === 'play' && st.cores.length === 0) msgs.push('sintetizando núcleos de servo…');
    this.status(msgs.join(' · ') || 'visor activo');

    this.#objectives(st);
    this.#parts(st, info.body);
    this.#chips(st);
    if (info.pointer) this.reticle(info.pointer.active, info.pointer.x, info.pointer.y, info.pointer.down);
  }

  #set(node, value) {
    if (!node) return;
    const key = node.id || node.className;
    if (this._last[key] === value) return;
    this._last[key] = value;
    node.textContent = value;
  }

  #objectives(st) {
    const list = this.el.objectives;
    const seen = new Set();
    for (const o of st.objectives) {
      seen.add(o.id);
      let row = this._objRows.get(o.id);
      if (!row) {
        row = document.createElement('li');
        row.innerHTML = '<span class="o-ico"></span><span class="o-txt"></span><span class="o-prog"></span>';
        list.appendChild(row);
        this._objRows.set(o.id, row);
      }
      const meta = describeObjective(o);
      row.querySelector('.o-ico').textContent = meta.icon;
      row.querySelector('.o-txt').innerHTML = `${meta.text}<small>${meta.sub}</small>`;
      row.querySelector('.o-prog').textContent = o.done ? 'OK' : `${o.progress}/${o.need}`;
      row.classList.toggle('done', !!o.done);
      row.classList.toggle('active', !o.done && meta.target);
    }
    for (const [id, row] of this._objRows) {
      if (seen.has(id)) continue;
      row.remove();
      this._objRows.delete(id);
    }
  }

  #parts(st, body) {
    const list = this.el.parts;
    for (const p of BODY_PARTS) {
      let row = this._partRows.get(p.id);
      if (!row) {
        row = document.createElement('li');
        row.innerHTML = '<span class="p-row"><i class="dot"></i><span class="p-name"></span></span><span class="p-lv"></span>';
        list.appendChild(row);
        row.querySelector('.p-name').textContent = p.label;
        this._partRows.set(p.id, row);
      }
      const rp = st.parts[p.id];
      const live = !!body?.parts?.[p.id]?.visible;
      row.querySelector('.p-lv').textContent = `Nv${rp.level}${rp.socketsLeft > 0 ? ` ·${rp.socketsLeft}◦` : ' lleno'}`;
      row.classList.toggle('live', live);
      row.classList.toggle('up', rp.level > 0);
    }
  }

  #chips(st) {
    const wanted = new Set(st.objectives.filter((o) => !o.done && o.kind === 'gesture').map((o) => o.gesture));
    for (const b of $$('button', this.el.strip)) b.dataset.target = wanted.has(b.dataset.g) ? '1' : '0';
  }

  status(text, kind = '') {
    const n = this.el.status;
    n.textContent = text;
    n.classList.toggle('err', kind === 'err');
  }

  /* ------------------------------------------------------------------ avisos */

  toast(text, kind = 'info', ms = 2600) {
    const box = this.el.toasts;
    const div = document.createElement('div');
    div.className = `toast ${kind}`;
    div.textContent = text;
    box.appendChild(div);
    setTimeout(() => { div.classList.add('fade'); setTimeout(() => div.remove(), 320); }, ms);
    while (box.children.length > 4) box.firstChild.remove();
  }

  flash(text, kind = 'ok', ms = 700) {
    const n = this.el.flash;
    n.hidden = false;
    n.textContent = text;
    n.className = `flash ${kind}`;
    // reinicia la animación
    void n.offsetWidth;
    n.style.animation = 'none';
    requestAnimationFrame(() => { n.style.animation = ''; });
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => { n.hidden = true; }, ms);
  }

  reticle(on, x = 0.5, y = 0.5, down = false) {
    const n = this.el.reticle;
    n.hidden = !on;
    if (!on) return;
    n.style.left = `${x * 100}%`;
    n.style.top = `${y * 100}%`;
    n.classList.toggle('down', down);
  }

  /* -------------------------------------------------------------- modos/fases */

  onPhase(phase) {
    const playing = phase === 'play';
    this.el.hud.classList.toggle('hidden', phase === 'boot');
    this.el.btnPause.textContent = playing ? '❚❚' : '▶';
    this.el.result.hidden = phase !== 'over';
  }

  setHudVisible(on) { this.el.hud.classList.toggle('hidden', !on); }

  onMode(mode) {
    const names = { visor: 'visor 2D', ar: 'RA inmersiva', vr: 'VR inmersiva', gafas: 'gafas estéreo' };
    this.#set(this.el.mode, names[mode] || mode);
    this.#set(this.el.btnModeLabel, mode === 'visor' ? 'Entrar en VR' : 'Volver al visor');
  }

  onCapabilities({ ar, vr }) {
    if (!ar && !vr) {
      this.el.btnModeLabel.textContent = 'Modo gafas';
      this.el.btnMode.title = 'Estéreo con giroscopio (sin WebXR)';
    } else {
      this.el.btnModeLabel.textContent = ar ? 'Entrar en RA' : 'Entrar en VR';
      this.el.btnMode.title = 'Sesión inmersiva WebXR';
    }
  }

  onModelsInfo(text) { this.#set(this.el.setModels, text); }

  onTorchAvailable(on) { this.el.btnTorch.hidden = !on; }

  onRound(e) {
    this.flash(`PROTOCOLO ${e.round} SUPERADO${e.perfect ? ' · IMPECABLE' : ''}`, 'ok', 1500);
    this.toast(`BONUS +${e.timeBonus} por tiempo · protocolo completado`, 'ok', 3200);
  }

  onGameOver(st) {
    const s = st.stats;
    this.el.result.hidden = false;
    this.#set(this.el.resultTitle, st.integrity <= 0 ? 'CUERPO FUERA DE LÍNEA' : 'TIEMPO AGOTADO');
    this.#set(this.el.resultSub, st.score >= st.best
      ? `Nuevo récord. Protocolos superados: ${st.round - 1}. Partes robóticas mejoradas: ${Object.values(st.parts).reduce((a, p) => a + p.level, 0)}.`
      : `Ronda alcanzada ${st.round}. Récord: ${st.best} pts.`);
    this.#set(this.el.resultScore, String(st.score));
    this.el.resultStats.innerHTML = [
      ['núcleos conectados', s.installs],
      ['gestos', s.gestures],
      ['escaneos', s.scans],
      ['cambios de cámara', s.camSwitches],
      ['mejor combo', `x${(1 + s.bestCombo * 0.25).toFixed(2)}`],
      ['fallos de calibración', s.rejects],
      ['núcleos perdidos', s.lostCores],
      ['integridad final', `${Math.round(st.integrity)}%`],
    ].map(([k, v]) => `<li>${k}<b>${v}</b></li>`).join('');
    this.setHudVisible(true);
  }

  onFatal(err) {
    const el = this.el.fatal;
    el.hidden = false;
    this.#set(this.el.fatalMsg, friendlyError(err) || 'Ocurrió un error inesperado en el visor.');
    this.el.fatalDetail.textContent = [err?.message, err?.stack].filter(Boolean).join('\n').slice(0, 1200);
  }

  onTrackerStatus(status) {
    if (!status) return;
    if (status.phase === 'loading') this.progress(status.progress ?? 0, status.detail);
    else if (status.phase === 'ready') { this.progress(1, status.detail); this.status(status.detail); }
    else if (status.phase === 'error') { this.status(status.detail || 'visor de visión no disponible', 'err'); }
  }

  onCameraError(err) {
    const msg = friendlyError(err);
    this.progress(0, '');
    this.el.bootProgress.hidden = false;
    this.#set(this.el.bootDetail, msg);
    this.toast(msg, 'bad', 5200);
  }
}

export function describeObjective(o) {
  switch (o.kind) {
    case 'gesture': {
      const g = GESTURES.find((x) => x.id === o.gesture) || { icon: '✳', label: o.gesture, hint: '' };
      return { icon: g.icon, text: `${g.label}`, sub: g.hint, target: true };
    }
    case 'place': {
      const p = PART_BY_ID[o.partId];
      return { icon: '⊕', text: `Conectar núcleo en ${p?.label || o.partId}`, sub: 'abrí la palma sobre su zócalo' };
    }
    case 'scan':
      return { icon: '⌖', text: 'Escanear un sujeto', sub: 'cámara trasera, mantén a la persona en cuadro' };
    case 'cam':
      return { icon: '⇄', text: 'Cambiar a cámara trasera', sub: 'el visor también trabaja sobre otros cuerpos' };
    default:
      return { icon: '·', text: o.kind, sub: '' };
  }
}

export function friendlyError(err) {
  const n = err?.name || '';
  const m = String(err?.message || err || '');
  if (/NotAllowedError|Permission/i.test(n + m)) return 'Permiso de cámara denegado: habilitalo en el candado de la barra de direcciones y reintentá.';
  if (/NotFoundDevicesError|NotFoundError/i.test(n + m)) return 'No se encontró ninguna cámara en este dispositivo.';
  if (/NotReadableError|TrackStartError/i.test(n + m)) return 'La cámara está siendo usada por otra app (o está bloqueada). Cerrala y reintentá.';
  if (/OverconstrainedError/i.test(n + m)) return 'La cámara no soporta esa combinación de resolución/orientación.';
  if (/secure context|getUserMedia/i.test(m)) return 'Necesitás HTTPS para usar la cámara (GitHub Pages lo provee; en local usá http://localhost).';
  if (/vite|import|module|404/i.test(m)) return `No se pudo cargar un módulo: ${m}`;
  return m || n || 'Error desconocido del visor.';
}

export const I18N = T;
export default UI;
