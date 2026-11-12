import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getIndex, answer, answerStream, CONFIG } from './rag.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
}

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, { ok: false, error: 'bad url' });
  }
  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(WEB, '.' + pathname);
  if (file !== WEB && !file.startsWith(WEB + path.sep)) {
    return send(res, 403, { ok: false, error: 'forbidden' });
  }
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { ok: false, error: 'not found' });
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

function readJson(req, limit = 10000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

const idx = await getIndex();

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (pathname === '/api/health') {
    return send(res, 200, {
      ok: true,
      chunks: idx.chunks.length,
      dim: idx.dim,
      models: {
        embed: CONFIG.embedModel,
        rerank: CONFIG.rerankModel,
        chat: CONFIG.chatModel
      }
    });
  }

  if (pathname === '/api/ask/stream' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return send(res, 400, { ok: false, error: err.message });
    }
    const question = String(body.question || '').trim();
    if (!question) return send(res, 400, { ok: false, error: 'question required' });
    if (question.length > 200) return send(res, 400, { ok: false, error: 'question too long (max 200)' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const sendEvent = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const started = Date.now();

    try {
      await answerStream(question, idx, {
        onStatus: stage => sendEvent('status', { stage }),
        onMeta: meta => sendEvent('meta', meta),
        onToken: delta => sendEvent('token', { text: delta })
      });
      sendEvent('done', { elapsedMs: Date.now() - started });
    } catch (err) {
      sendEvent('error', { message: err.message });
    } finally {
      res.end();
    }
    return;
  }

  if (pathname === '/api/ask' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const question = String(body.question || '').trim();
      if (!question) return send(res, 400, { ok: false, error: 'question required' });
      if (question.length > 200) return send(res, 400, { ok: false, error: 'question too long (max 200)' });

      const started = Date.now();
      const r = await answer(question, idx);
      return send(res, 200, {
        ok: true,
        question,
        rewritten: r.searchQuery,
        answer: r.text,
        citations: r.top.map((c, i) => ({
          n: i + 1,
          section: c.section,
          title: c.title,
          url: c.url,
          rerank: c.rerank,
          sim: c.sim
        })),
        elapsedMs: Date.now() - started
      });
    } catch (err) {
      return send(res, 500, { ok: false, error: err.message });
    }
  }

  if (pathname.startsWith('/api/')) {
    return send(res, 404, { ok: false, error: 'not found' });
  }

  return serveStatic(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`RAG demo running at http://127.0.0.1:${PORT}`);
  console.log(`chunks=${idx.chunks.length} dim=${idx.dim}`);
});
