/**
 * scripts/serve.mjs — servidor estático mínimo para probar el juego en local.
 *
 *   node scripts/serve.mjs [puerto]
 *
 * http://localhost:<puerto> es contexto seguro, así que la cámara funciona sin HTTPS.
 * Sirve la raíz del repo tal como lo hará GitHub Pages (sin build, sin reescrituras).
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }).end('404 ' + path); return; }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'cross-origin-opener-policy': 'same-origin',
      'permissions-policy': 'camera=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)',
    });
    res.end(body);
    console.log(`${new Date().toISOString().slice(11, 19)}  ${path}  ${Math.round(info.size / 1024)} KB`);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err?.message || err));
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`ROBOVISOR AR → http://localhost:${PORT}   (raíz: ${ROOT})`);
});
