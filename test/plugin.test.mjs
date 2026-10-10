import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('webview bridge restores sessions, saves profiles, reports and stops hidden polling', async () => {
  const storage = new Map(), handlers = new Map(), calls = [];
  let click, current, cancelled = 0, intervals = 0, html, shown = false;
  const messages = [{ id: 2, userId: 1, name: 'Alice', color: '#a78bfa', text: '<script>hello</script>', createdAt: '2026-10-10T20:00:00Z', avatarVersion: '' }];
  const profile = { userId: 1, name: 'Alice', color: '#a78bfa', avatar: '' };
  const panel = { channel: { sync: () => {}, on: (name, fn) => handlers.set(name, fn) },
    setContent: fn => { html = fn(); }, show: () => { shown = true; }, hide: () => { shown = false; }, onMount: () => {}, onUnmount: () => {} };
  const ctx = { state: value => { current = value; return { get: () => current, set: v => { current = v; } }; }, newWebview: () => panel,
    newTray: () => ({ onClick: fn => { click = fn; } }), setInterval: () => { intervals++; return () => { cancelled++; }; },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      let data = url.endsWith('/sessions') ? { token: 'credential' } : url.endsWith('/profile') ? profile
        : url.includes('?revision=') ? { unchanged: true, revision: 'v1' } : { messages, revision: 'v1' };
      if (options.method === 'PUT') Object.assign(profile, JSON.parse(options.body));
      return { ok: true, status: 200, json: () => data };
    }
  };
  const sandbox = { $ui: { register: fn => fn(ctx) }, $storage: { get: k => storage.get(k), set: (k,v) => storage.set(k,v), remove: k => storage.delete(k) } };
  vm.runInNewContext(JSON.parse(readFileSync(new URL('../Manifest.json', import.meta.url), 'utf8')).payload, sandbox);
  sandbox.init();
  assert.ok(html.includes('id="settings"'));
  assert.ok(!html.includes('__SEACHAT_WEBVIEW__'));
  click(); assert.equal(shown, true);
  await handlers.get('join')({ name: 'Alice' });
  assert.equal(storage.get('sessionToken'), 'credential');
  assert.equal(current.joined, true); assert.equal(intervals, 1);
  await handlers.get('send')({ text: 'hi' });
  assert.equal(current.messages[0].text, '<script>hello</script>');
  assert.equal(calls.find(c => c.url.endsWith('/messages') && c.method === 'POST').headers.Authorization, 'Bearer credential');
  await handlers.get('profile')({ name: 'New Alice', color: '#60a5fa', avatar: '' });
  assert.equal(current.profile.name, 'New Alice');
  await handlers.get('report')({ messageId: 2, reason: 'Spam', details: 'repeated text' });
  assert.equal(JSON.parse(calls.find(c => c.url.endsWith('/report')).body).details, 'repeated text');
  handlers.get('close')();assert.equal(shown,false);assert.equal(cancelled,1);
  click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(intervals,2);assert.equal(calls.filter(c=>c.url.endsWith('/sessions')).length,1);
  assert.ok(!html.includes('innerHTML'), 'untrusted chat text must not be interpreted as markup');
});
