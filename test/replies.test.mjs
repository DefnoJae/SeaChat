import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createChatServer } from '../server.mjs';

for (const platform of ['Node', 'Cloudflare']) test(platform + ': replies, recipients, context, deletion and compatibility', async t => {
  let dispatch, seed;
  if (platform === 'Node') {
    const dir = mkdtempSync(join(tmpdir(), 'seachat-replies-')), path = join(dir, 'chat.sqlite');
    const server = createChatServer({ dbPath: path, adminToken: 'admin' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const db = new DatabaseSync(path);
    t.after(async () => { db.close(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
    dispatch = (path, opts) => fetch('http://127.0.0.1:' + server.address().port + path, opts);
    seed = userId => { for (let n = 0; n < 150; n++) db.prepare('INSERT INTO messages(user_id,name,text,created_at) VALUES(?,?,?,?)').run(userId, 'Bob', 'seed ' + n, '2026-10-10T20:00:00Z'); };
  } else {
    const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
    const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'replies',
      modules: ['cloudflare/worker.mjs', 'profile.mjs', 'messages.mjs', 'media.mjs','klipy.mjs'].map(file => ({ type: 'ESModule', path: fileURLToPath(new URL('../' + file, import.meta.url)) })),
      compatibilityDate: config.compatibility_date, d1Databases: { DB: 'replies' }, bindings: { ADMIN_TOKEN: 'admin' },
      ratelimits: Object.fromEntries(config.ratelimits.map(({ name, ...binding }) => [name, binding]))
    }] }));
    t.after(() => mf.dispose());
    const db = await mf.getD1Database('DB');
    for (const name of ['0001_chat.sql', '0002_profiles.sql', '0003_replies.sql', '0004_message_edits.sql', '0005_media.sql']) {
      const sql = readFileSync(new URL('../cloudflare/migrations/' + name, import.meta.url), 'utf8');
      const statements = sql.split(/;\s*(?=CREATE|INSERT|PRAGMA|ALTER|UPDATE|$)/).filter(s => s.trim());
      await db.batch(statements.map(s => db.prepare(s)));
    }
    dispatch = (path, opts) => mf.dispatchFetch('https://chat.example.com' + path, opts);
    seed = userId => db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<150)
      INSERT INTO messages(request_id,user_id,name,text,created_at) SELECT 'seed-'||x,?,'Bob','seed '||x,'2026-10-10T20:00:00Z' FROM n`).bind(userId).run();
  }
  async function call(path, method = 'GET', token = '', body) {
    const res = await dispatch(path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.30' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  }
  assert.equal((await call('/replies')).status, 401);
  const alice = (await call('/sessions', 'POST', '', { name: 'Alice' })).data;
  const bob = (await call('/sessions', 'POST', '', { name: 'Bob' })).data;
  const original = await call('/messages', 'POST', alice.token, { text: 'Original text' }); assert.equal(original.status, 201);
  assert.equal((await call('/messages', 'POST', bob.token, { text: 'bad', replyToId: '1' })).status, 400);
  assert.equal((await call('/messages', 'POST', bob.token, { text: 'bad', replyToId: 999999 })).status, 404);
  const response = await call('/messages', 'POST', bob.token, { text: 'A reply', replyToId: original.data.id, replyToUserId: bob.userId });
  assert.equal(response.status, 201);
  const messages = (await call('/messages', 'GET', alice.token)).data.messages;
  assert.equal(messages[0].reply, null);
  assert.deepEqual(messages[1].reply, { messageId: original.data.id, userId: alice.userId, available: true, name: 'Alice', text: 'Original text' });
  assert.deepEqual((await call('/replies?after=0', 'GET', alice.token)).data.replies.map(r => r.id), [response.data.id]);
  assert.deepEqual((await call('/replies?after=' + response.data.id, 'GET', alice.token)).data.replies, []);
  assert.deepEqual((await call('/replies', 'GET', bob.token)).data.replies, []);
  assert.equal((await call('/replies?after=abc', 'GET', alice.token)).status, 400);
  assert.equal((await call('/messages/' + original.data.id, 'PATCH', '', { text: 'unauthenticated' })).status, 401);
  assert.equal((await call('/messages/' + original.data.id, 'PATCH', bob.token, { text: 'spoofed', userId: alice.userId })).status, 403);
  assert.equal((await call('/messages/' + original.data.id, 'DELETE', bob.token)).status, 403);
  assert.equal((await call('/messages/' + original.data.id, 'PATCH', alice.token, { text: '   ' })).status, 400);
  assert.equal((await call('/messages/' + original.data.id, 'PATCH', alice.token, { text: 'x'.repeat(1001) })).status, 400);
  const beforeEdit = (await call('/messages', 'GET', alice.token)).data;
  assert.equal((await call('/messages/' + original.data.id, 'PATCH', alice.token, { text: 'Edited original' })).status, 200);
  const edited = (await call('/messages' + (beforeEdit.revision ? '?revision=' + beforeEdit.revision : ''), 'GET', bob.token)).data;
  assert.equal(edited.messages.find(m => m.id === original.data.id).text, 'Edited original');
  assert.equal(edited.messages.find(m => m.id === response.data.id).reply.text, 'Edited original');
  assert.equal(edited.messages.find(m => m.id === original.data.id).createdAt, original.data.createdAt);
  await call('/messages/' + original.data.id + '/report', 'POST', bob.token, { reason: 'Spam', details: 'Test report' });
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.equal((await call('/messages', 'POST', alice.token, { text: 'Self reply', replyToId: original.data.id })).status, 201);
  assert.equal((await call('/replies', 'GET', alice.token)).data.replies.length, 1);
  await seed(bob.userId);
  assert.ok(!(await call('/messages', 'GET', alice.token)).data.messages.some(m => m.id === original.data.id));
  const context = await call('/messages/context/' + original.data.id, 'GET', bob.token);
  assert.equal(context.status, 200); assert.ok(context.data.messages.some(m => m.id === original.data.id)); assert.ok(context.data.messages.length <= 100);
  assert.equal((await call('/messages/' + original.data.id, 'DELETE', alice.token)).status, 200);
  assert.equal((await call('/messages/' + original.data.id, 'DELETE', alice.token)).status, 404);
  assert.equal((await call('/messages/' + original.data.id, 'PATCH', alice.token, { text: 'restore' })).status, 404);
  assert.ok(!(await call('/admin/reports', 'GET', 'admin')).data.some(r => r.message_id === original.data.id));
  const deleted = (await call('/messages/context/' + response.data.id, 'GET', alice.token)).data.messages.find(m => m.id === response.data.id);
  assert.equal(deleted.reply.available, false); assert.equal(deleted.reply.text, null); assert.equal(deleted.reply.name, null);
  assert.equal((await call('/messages/context/' + original.data.id, 'GET', bob.token)).status, 404);
  assert.equal((await call('/messages', 'POST', alice.token, { text: 'Cannot quote removed text', replyToId: original.data.id })).status, 404);
  await call('/admin/messages/' + response.data.id, 'DELETE', 'admin');
  assert.deepEqual((await call('/replies', 'GET', alice.token)).data.replies, []);
});
