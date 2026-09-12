/**
 * scripts/check.mjs — smoke test sin navegador:
 *  1) levanta el servidor estático del repo,
 *  2) extrae TODAS las rutas relativas del HTML y de los imports de los módulos JS,
 *  3) pide cada una y verifica 200 + content-type razonable.
 *
 * Github Pages no reescribe nada, así que si esto pasa en local, pasa en Pages.
 *
 *   node scripts/check.mjs
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, [join(ROOT, 'scripts/serve.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
const wait = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/index.html'); if (r.ok) return; } catch { /* aún no */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('el servidor no respondió');
};

function jsFiles(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) jsFiles(p, acc);
    else if (/\.(m?js)$/.test(p)) acc.push(p);
  }
  return acc;
}

try {
  await wait();
  const targets = new Set(['/', '/index.html', '/manifest.webmanifest', '/sw.js', '/css/app.css']);
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/(?:src|href)="(\.[^"]+)"/g)) targets.add(m[1].replace(/^\./, ''));

  const files = [...jsFiles(join(ROOT, 'js')), ...jsFiles(join(ROOT, 'vendor'))];
  for (const f of files) {
    const src = await readFile(f, 'utf8');
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) targets.add('/' + resolve(dirname(f), m[1]).slice(ROOT.length + 1));
    for (const m of src.matchAll(/(['"])\/?\.\.\/(vendor\/[^'"]+)\1/g)) targets.add('/' + m[2]);
  }
  // Rutas construidas por CONFIG (vendor + wasm).
  const cfg = await import(join(ROOT, 'js/config.js'));
  for (const p of Object.values(cfg.CONFIG.paths)) {
    if (String(p).startsWith('file:')) {
      const rel = new URL(p).pathname.slice(ROOT.length + 1);
      if (rel) targets.add('/' + rel);
    }
  }
  const wasmDir = new URL(cfg.CONFIG.paths.mediapipeWasm).pathname;
  for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']) {
    targets.add('/' + wasmDir.slice(ROOT.length + 1) + '/' + f);
  }

  const bad = [];
  const report = [];
  for (const t of [...targets].filter((x) => /\.[a-z0-9]+$/i.test(x) || x === '/').sort()) {
    const url = BASE + (t.startsWith('/') ? t : '/' + t);
    try {
      const res = await fetch(url);
      const ct = res.headers.get('content-type') || '?';
      const size = res.ok ? (await res.arrayBuffer()).byteLength : 0;
      if (!res.ok) bad.push(`${t} → HTTP ${res.status}`);
      else if (/\.(m?js)$/.test(t) && /octet-stream/.test(ct)) bad.push(`${t} → content-type ${ct} (los módulos ES exigen text/javascript)`);
      else if (size === 0) bad.push(`${t} → archivo vacío`);
      else report.push(`${String(res.status)}  ${(size / 1024).toFixed(0).padStart(6)} KB  ${ct.split(';')[0].padEnd(24)} ${t}`);
    } catch (err) {
      bad.push(`${t} → ${err.message}`);
    }
  }
  console.log(report.join('\n'));
  console.log(`\n${report.length} rutas verificadas, ${bad.length} con problema.`);
  if (bad.length) {
    console.error('\n' + bad.join('\n'));
    process.exitCode = 1;
  }
} finally {
  server.kill('SIGTERM');
}
