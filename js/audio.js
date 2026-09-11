/**
 * xr.js — utilidades de entrada háptica y audio sintetizado (sin archivos).
 */

import { clamp } from './util.js';

const NOTE = {
  ui: 620, grab: 880, release: 520, install: 1320, reject: 180, damage: 120,
  objective: 990, round: 660, over: 220, gesture: 760, scan: 440, upgrade: 1560,
};

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.hum = null;
  }

  ensure() {
    if (this.ctx || typeof window === 'undefined') return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return null; }
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.22;
      this.master.connect(this.ctx.destination);
    } catch { this.enabled = false; }
    return this.ctx;
  }

  resume() { const c = this.ensure(); if (c && c.state === 'suspended') c.resume().catch(() => {}); }

  tone({ freq = 440, dur = 0.12, type = 'sine', gain = 0.5, glide = 0, delay = 0, filter = 0 } = {}) {
    const c = this.ensure();
    if (!c || !this.enabled) return;
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq * glide), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = osc;
    if (filter) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = filter;
      node.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  noise({ dur = 0.18, gain = 0.25, freq = 900, delay = 0 } = {}) {
    const c = this.ensure();
    if (!c || !this.enabled) return;
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(c.currentTime + delay);
  }

  /** Zumbido de servo en reposo (se atenúa cuando el juego está en pausa). */
  hum(on) {
    const c = this.ensure();
    if (!c || !this.enabled) return;
    if (on && !this.hum) {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = 58;
      g.gain.value = 0.03;
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 220;
      osc.connect(f); f.connect(g); g.connect(this.master);
      osc.start();
      this.hum = { osc, gain: g };
    } else if (!on && this.hum) {
      try { this.hum.osc.stop(); } catch { /* noop */ }
      this.hum = null;
    } else if (this.hum) {
      this.hum.gain.gain.value = on ? 0.03 : 0.006;
    }
  }

  setEnergy(e) {
    if (this.hum) this.hum.gain.gain.value = 0.02 + clamp(e, 0, 1) * 0.05;
  }

  play(kind, opts = {}) {
    switch (kind) {
      case 'grab':
        this.tone({ freq: NOTE.grab, dur: 0.07, type: 'square', gain: 0.25 });
        this.tone({ freq: NOTE.grab * 1.5, dur: 0.05, type: 'sine', gain: 0.18, delay: 0.04 });
        break;
      case 'release':
        this.tone({ freq: NOTE.release, dur: 0.09, type: 'triangle', gain: 0.2, glide: 0.7 });
        break;
      case 'installed':
        this.tone({ freq: NOTE.install, dur: 0.1, type: 'square', gain: 0.22 });
        this.tone({ freq: NOTE.upgrade, dur: 0.16, type: 'sine', gain: 0.2, delay: 0.07 });
        this.noise({ dur: 0.12, gain: 0.12, freq: 2600, delay: 0.02 });
        break;
      case 'reject':
      case 'damage':
        this.tone({ freq: NOTE[kind] || NOTE.reject, dur: 0.22, type: 'sawtooth', gain: 0.3, glide: 0.5, filter: 700 });
        this.noise({ dur: 0.2, gain: 0.16, freq: 300 });
        break;
      case 'objective':
        this.tone({ freq: NOTE.objective, dur: 0.1, type: 'square', gain: 0.2 });
        this.tone({ freq: NOTE.objective * 1.26, dur: 0.12, type: 'square', gain: 0.18, delay: 0.09 });
        break;
      case 'round':
        for (let i = 0; i < 4; i++) this.tone({ freq: 520 * Math.pow(1.19, i), dur: 0.14, type: 'triangle', gain: 0.2, delay: i * 0.09 });
        break;
      case 'over':
        for (let i = 0; i < 4; i++) this.tone({ freq: 420 / Math.pow(1.22, i), dur: 0.3, type: 'sawtooth', gain: 0.22, delay: i * 0.16, filter: 900 });
        break;
      case 'scan':
        this.tone({ freq: NOTE.scan, dur: 0.05, type: 'sine', gain: 0.07, glide: 1.6 });
        break;
      case 'gesture':
        this.tone({ freq: NOTE.gesture * (opts.up ? 1.25 : 1), dur: 0.06, type: 'triangle', gain: 0.14 });
        break;
      default:
        this.tone({ freq: NOTE.ui, dur: 0.05, type: 'square', gain: 0.12 });
    }
  }

  /** Vibración del celular (si el navegador la permite). */
  static buzz(pattern) {
    try { navigator.vibrate?.(pattern); } catch { /* sin háptica */ }
  }
}

export default Sfx;
