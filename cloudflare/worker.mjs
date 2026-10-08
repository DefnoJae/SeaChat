const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const reply = (status, value) => Response.json(value, {
  status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
});
async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'Expected a JSON object.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); fail(413, 'Request too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let data;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400, 'Invalid JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'Expected a JSON object.');
  return data;
}
async function limit(binding, key) {
  if (!binding) fail(503, 'Rate limiter is not configured.');
  if (!(await binding.limit({ key: 'seachat:' + key })).success) fail(429, 'Slow down and try again shortly.');
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health') return reply(200, { ok: true });
      if (!env.DB) fail(503, 'Chat database is not configured.');
      // Cloudflare sets this at its edge. This Worker must run behind that edge.
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      await limit(env.REQUEST_LIMIT, ip);
      const credential = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
      const credentialHash = await hash(credential);
      const statement = (sql, ...values) => env.DB.prepare(sql).bind(...values);
      if (url.pathname.startsWith('/admin/')) {
        if (!env.ADMIN_TOKEN || credentialHash !== await hash(env.ADMIN_TOKEN)) fail(401, 'Admin authentication required.');
        if (request.method === 'GET' && url.pathname === '/admin/reports') {
          const result = await statement(`SELECT r.message_id, m.user_id, m.name, m.text, COUNT(*) AS report_count
            FROM reports r JOIN messages m ON r.message_id=m.id GROUP BY r.message_id LIMIT 100`).all();
          return reply(200, result.results);
        }
        if (request.method === 'DELETE' && /^\/admin\/messages\/\d+$/.test(url.pathname)) {
          await statement('DELETE FROM messages WHERE id=?', Number(url.pathname.split('/').pop())).run();
          return reply(200, { ok: true });
        }
        if (request.method === 'POST' && url.pathname === '/admin/ban') {
          const data = await readBody(request);
          if (!Number.isSafeInteger(data.userId) || data.userId < 1) fail(400, 'Invalid userId.');
          await env.DB.batch([
            statement('UPDATE users SET banned=1 WHERE id=?', data.userId),
            statement('DELETE FROM messages WHERE user_id=?', data.userId)
          ]);
          return reply(200, { ok: true });
        }
        fail(404, 'Unknown admin endpoint.');
      }
      if (request.method === 'POST' && url.pathname === '/sessions') {
        await limit(env.SESSION_LIMIT, ip);
        const data = await readBody(request);
        const name = typeof data.name === 'string' ? data.name.trim() : '';
        if (!/^[\p{L}\p{N}_ -]{2,24}$/u.test(name)) fail(400, 'Use a name of 2–24 letters, numbers, spaces, underscores or hyphens.');
        const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
        const result = await statement('INSERT INTO users(token,name) VALUES(?,?) RETURNING id', await hash(token), name).first();
        return reply(201, { token, userId: result.id, name });
      }
      const user = credential ? await statement('SELECT id,name,banned FROM users WHERE token=?', credentialHash).first() : null;
      if (!user) fail(401, 'Join the room first.');
      if (user.banned) fail(403, 'This account has been banned.');
      if (request.method === 'GET' && url.pathname === '/messages') {
        const current = await statement('SELECT revision FROM room WHERE id=1').first();
        if (url.searchParams.get('revision') === current.revision) return reply(200, { unchanged: true, revision: current.revision });
        // A transactional batch makes the revision and history a consistent snapshot.
        const results = await env.DB.batch([
          statement('SELECT revision FROM room WHERE id=1'),
          statement('SELECT id,user_id AS userId,name,text,created_at AS createdAt FROM messages ORDER BY id DESC LIMIT 100')
        ]);
        return reply(200, { revision: results[0].results[0].revision, messages: results[1].results.reverse() });
      }
      if (request.method === 'POST' && url.pathname === '/messages') {
        const data = await readBody(request);
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        if (!text || text.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail(400, 'Messages must contain 1–1000 characters.');
        await limit(env.WRITE_LIMIT, 'send:' + ip);
        const now = Date.now(), requestId = crypto.randomUUID(), createdAt = new Date(now).toISOString();
        // D1 batches are transactions: simultaneous sends cannot bypass the two-second limit.
        const results = await env.DB.batch([
          statement(`INSERT INTO messages(request_id,user_id,name,text,created_at)
            SELECT ?,id,name,?,? FROM users WHERE id=? AND banned=0 AND last_sent_at<=? RETURNING id`,
            requestId, text, createdAt, user.id, now - 2000),
          statement(`UPDATE users SET last_sent_at=? WHERE id=? AND EXISTS (SELECT 1 FROM messages WHERE request_id=?)`, now, user.id, requestId)
        ]);
        if (!results[0].results.length) fail(429, 'Wait two seconds before sending again.');
        return reply(201, { id: results[0].results[0].id, userId: user.id, name: user.name, text, createdAt });
      }
      if (request.method === 'POST' && /^\/messages\/\d+\/report$/.test(url.pathname)) {
        await limit(env.WRITE_LIMIT, 'report:' + user.id);
        const id = Number(url.pathname.split('/')[2]);
        const result = await statement(`INSERT OR IGNORE INTO reports(message_id,user_id,created_at)
          SELECT id,?,? FROM messages WHERE id=? RETURNING message_id`, user.id, new Date().toISOString(), id).first();
        if (!result && !await statement('SELECT id FROM messages WHERE id=?', id).first()) fail(404, 'Message no longer exists.');
        return reply(200, { ok: true });
      }
      fail(404, 'Unknown endpoint.');
    } catch (error) {
      return reply(error.status || 503, { error: error.status ? error.message : 'Chat temporarily unavailable. Free hosting may have reached its daily limit; try again later.' });
    }
  }
};
