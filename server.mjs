import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function createChatServer({ dbPath = 'data/chat.sqlite', adminToken = process.env.ADMIN_TOKEN || '' } = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, token TEXT UNIQUE, name TEXT, banned INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT, text TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS reports (message_id INTEGER, user_id INTEGER, created_at TEXT, PRIMARY KEY(message_id,user_id));`);
  const limits = new Map();
  const hash = value => createHash('sha256').update(value).digest('hex');
  const reply = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(data));
  };
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  const throttle = (key, max, window) => {
    const now = Date.now();
    const recent = (limits.get(key) || []).filter(t => t > now - window);
    if (recent.length >= max) fail(429, 'Slow down and try again shortly.');
    recent.push(now); limits.set(key, recent);
  };
  const cleanup = setInterval(() => {
    const before = Date.now() - 60_000;
    for (const [key, times] of limits) if (!times.some(t => t > before)) limits.delete(key);
  }, 60_000);
  cleanup.unref();
  async function body(req) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 8192) fail(413, 'Request too large.');
      chunks.push(chunk);
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, 'Expected a JSON object.');
      return parsed;
    } catch { fail(400, 'Invalid JSON object.'); }
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const ip = req.socket.remoteAddress; // Forwarded headers are deliberately not trusted.
      const credential = String(req.headers.authorization || '').replace(/^Bearer /, '');
      if (url.pathname === '/health' && req.method === 'GET') return reply(res, 200, { ok: true });
      throttle('request:' + ip, 180, 60_000);
      if (url.pathname.startsWith('/admin/')) {
        const a = Buffer.from(hash(credential)), b = Buffer.from(hash(adminToken));
        if (!adminToken || !timingSafeEqual(a, b)) fail(401, 'Admin authentication required.');
        if (req.method === 'GET' && url.pathname === '/admin/reports') {
          return reply(res, 200, db.prepare(`SELECT r.message_id, m.user_id, m.name, m.text, COUNT(*) AS report_count FROM reports r LEFT JOIN messages m ON r.message_id=m.id GROUP BY r.message_id`).all());
        }
        if (req.method === 'POST' && url.pathname === '/admin/ban') {
          const data = await body(req);
          if (!Number.isSafeInteger(data.userId)) fail(400, 'Invalid userId.');
          db.prepare('UPDATE users SET banned=1 WHERE id=?').run(data.userId);
          db.prepare('DELETE FROM messages WHERE user_id=?').run(data.userId);
          return reply(res, 200, { ok: true });
        }
        if (req.method === 'DELETE' && /^\/admin\/messages\/\d+$/.test(url.pathname)) {
          const id = Number(url.pathname.split('/').pop());
          db.prepare('DELETE FROM messages WHERE id=?').run(id);
          return reply(res, 200, { ok: true });
        }
        fail(404, 'Unknown admin endpoint.');
      }
      if (req.method === 'POST' && url.pathname === '/sessions') {
        throttle('session:' + ip, 5, 60_000);
        const data = await body(req);
        const name = typeof data.name === 'string' ? data.name.trim() : '';
        if (!/^[\p{L}\p{N}_ -]{2,24}$/u.test(name)) fail(400, 'Use a name of 2–24 letters, numbers, spaces, underscores or hyphens.');
        const token = randomBytes(32).toString('hex');
        const result = db.prepare('INSERT INTO users(token,name) VALUES(?,?)').run(hash(token), name);
        return reply(res, 201, { token, userId: Number(result.lastInsertRowid), name });
      }
      const user = credential ? db.prepare('SELECT id,name,banned FROM users WHERE token=?').get(hash(credential)) : null;
      if (!user) fail(401, 'Join the room first.');
      if (user.banned) fail(403, 'This account has been banned.');
      if (req.method === 'GET' && url.pathname === '/messages') {
        const messages = db.prepare('SELECT id,user_id AS userId,name,text,created_at AS createdAt FROM messages ORDER BY id DESC LIMIT 100').all().reverse();
        return reply(res, 200, { messages });
      }
      if (req.method === 'POST' && url.pathname === '/messages') {
        const data = await body(req);
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        if (!text || text.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail(400, 'Messages must contain 1–1000 characters.');
        throttle('send:' + user.id, 1, 2000);
        throttle('sendip:' + ip, 20, 60_000);
        const createdAt = new Date().toISOString();
        const result = db.prepare('INSERT INTO messages(user_id,name,text,created_at) VALUES(?,?,?,?)').run(user.id, user.name, text, createdAt);
        db.prepare('DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 1000)').run();
        db.prepare('DELETE FROM reports WHERE message_id NOT IN (SELECT id FROM messages)').run();
        return reply(res, 201, { id: Number(result.lastInsertRowid), userId: user.id, name: user.name, text, createdAt });
      }
      if (req.method === 'POST' && /^\/messages\/\d+\/report$/.test(url.pathname)) {
        throttle('report:' + user.id, 10, 60_000);
        const id = Number(url.pathname.split('/')[2]);
        if (!db.prepare('SELECT id FROM messages WHERE id=?').get(id)) fail(404, 'Message no longer exists.');
        db.prepare('INSERT OR IGNORE INTO reports VALUES(?,?,?)').run(id, user.id, new Date().toISOString());
        return reply(res, 200, { ok: true });
      }
      fail(404, 'Unknown endpoint.');
    } catch (error) {
      if (!res.headersSent) reply(res, error.status || 500, { error: error.status ? error.message : 'Server error.' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on('close', () => { clearInterval(cleanup); db.close(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createChatServer({ dbPath: process.env.DB_PATH || 'data/chat.sqlite' });
  server.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1', () => console.log('Global chat server listening on', server.address()));
}
