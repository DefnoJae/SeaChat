import { klipyRequest } from '../klipy.mjs';
import { COLORS, validateProfile, validateReport } from '../profile.mjs';
import { MESSAGE_SELECT, ACTIVITY_SELECT, messageRows, messageId, afterId } from '../messages.mjs';
import { messageContent } from '../media.mjs';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const reply = (status, value) => Response.json(value, {
  status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
});
async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
async function readBody(request, maxBytes = 8192) {
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'Expected a JSON object.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); fail(413, 'Request too large.'); }
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
        if (!env.ADMIN_TOKEN || !crypto.subtle.timingSafeEqual(new TextEncoder().encode(credentialHash), new TextEncoder().encode(await hash(env.ADMIN_TOKEN)))) fail(401, 'Admin authentication required.');
        if (request.method === 'GET' && url.pathname === '/admin/reports') {
          const result = await statement(`SELECT r.message_id, m.user_id, m.name, m.text, m.attachment, COUNT(*) AS report_count,
            json_group_array(json_object('reason',r.reason,'details',r.details)) AS reports
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
        const color = COLORS[crypto.getRandomValues(new Uint8Array(1))[0] % COLORS.length];
        const result = await statement('INSERT INTO users(token,name,color) VALUES(?,?,?) RETURNING id', await hash(token), name, color).first();
        return reply(201, { token, userId: result.id, name });
      }
      const user = credential ? await statement('SELECT id,name,banned,color,avatar,avatar_version FROM users WHERE token=?', credentialHash).first() : null;
      if (!user) fail(401, 'Join the room first.');
      if (user.banned) fail(403, 'This account has been banned.');
      if (request.method === 'POST' && url.pathname === '/presence') {
        const data=await readBody(request);if(typeof data.open!=='boolean')fail(400,'Invalid presence state.');
        const now=Date.now();
        const result=await env.DB.batch([
          statement('DELETE FROM presence WHERE seen_at<?',now-45000),
          data.open?statement('INSERT INTO presence(user_id,seen_at) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET seen_at=excluded.seen_at',user.id,now):statement('DELETE FROM presence WHERE user_id=?',user.id),
          statement('SELECT COUNT(*) AS count FROM presence p JOIN users u ON u.id=p.user_id WHERE u.banned=0 AND p.seen_at>=?',now-45000)
        ]);
        return reply(200,{activeCount:result[2].results[0].count});
      }
      if (request.method === 'POST' && url.pathname === '/media') {
        if(env.MEDIA_ENABLED !== 'true') fail(503, 'Media is disabled.');
        await limit(env.WRITE_LIMIT, 'media:' + user.id);
        return reply(200, await klipyRequest(await readBody(request), user.id, env.KLIPY_API_KEY));
      }
      if (['PATCH', 'DELETE'].includes(request.method) && /^\/messages\/\d+$/.test(url.pathname)) {
        const id = messageId(Number(url.pathname.split('/').pop()));
        const message = await statement('SELECT user_id,attachment FROM messages WHERE id=?', id).first();
        if (!message) fail(404, 'Message is no longer available.');
        if (message.user_id !== user.id) fail(403, 'You can only change your own messages.');
        await limit(env.WRITE_LIMIT, 'message-change:' + user.id);
        if (request.method === 'PATCH') {
          const data = await readBody(request);
          const text = typeof data.text === 'string' ? data.text.trim() : '';
          if ((!text && !message.attachment) || text.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail(400, 'Messages must contain 1–1000 characters.');
          const result = await statement('UPDATE messages SET text=? WHERE id=? AND user_id=? RETURNING id', text, id, user.id).first();
          if (!result) fail(404, 'Message is no longer available.');
        } else {
          const result = await statement('DELETE FROM messages WHERE id=? AND user_id=? RETURNING id', id, user.id).first();
          if (!result) fail(404, 'Message is no longer available.');
        }
        return reply(200, { ok: true });
      }
      if (request.method === 'GET' && url.pathname === '/activity') {
        const activity = await statement(ACTIVITY_SELECT, afterId(url.searchParams.get('after')), user.id).first();
        return reply(200, activity);
      }
      if (request.method === 'GET' && url.pathname === '/replies') {
        const result = await statement('SELECT id,created_at AS createdAt FROM messages WHERE reply_to_user_id=? AND user_id<>? AND id>? ORDER BY id LIMIT 1000', user.id, user.id, afterId(url.searchParams.get('after'))).all();
        return reply(200, { replies: result.results });
      }
      if (request.method === 'GET' && /^\/messages\/context\/\d+$/.test(url.pathname)) {
        const id = messageId(Number(url.pathname.split('/').pop()));
        const result = await statement(MESSAGE_SELECT + ` WHERE m.id IN (SELECT id FROM messages WHERE id<=? ORDER BY id DESC LIMIT 50)
          OR m.id IN (SELECT id FROM messages WHERE id>? ORDER BY id LIMIT 50) ORDER BY m.id`, id, id).all();
        if (!result.results.some(m => m.id === id)) fail(404, 'Message is no longer available.');
        return reply(200, { messages: messageRows(result.results), targetId: id });
      }
      if (request.method === 'GET' && url.pathname === '/profile') return reply(200, { userId: user.id, name: user.name, color: user.color, avatar: user.avatar, avatarVersion: user.avatar_version });
      if (request.method === 'PUT' && url.pathname === '/profile') {
        await limit(env.WRITE_LIMIT, 'profile:' + user.id);
        const profile = validateProfile(await readBody(request, 36000));
        const version = profile.avatar === user.avatar ? user.avatar_version : crypto.randomUUID();
        await env.DB.batch([
          statement('UPDATE users SET name=?,color=?,avatar=?,avatar_version=? WHERE id=? AND banned=0', profile.name, profile.color, profile.avatar, version, user.id),
          statement('UPDATE room SET revision=lower(hex(randomblob(16))) WHERE id=1')
        ]);
        return reply(200, { userId: user.id, ...profile, avatarVersion: version });
      }
      if (request.method === 'GET' && /^\/avatars\/\d+$/.test(url.pathname)) {
        const profile = await statement('SELECT avatar,avatar_version FROM users WHERE id=? AND banned=0', Number(url.pathname.split('/').pop())).first();
        if (!profile) fail(404, 'Profile not found.');
        return reply(200, { avatar: profile.avatar, avatarVersion: profile.avatar_version });
      }
      if (request.method === 'GET' && url.pathname === '/messages') {
        const after = afterId(url.searchParams.get('after'));
        const summary = await env.DB.batch([statement('SELECT revision FROM room WHERE id=1'), statement(ACTIVITY_SELECT, after, user.id)]);
        if (url.searchParams.get('revision') === summary[0].results[0].revision) return reply(200, { unchanged: true, revision: summary[0].results[0].revision, activity: summary[1].results[0] });
        const results = await env.DB.batch([statement('SELECT revision FROM room WHERE id=1'), statement(MESSAGE_SELECT + ' ORDER BY m.id DESC LIMIT 100'), statement(ACTIVITY_SELECT, after, user.id)]);
        return reply(200, { revision: results[0].results[0].revision, messages: messageRows(results[1].results.reverse()), activity: results[2].results[0] });
      }
      if (request.method === 'POST' && url.pathname === '/messages') {
        const data = await readBody(request);
        const { text, attachment, spoiler } = messageContent(data, env.MEDIA_ENABLED === 'true');
        const replyToId = messageId(data.replyToId, true);
        if (replyToId !== null && !await statement('SELECT id FROM messages WHERE id=?', replyToId).first()) fail(404, 'Original message is no longer available.');
        await limit(env.WRITE_LIMIT, 'send:' + ip);
        const now = Date.now(), requestId = crypto.randomUUID(), createdAt = new Date(now).toISOString();
        // D1 batches are transactions: simultaneous sends cannot bypass the two-second limit.
        const results = await env.DB.batch([
          statement(`INSERT INTO messages(request_id,user_id,name,text,created_at,reply_to_id,reply_to_user_id,attachment,spoiler)
            SELECT ?,id,name,?,?,?,(SELECT user_id FROM messages WHERE id=?),?,? FROM users
            WHERE id=? AND banned=0 AND last_sent_at<=? AND (? IS NULL OR EXISTS(SELECT 1 FROM messages WHERE id=?)) RETURNING id`,
            requestId, text, createdAt, replyToId, replyToId, attachment ? JSON.stringify(attachment) : null, Number(spoiler), user.id, now - 2000, replyToId, replyToId),
          statement(`UPDATE users SET last_sent_at=? WHERE id=? AND EXISTS (SELECT 1 FROM messages WHERE request_id=?)`, now, user.id, requestId)
        ]);
        if (!results[0].results.length) {
          if (replyToId !== null && !await statement('SELECT id FROM messages WHERE id=?', replyToId).first()) fail(404, 'Original message is no longer available.');
          fail(429, 'Wait two seconds before sending again.');
        }
        return reply(201, { id: results[0].results[0].id, userId: user.id, name: user.name, text, attachment, spoiler, createdAt });
      }
      if (request.method === 'POST' && /^\/messages\/\d+\/report$/.test(url.pathname)) {
        await limit(env.WRITE_LIMIT, 'report:' + user.id);
        const report = validateReport(await readBody(request));
        const id = Number(url.pathname.split('/')[2]);
        const result = await statement(`INSERT OR IGNORE INTO reports(message_id,user_id,created_at,reason,details)
          SELECT id,?,?,?,? FROM messages WHERE id=? RETURNING message_id`, user.id, new Date().toISOString(), report.reason, report.details, id).first();
        if (!result && !await statement('SELECT id FROM messages WHERE id=?', id).first()) fail(404, 'Message no longer exists.');
        return reply(200, { ok: true });
      }
      fail(404, 'Unknown endpoint.');
    } catch (error) {
      return reply(error.status || 503, { error: error.status ? error.message : 'Chat temporarily unavailable. Free hosting may have reached its daily limit; try again later.' });
    }
  }
};
