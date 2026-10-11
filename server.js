import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApi, HttpError } from './app.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export function createApp(db = openDb()) {
  const api = createApi(db);
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      if (url.pathname.startsWith('/api/')) {
        let body = {};
        if (req.method !== 'GET' && req.method !== 'DELETE') {
          let raw = '';
          for await (const c of req) { raw += c; if (raw.length > 1e6) throw new HttpError(413, 'Payload terlalu besar'); }
          try { body = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'JSON tidak valid'); }
        }
        const out = api(req.method, url.pathname, Object.fromEntries(url.searchParams), body);
        return Array.isArray(out) && typeof out[0] === 'number' ? send(out[0], out[1]) : send(200, out);
      }
      const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
      const file = join(root, rel);
      if (!file.startsWith(root)) throw new HttpError(403, 'Dilarang');
      const data = await readFile(file).catch(() => { throw new HttpError(404, 'Tidak ditemukan'); });
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e);
      send(500, { error: 'Kesalahan server' });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`Stok Gudang berjalan di http://localhost:${port}`));
}
