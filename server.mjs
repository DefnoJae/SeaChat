import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { COLORS, validateProfile, validateReport } from './profile.mjs';
import { MESSAGE_SELECT, ACTIVITY_SELECT, messageRows, messageId, afterId } from './messages.mjs';

import { messageContent } from './media.mjs';

export function createChatServer({ dbPath = 'data/chat.sqlite', adminToken = process.env.ADMIN_TOKEN || '', mediaEnabled = process.env.MEDIA_ENABLED === 'true' } = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, token TEXT UNIQUE, name TEXT, banned INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT, text TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS reports (message_id INTEGER, user_id INTEGER, created_at TEXT, PRIMARY KEY(message_id,user_id));`);
  for (const [table, column, definition] of [
    ['users','color',"TEXT NOT NULL DEFAULT '#a78bfa'"], ['users','avatar',"TEXT NOT NULL DEFAULT ''"],
    ['users','avatar_version',"TEXT NOT NULL DEFAULT ''"], ['reports','reason',"TEXT NOT NULL DEFAULT 'Other'"], ['reports','details',"TEXT NOT NULL DEFAULT ''"],
    ['messages','reply_to_id','INTEGER'], ['messages','reply_to_user_id','INTEGER'], ['messages','attachment','TEXT']
  ]) if (!db.prepare('PRAGMA table_info(' + table + ')').all().some(row => row.name === column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
  db.exec('CREATE INDEX IF NOT EXISTS messages_by_reply_recipient ON messages(reply_to_user_id,id)');
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
  async function body(req, maxBytes = 8192) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > maxBytes) fail(413, 'Request too large.');
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
          return reply(res, 200, db.prepare(`SELECT r.message_id, m.user_id, m.name, m.text, m.attachment, COUNT(*) AS report_count, json_group_array(json_object('reason',r.reason,'details',r.details)) AS reports FROM reports r LEFT JOIN messages m ON r.message_id=m.id GROUP BY r.message_id`).all());
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
        const result = db.prepare('INSERT INTO users(token,name,color) VALUES(?,?,?)').run(hash(token), name, COLORS[randomBytes(1)[0] % COLORS.length]);
        return reply(res, 201, { token, userId: Number(result.lastInsertRowid), name });
      }
      const user = credential ? db.prepare('SELECT id,name,banned,color,avatar,avatar_version FROM users WHERE token=?').get(hash(credential)) : null;
      if (!user) fail(401, 'Join the room first.');
      if (user.banned) fail(403, 'This account has been banned.');
      if (['PATCH', 'DELETE'].includes(req.method) && /^\/messages\/\d+$/.test(url.pathname)) {
        const id = messageId(Number(url.pathname.split('/').pop()));
        const message = db.prepare('SELECT user_id,attachment FROM messages WHERE id=?').get(id);
        if (!message) fail(404, 'Message is no longer available.');
        if (message.user_id !== user.id) fail(403, 'You can only change your own messages.');
        throttle('message-change:' + user.id, 20, 60_000);
        if (req.method === 'PATCH') {
          const data = await body(req);
          const text = typeof data.text === 'string' ? data.text.trim() : '';
          if ((!text && !message.attachment) || text.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail(400, 'Messages must contain 1–1000 characters.');
          if (!db.prepare('UPDATE messages SET text=? WHERE id=? AND user_id=?').run(text, id, user.id).changes) fail(404, 'Message is no longer available.');
        } else {
          db.prepare('DELETE FROM messages WHERE id=? AND user_id=?').run(id, user.id);
          db.prepare('DELETE FROM reports WHERE message_id=?').run(id);
        }
        return reply(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/activity') {
        const activity = db.prepare(ACTIVITY_SELECT).get(afterId(url.searchParams.get('after')), user.id);
        return reply(res, 200, activity);
      }
      if (req.method === 'GET' && url.pathname === '/replies') return reply(res, 200, { replies: db.prepare('SELECT id,created_at AS createdAt FROM messages WHERE reply_to_user_id=? AND user_id<>? AND id>? ORDER BY id LIMIT 1000').all(user.id, user.id, afterId(url.searchParams.get('after'))) });
      if (req.method === 'GET' && /^\/messages\/context\/\d+$/.test(url.pathname)) {
        const id = messageId(Number(url.pathname.split('/').pop()));
        const rows = db.prepare(MESSAGE_SELECT + ` WHERE m.id IN (SELECT id FROM messages WHERE id<=? ORDER BY id DESC LIMIT 50)
          OR m.id IN (SELECT id FROM messages WHERE id>? ORDER BY id LIMIT 50) ORDER BY m.id`).all(id, id);
        if (!rows.some(m => m.id === id)) fail(404, 'Message is no longer available.');
        return reply(res, 200, { messages: messageRows(rows), targetId: id });
      }
      if (req.method === 'GET' && url.pathname === '/profile') return reply(res, 200, { userId: user.id, name: user.name, color: user.color, avatar: user.avatar, avatarVersion: user.avatar_version });
      if (req.method === 'PUT' && url.pathname === '/profile') {
        throttle('profile:' + user.id, 20, 60_000);
        const profile = validateProfile(await body(req, 36000));
        const version = profile.avatar === user.avatar ? user.avatar_version : randomBytes(16).toString('hex');
        db.prepare('UPDATE users SET name=?,color=?,avatar=?,avatar_version=? WHERE id=?').run(profile.name, profile.color, profile.avatar, version, user.id);
        return reply(res, 200, { userId: user.id, ...profile, avatarVersion: version });
      }
      if (req.method === 'GET' && /^\/avatars\/\d+$/.test(url.pathname)) {
        const profile = db.prepare('SELECT avatar,avatar_version FROM users WHERE id=? AND banned=0').get(Number(url.pathname.split('/').pop()));
        if (!profile) fail(404, 'Profile not found.');
        return reply(res, 200, { avatar: profile.avatar, avatarVersion: profile.avatar_version });
      }
      if (req.method === 'GET' && url.pathname === '/messages') {
        const messages = db.prepare(MESSAGE_SELECT + ' ORDER BY m.id DESC LIMIT 100').all().reverse();
        const activity = db.prepare(ACTIVITY_SELECT).get(afterId(url.searchParams.get('after')), user.id);
        return reply(res, 200, { messages: messageRows(messages), activity });
      }
      if (req.method === 'POST' && url.pathname === '/messages') {
        const data = await body(req);
        const { text, attachment } = messageContent(data, mediaEnabled);
        const replyToId = messageId(data.replyToId, true);
        const original = replyToId === null ? null : db.prepare('SELECT user_id FROM messages WHERE id=?').get(replyToId);
        if (replyToId !== null && !original) fail(404, 'Original message is no longer available.');
        throttle('send:' + user.id, 1, 2000);
        throttle('sendip:' + ip, 20, 60_000);
        const createdAt = new Date().toISOString();
        const result = db.prepare('INSERT INTO messages(user_id,name,text,created_at,reply_to_id,reply_to_user_id,attachment) VALUES(?,?,?,?,?,?,?)').run(user.id, user.name, text, createdAt, replyToId, original?.user_id ?? null, attachment ? JSON.stringify(attachment) : null);
        db.prepare('DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 1000)').run();
        db.prepare('DELETE FROM reports WHERE message_id NOT IN (SELECT id FROM messages)').run();
        return reply(res, 201, { id: Number(result.lastInsertRowid), userId: user.id, name: user.name, text, attachment, createdAt });
      }
      if (req.method === 'POST' && /^\/messages\/\d+\/report$/.test(url.pathname)) {
        throttle('report:' + user.id, 10, 60_000);
        const report = validateReport(await body(req));
        const id = Number(url.pathname.split('/')[2]);
        if (!db.prepare('SELECT id FROM messages WHERE id=?').get(id)) fail(404, 'Message no longer exists.');
        db.prepare('INSERT OR IGNORE INTO reports(message_id,user_id,created_at,reason,details) VALUES(?,?,?,?,?)').run(id, user.id, new Date().toISOString(), report.reason, report.details);
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
