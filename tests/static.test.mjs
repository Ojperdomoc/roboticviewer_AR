/**
 * static.test.mjs — verificaciones estáticas que sustituyen a un navegador en el CI
 * local: imports relativos que existen, IDs del DOM que usa la UI, uniformes GLSL
 * declarados y usados, y que no queden especificadores "bare" (no hay import map).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('.css') || p.endsWith('.html')) files.push(p);
  }
})(join(ROOT, 'js'));

const rel = (p) => p.slice(ROOT.length);
const sources = files.filter((f) => /js[\\/]/.test(f));

test('todo import relativo resuelve a un archivo real', () => {
  const broken = [];
  for (const f of sources) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(f), m[1]);
      if (!existsSync(target)) broken.push(`${rel(f)} -> ${m[1]}`);
    }
    for (const m of src.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const target = resolve(dirname(f), m[1]);
      if (!existsSync(target)) broken.push(`${rel(f)} -> dynamic ${m[1]}`);
    }
  }
  assert.deepEqual(broken, [], `imports rotos:\n${broken.join('\n')}`);
});

test('no hay especificadores "bare" (sin import map, sólo rutas relativas)', () => {
  const bad = [];
  for (const f of sources) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/from\s+['"]([^.'"][^'"]*)['"]/g)) bad.push(`${rel(f)}: ${m[1]}`);
  }
  assert.deepEqual(bad, [], `dependencias sin vendorizar/ruta relativa:\n${bad.join('\n')}`);
});

test('el three vendorizado tampoco trae dependencias externas', () => {
  for (const name of ['three.module.js', 'three.core.js']) {
    const src = readFileSync(join(ROOT, 'vendor/three', name), 'utf8');
    const bare = [...src.matchAll(/^import[^'"]*['"]([^.'"][^'"]*)['"]/gm)].map((m) => m[1]);
    assert.deepEqual(bare, [], `${name} importa: ${bare.join(', ')}`);
  }
});

test('los assets estáticos referenciados existen', () => {
  const needed = [
    'index.html', 'css/app.css', 'js/main.js', 'manifest.webmanifest', '.nojekyll',
    'vendor/three/three.module.js', 'vendor/three/three.core.js',
    'vendor/mediapipe/vision_bundle.mjs',
    'vendor/mediapipe/wasm/vision_wasm_internal.js',
    'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
    'vendor/mediapipe/wasm/vision_wasm_nosimd_internal.js',
    'vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
    'sw.js',
  ];
  const missing = needed.filter((p) => !existsSync(join(ROOT, p)));
  assert.deepEqual(missing, [], `faltan: ${missing.join(', ')}`);
});

test('cada id que la UI busca está en el HTML', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const ui = readFileSync(join(ROOT, 'js/ui.js'), 'utf8');
  const ids = new Set([...ui.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)/g)].map((m) => m[1]));
  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(html));
  assert.deepEqual(missing, [], `ids inexistentes: ${missing.join(', ')}`);
});

test('cada clase que la UI consulta existe en el HTML o en el CSS', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const css = readFileSync(join(ROOT, 'css/app.css'), 'utf8');
  const ui = readFileSync(join(ROOT, 'js/ui.js'), 'utf8');
  const classes = new Set([...ui.matchAll(/\$\$?\('\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1]));
  const missing = [...classes].filter((c) => !new RegExp(`class="[^"]*\\b${c}\\b`).test(html) && !css.includes(`.${c}`));
  assert.deepEqual(missing, [], `clases huérfanas: ${missing.join(', ')}`);
});

test('los uniformes del sombreador del compositor están declarados y provistos', () => {
  const src = readFileSync(join(ROOT, 'js/robot/compositor.js'), 'utf8');
  const declared = [...src.matchAll(/uniform\s+\w+\s+(u[A-Z]\w*|t[A-Z]\w*);/g)].map((m) => m[1]);
  const jsKeys = [...src.matchAll(/^\s{6}(t?[A-Za-z]+):\s*\{\s*value:/gm)].map((m) => m[1]);
  const missingInJs = declared.filter((d) => !jsKeys.includes(d));
  const used = [...src.matchAll(/\b(u[A-Z]\w*|t[A-Z]\w*)\b/g)].map((m) => m[1]);
  const undeclared = [...new Set(used)].filter((u) => !declared.includes(u) && !['uniform'].includes(u));
  assert.deepEqual(missingInJs, [], 'uniformes usados en GLSL pero sin valor en JS: ' + missingInJs.join(', '));
  assert.deepEqual(undeclared, [], 'identificadores GLSL sin declarar: ' + undeclared.join(', '));
});

test('el shader se compila en apariencia: sin "varying" sin declarar ni returns huérfanos', () => {
  const src = readFileSync(join(ROOT, 'js/robot/compositor.js'), 'utf8');
  const frag = src.slice(src.indexOf('export const FRAG'), src.indexOf('`;', src.indexOf('export const FRAG')));
  const vary = [...frag.matchAll(/\b(v[A-Z]\w*)\b/g)].map((m) => m[1]);
  for (const v of new Set(vary)) {
    assert.match(frag, new RegExp(`varying\\s+\\w+\\s+${v}\\s*;`), `falta declarar varying ${v}`);
  }
  assert.match(frag, /gl_FragColor\s*=/);
  assert.equal((frag.match(/texture2D\(/g) || []).length >= 3, true, 'el sombreador debería muestrear video + máscara');
});

test('index.html usa sólo rutas relativas (GitHub Pages en subcarpeta)', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const abs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(abs, [], `rutas absolutas que romperían /repo/: ${abs.join(', ')}`);
});

test('CONFIG apunta a archivos vendorizados presentes', async () => {
  const { CONFIG } = await import('../js/config.js');
  const urls = [CONFIG.paths.three, CONFIG.paths.mediapipe, CONFIG.paths.mediapipeWasm];
  for (const u of urls) {
    const p = u.startsWith('file:') ? new URL(u).pathname : join(ROOT, u);
    assert.ok(existsSync(p) && statSync(p).size > 0, `ruta inválida: ${u}`);
  }
  for (const k of Object.keys(CONFIG.vision.modelRel)) {
    assert.ok(CONFIG.vision.models[k]?.length, `sin fuentes para el modelo ${k}`);
  }
});

test('cada parte del cuerpo definida en CONFIG tiene lógica de zócalos', async () => {
  const { BODY_PARTS } = await import('../js/config.js');
  const { socketsFor, buildBody } = await import('../js/track/parts.js');
  const body = buildBody({});
  for (const p of BODY_PARTS) {
    assert.ok(p.id && p.label && p.sockets >= 1, `parte mal definida: ${p.id}`);
    assert.equal(typeof body.parts[p.id], 'object', `buildBody no conoce ${p.id}`);
    assert.deepEqual(socketsFor(body, p.id), [], 'sin partes visibles no debe haber zócalos');
  }
});

test('manifest y service worker son válidos sintácticamente', () => {
  const mf = JSON.parse(readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.ok(mf.name && mf.start_url && mf.display, 'manifest incompleto');
  assert.ok(mf.start_url === './' || mf.start_url === '.', 'start_url debe ser relativo para Pages en subcarpeta');
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  assert.match(sw, /addEventListener\('install'/);
  assert.match(sw, /addEventListener\('activate'/);
});

test('la máscara y el video comparten sistema de coordenadas (alineación con la piel)', async () => {
  const mask = readFileSync(join(ROOT, 'js/robot/mask.js'), 'utf8');
  const comp = readFileSync(join(ROOT, 'js/robot/compositor.js'), 'utf8');
  // 1) La máscara se dibuja en espacio de imagen CRUDO: espejarla acá y muestrearla
  //    espejada en el sombreador sería duplicar el efecto (mano izquierda en la derecha).
  const px = mask.match(/const px = \(p\) =>[^\n]*/)?.[0] || '';
  assert.ok(px, 'mask.js debe proyectar los puntos con una función px()');
  assert.ok(!/mirror|1 - p\.x/.test(px), `px() no debe espejar: ${px}`);
  // 2) El sombreador muestrea tMask con la MISMA transformación que tVideo (cover + espejo).
  assert.doesNotMatch(comp, /texture2D\(\s*tMask\s*,\s*uv\s*\)/,
    'tMask debe muestrearse en la coordenada del video (crop+espejo), no en uv crudo de pantalla');
  assert.match(comp, /vec2\s+mUv\s*=\s*videoUv\(uv\)/, 'falta la coordenada común mUv = videoUv(uv)');
  // 3) El juego vive en espacio de imagen 0..1 en TODOS los modos: el centro de juego se
  //    ajusta al cuerpo y los núcleos nacen adentro del cuadro.
  const rules = readFileSync(join(ROOT, 'js/game/rules.js'), 'utf8');
  assert.match(rules, /setPlayCenter\s*\(/, 'Rules necesita setPlayCenter() para seguir al cuerpo');
  assert.match(rules, /clamp\(\s*seedPos\.x/, 'los núcleos sembrados deben quedar dentro del cuadro');
});

test('RA/VR: espacio de referencia negociado y cámara liberada antes de entrar', async () => {
  const xr = readFileSync(join(ROOT, 'js/xr/xr.js'), 'utf8');
  const game = readFileSync(join(ROOT, 'js/game/game.js'), 'utf8');

  // three.js aborta setSession si requestReferenceSpace falla => hay que arrancar con 'local'
  // (obligatorio en toda sesión inmersiva) y subir a 'local-floor' sólo si el runtime lo da.
  assert.match(xr, /setReferenceSpaceType\('local'\)/, 'xr.js debe fijar el espacio base en "local"');
  assert.match(xr, /for \(const t of \[[^\]]*local-floor[^\]]*\]\)/, 'falta el upgrade a local-floor/bounded-floor');
  assert.doesNotMatch(xr, /setReferenceSpaceType\([^)]*local-floor/, 'no se debe exigir local-floor antes de setSession');
  assert.match(xr, /get hasFloor\(\)/, 'game.js necesita saber si el suelo es conocido');

  // En Android no se puede sostener getUserMedia + immersive-ar: hay que ceder la cámara y
  // recuperarla al salir (si no, la sesión abre con la pantalla negra o no abre).
  const closeAt = game.indexOf('this._camReleased = true;');
  const enterAt = game.indexOf('await this.xr.enter(');
  assert.ok(closeAt > 0 && enterAt > closeAt, 'la cámara debe liberarse ANTES de xr.enter()');
  assert.match(game, /async #restoreCamera\(\)/, 'falta la recuperación de cámara al salir de la sesión');
  assert.match(game, /if \(this\._camReleased\) \{ this\._camReleased = false; await this\.#restoreCamera\(\); \}/,
    'si xr.enter() falla hay que devolverle la cámara al visor');
});
