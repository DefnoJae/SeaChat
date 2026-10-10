import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('profile saves serialize with polls; avatars retry quietly; reply acknowledgements survive reopen', async () => {
  const storage = new Map([['sessionToken','token']]), handlers = new Map(), states = [];
  let current, click, interval, puts = 0, avatarAttempts = 0, hold = false, release, waiting = false;
  let profile = { userId: 1, name: 'Alice', color: '#a78bfa', avatar: '', avatarVersion: '' };
  const history = () => [{id:10,userId:1,...profile,text:'own',createdAt:'now'},
    {id:11,userId:2,name:'Alice',color:'#f472b6',avatarVersion:'v1',text:'different session',createdAt:'now'}];
  const ctx = { state: value => {current=value;return {get:()=>current,set:v=>{current=v;states.push(structuredClone(v));}};},
    newWebview:()=>({channel:{sync:()=>{},on:(key,fn)=>handlers.set(key,fn)},setContent:()=>{},show:()=>{},hide:()=>{},onMount:()=>{},onUnmount:()=>{}}),
    newTray:()=>({onClick:fn=>{click=fn;}}),setInterval:fn=>{interval=fn;return()=>{};},
    fetch:async(url,opts)=>{
      let value,ok=true,status=200;
      if(url.endsWith('/profile')) {
        if(opts.method==='PUT'){puts++;profile={...profile,...JSON.parse(opts.body),avatarVersion:'saved'};}
        value=structuredClone(profile);
      } else if(url.includes('/avatars/')) {avatarAttempts++;ok=avatarAttempts>1;status=ok?200:503;value=ok?{avatar:'data:image/png;base64,abc',avatarVersion:'v1'}:{error:'temporary'};}
      else if(url.includes('/replies?')) {const after=Number(new URL(url).searchParams.get('after'));value={replies:[{id:12,createdAt:'now'}].filter(r=>r.id>after)};}
      else if(url.includes('/context/')) value={messages:[{id:12,userId:2,name:'Bob',text:'reply',createdAt:'now',reply:{userId:1}}]};
      else {value=url.includes('?revision=')?{unchanged:true,revision:'room'}:{messages:history(),revision:'room'};if(hold){hold=false;waiting=true;await new Promise(resolve=>{release=resolve;});}}
      return {ok,status,json:()=>value};
    }
  };
  const sandbox={$ui:{register:fn=>fn(ctx)},$storage:{get:k=>storage.get(k),set:(k,v)=>storage.set(k,v),remove:k=>storage.delete(k)}};
  vm.runInNewContext(readFileSync(new URL('../plugin.js',import.meta.url),'utf8'),sandbox);sandbox.init();click();
  for(let n=0;n<50&&!interval;n++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(current.messages[1].avatar,'');assert.equal(avatarAttempts,1);
  await interval();assert.equal(avatarAttempts,2);assert.equal(current.messages[1].avatar,'data:image/png;base64,abc');
  hold=true;const poll=interval();for(let n=0;n<50&&!waiting;n++)await new Promise(resolve=>setImmediate(resolve));
  const saving=handlers.get('profile')({name:'New Alice',color:'#60a5fa',avatar:'saved-picture'});
  assert.equal(puts,0,'save waits for the older in-flight poll');release();await poll;await saving;
  assert.equal(current.messages[0].name,'New Alice');assert.equal(current.messages[0].avatar,'saved-picture');
  assert.equal(current.messages[1].name,'Alice','a separate session is not renamed');
  const firstSaved=states.findIndex(s=>s.profile?.avatarVersion==='saved');assert.ok(firstSaved>=0);
  assert.ok(states.slice(firstSaved).every(s=>s.messages.find(m=>m.id===10)?.name==='New Alice'));
  assert.equal(current.unreadReplies.length,1);await handlers.get('readReply')();assert.equal(current.jumpId,12);assert.equal(current.contextId,12);assert.equal(current.unreadReplies.length,0);
  assert.equal(storage.get('replyRead:http://127.0.0.1:8787:1'),12);
  handlers.get('close')();click();for(let n=0;n<50;n++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(current.unreadReplies.length,0);
});
