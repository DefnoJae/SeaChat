import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatServer } from '../server.mjs';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

test('shared messages, validation, rate limiting, reports, deletion and bans', async t => {
  const server = createChatServer({ dbPath: ':memory:', adminToken: 'test-admin' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function call(path, method = 'GET', token = '', data) {
    const res = await fetch(base + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: res.status, data: await res.json() };
  }
  assert.equal((await call('/messages')).status, 401);
  assert.equal((await call('/sessions', 'POST', '', { name: '<script>' })).status, 400);
  const alice = (await call('/sessions', 'POST', '', { name: 'Alice' })).data;
  const bob = (await call('/sessions', 'POST', '', { name: 'Bob' })).data;
  assert.equal((await call('/messages', 'POST', alice.token, { text: ' ' })).status, 400);
  assert.equal((await call('/messages', 'POST', alice.token, null)).status, 400);
  assert.equal((await call('/messages', 'POST', alice.token, { text: 'x'.repeat(9000) })).status, 413);
  assert.equal((await call('/messages', 'POST', alice.token, { text: 'x'.repeat(1001) })).status, 400);
  const sent = await call('/messages', 'POST', alice.token, { text: '<script>alert(1)</script>' });
  assert.equal(sent.status, 201);
  assert.equal((await call('/messages', 'GET', bob.token)).data.messages[0].text, '<script>alert(1)</script>');
  assert.equal((await call('/messages', 'POST', alice.token, { text: 'spam' })).status, 429);
  assert.equal((await call('/messages/' + sent.data.id + '/report', 'POST', bob.token, {})).status, 200);
  assert.equal((await call('/admin/reports', 'GET', bob.token)).status, 401);
  assert.equal((await call('/admin/reports', 'GET', 'test-admin')).data[0].report_count, 1);
  assert.equal((await call('/admin/messages/' + sent.data.id, 'DELETE', 'test-admin')).status, 200);
  assert.equal((await call('/messages', 'GET', bob.token)).data.messages.length, 0);
  assert.equal((await call('/admin/ban', 'POST', 'test-admin', { userId: alice.userId })).status, 200);
  assert.equal((await call('/messages', 'GET', alice.token)).status, 403);
});

test('plugin joins and sends via documented UI bridge; polling ends when tray closes', async () => {
  const handlers = new Map(), refs = [], calls = [], rendered = [];
  let render, onMount, onUnmount, intervals = 0, cancelled = 0;
  const view = {
    render: fn => { render = fn; }, onOpen: fn => { onMount = fn; }, onClose: fn => { onUnmount = fn; },
    text: text => { rendered.push(text); return { text }; }, input: () => ({}), button: () => ({}), div: () => ({})
  };
  const ctx = {
    fieldRef: value => { const ref = { current: value, setValue(v) { this.current = v; } }; refs.push(ref); return ref; },
    state: value => ({ get: () => value, set: v => { value = v; } }),
    newTray: () => view,
    eventHandler: (name, handler) => { handlers.set(name, handler); return name; },
    setInterval: () => { intervals++; return () => { cancelled++; }; },
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: () => url.endsWith('/sessions') ? { token: 'session' }
        : url.includes('?revision=') ? { unchanged: true, revision: 'v1' }
        : { revision: 'v1', messages: [{ id: 1, name: 'Alice', text: '<b>hello</b>', createdAt: 'now' }] } };
    }
  };
  const sandbox = { $ui: { register: fn => fn(ctx) } };
  vm.runInNewContext(readFileSync(new URL('../plugin.js', import.meta.url), 'utf8'), sandbox);
  sandbox.init(); render(); onMount(); refs[0].current = 'Alice';
  await handlers.get('global-chat-join')();
  assert.equal(intervals, 1);
  refs[1].current = 'Hello everyone';
  await handlers.get('global-chat-send')();
  assert.equal(refs[1].current, '');
  assert.equal(calls.find(c => c.opts.method === 'POST' && c.url.endsWith('/messages')).opts.headers.Authorization, 'Bearer session');
  rendered.length = 0;
  render();
  assert.ok(calls.some(call => call.url.endsWith('/messages?revision=v1')));
  assert.ok(rendered.some(text => text.includes('<b>hello</b>')), 'quiet polls preserve history as plain text');
  onUnmount(); assert.equal(cancelled, 1);
});

test('history and credentials survive a server restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'seachat-persist-'));
  const dbPath = join(dir, 'chat.sqlite');
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  async function start() {
    server = createChatServer({ dbPath });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return 'http://127.0.0.1:' + server.address().port;
  }
  let base = await start();
  const session = await (await fetch(base + '/sessions', { method: 'POST', body: JSON.stringify({ name: 'Jae' }) })).json();
  await fetch(base + '/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + session.token }, body: JSON.stringify({ text: 'Still here after restart 👋' }) });
  await new Promise(resolve => server.close(resolve));
  base = await start();
  const response = await fetch(base + '/messages', { headers: { Authorization: 'Bearer ' + session.token } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).messages[0].text, 'Still here after restart 👋');
});

test('manifest builds restrict network access and retain the chosen public endpoint', t => {
  const dir = mkdtempSync(join(tmpdir(), 'seachat-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of ['build.mjs', 'plugin.js', 'chat.config.json']) copyFileSync(new URL('../' + file, import.meta.url), join(dir, file));
  const build = (...args) => execFileSync(process.execPath, [join(dir, 'build.mjs'), ...args], { encoding: 'utf8', stdio: 'pipe' });
  assert.throws(() => build('http://public.example.com'));
  assert.throws(() => build('https://secret:password@chat.example.com'));
  assert.throws(() => build('https://chat.example.com/path'));
  build('https://chat.example.com');
  const first = readFileSync(join(dir, 'Manifest.json'), 'utf8');
  const manifest = JSON.parse(first);
  assert.equal(manifest.id, 'seachat');
  assert.deepEqual(manifest.plugin.permissions.allow.networkAccess.allowedDomains, ['chat.example.com']);
  assert.ok(manifest.payload.includes('https://chat.example.com'));
  build();
  assert.equal(readFileSync(join(dir, 'Manifest.json'), 'utf8'), first);
  const source = readFileSync(join(dir, 'plugin.js'), 'utf8').replace(/\r\n/g, '\n');
  writeFileSync(join(dir, 'plugin.js'), source.replace(/\n/g, '\r\n'));
  build();
  assert.equal(readFileSync(join(dir, 'Manifest.json'), 'utf8'), first, 'Windows and Linux produce identical embedded payloads');
});
