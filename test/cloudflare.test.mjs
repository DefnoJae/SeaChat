import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('Cloudflare runtime: shared D1 history, quiet polls, moderation, races, retention and IP limits', async t => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'seachat-test',
    modules: [
      { type: 'ESModule', path: fileURLToPath(new URL('../cloudflare/worker.mjs', import.meta.url)) },
      { type: 'ESModule', path: fileURLToPath(new URL('../profile.mjs', import.meta.url)) },
      { type: 'ESModule', path: fileURLToPath(new URL('../messages.mjs', import.meta.url)) },
      { type: 'ESModule', path: fileURLToPath(new URL('../media.mjs', import.meta.url)) }
    ],
    compatibilityDate: config.compatibility_date,
    d1Databases: { DB: 'seachat-test' },
    bindings: { ADMIN_TOKEN: 'test-admin' },
    ratelimits: Object.fromEntries(config.ratelimits.map(({ name, ...value }) => [name, value]))
  }] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const migration = readFileSync(new URL('../cloudflare/migrations/0001_chat.sql', import.meta.url), 'utf8');
  // Keep complete trigger bodies together, rather than splitting on their inner semicolons.
  const statements = migration.split(/;\s*(?=CREATE|INSERT|PRAGMA|$)/).map(sql => sql.trim()).filter(Boolean);
  await db.batch(statements.map(sql => db.prepare(sql)));
  const profiles = readFileSync(new URL('../cloudflare/migrations/0002_profiles.sql', import.meta.url), 'utf8');
  await db.batch(profiles.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  const replies = readFileSync(new URL('../cloudflare/migrations/0003_replies.sql', import.meta.url), 'utf8');
  await db.batch(replies.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  await db.prepare(readFileSync(new URL('../cloudflare/migrations/0004_message_edits.sql', import.meta.url), 'utf8')).run();
  await db.prepare(readFileSync(new URL('../cloudflare/migrations/0005_media.sql', import.meta.url), 'utf8')).run();
  async function call(path, method = 'GET', token = '', data, ip = '192.0.2.1') {
    const response = await mf.dispatchFetch('https://seachat.example.com' + path, {
      method, headers: { Authorization: 'Bearer ' + token, 'CF-Connecting-IP': ip },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await call('/health')).status, 200);
  assert.equal((await call('/messages')).status, 401);
  assert.equal((await call('/sessions', 'POST', '', { name: '<script>' })).status, 400);
  const alice = (await call('/sessions', 'POST', '', { name: 'Alice' })).data;
  const bob = (await call('/sessions', 'POST', '', { name: 'Bob' })).data;
  const empty = await call('/messages', 'GET', bob.token);
  assert.deepEqual(empty.data.messages, []);
  const quiet = await call('/messages?revision=' + empty.data.revision, 'GET', bob.token);
  assert.equal(quiet.data.unchanged, true);
  assert.equal(quiet.data.messages, undefined);
  assert.equal((await call('/messages', 'POST', alice.token, null)).status, 400);
  assert.equal((await call('/messages', 'POST', alice.token, { text: 'x'.repeat(9000) })).status, 413);
  const sends = await Promise.all([
    call('/messages', 'POST', alice.token, { text: 'hello 👋' }),
    call('/messages', 'POST', alice.token, { text: 'second simultaneous send' })
  ]);
  assert.deepEqual(sends.map(r => r.status).sort(), [201, 429]);
  const posted = sends.find(r => r.status === 201).data;
  const history = await call('/messages?revision=' + empty.data.revision, 'GET', bob.token);
  assert.equal(history.data.messages.length, 1);
  assert.equal(history.data.messages[0].text, posted.text);
  assert.notEqual(history.data.revision, empty.data.revision);
  const original = await call('/profile', 'GET', alice.token);
  assert.ok(original.data.color.startsWith('#'));
  assert.equal((await call('/profile', 'PUT', bob.token, { name: '<script>', color: '#a78bfa', avatar: '' })).status, 400);
  assert.equal((await call('/profile', 'PUT', alice.token, { name: 'Alice', color: 'red', avatar: '' })).status, 400);
  assert.equal((await call('/profile', 'PUT', alice.token, { name: 'Alice', color: '#a78bfa', avatar: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400);
  const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=';
  const saved = await call('/profile', 'PUT', alice.token, { name: 'New Alice', color: '#60a5fa', avatar });
  assert.equal(saved.status, 200);
  assert.equal((await call('/avatars/' + alice.userId, 'GET', bob.token)).data.avatar, avatar);
  const changed = await call('/messages?revision=' + history.data.revision, 'GET', bob.token);
  assert.equal(changed.data.messages[0].name, 'New Alice');
  assert.equal(changed.data.messages[0].color, '#60a5fa');
  assert.equal(changed.data.messages[0].avatarVersion, saved.data.avatarVersion);
  assert.equal((await call('/profile', 'GET', alice.token)).data.name, 'New Alice');
  assert.equal((await call('/messages/' + posted.id + '/report', 'POST', bob.token, {reason:'Harassment',details:'Please review this message'})).status, 200);
  assert.equal((await call('/messages/' + posted.id + '/report', 'POST', bob.token, {})).status, 200);
  assert.equal((await call('/admin/reports', 'GET', bob.token)).status, 401);
  assert.equal((await call('/admin/reports', 'GET', 'test-admin')).data[0].report_count, 1);
  assert.equal(JSON.parse((await call('/admin/reports', 'GET', 'test-admin')).data[0].reports)[0].details, 'Please review this message');
  assert.equal((await call('/admin/messages/' + posted.id, 'DELETE', 'test-admin')).status, 200);
  const removed = await call('/messages?revision=' + history.data.revision, 'GET', bob.token);
  assert.deepEqual(removed.data.messages, []);
  assert.notEqual(removed.data.revision, history.data.revision);
  assert.deepEqual((await call('/admin/reports', 'GET', 'test-admin')).data, []);
  assert.equal((await call('/admin/ban', 'POST', 'test-admin', { userId: alice.userId })).status, 200);
  assert.equal((await call('/messages', 'GET', alice.token)).status, 403);
  for (let i = 0; i < 5; i++) assert.equal((await call('/sessions', 'POST', '', { name: 'Guest' }, '192.0.2.2')).status, 201);
  assert.equal((await call('/sessions', 'POST', '', { name: 'Guest' }, '192.0.2.2')).status, 429);
  // Trigger-based retention must keep the stored history bounded as new messages arrive.
  await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1005)
    INSERT INTO messages(request_id,user_id,name,text,created_at)
    SELECT 'seed-'||x,?, 'Bob','history '||x,'2026-10-08T00:00:00Z' FROM n`).bind(bob.userId).run();
  assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM messages').first()).total, 1000);
  assert.equal((await call('/messages', 'GET', bob.token)).data.messages.length, 100);
});
