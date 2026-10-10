import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('unread badge polls closed chat lightly, restores first unread, and acknowledges displayed IDs only',async()=>{
 const storage=new Map([['sessionToken','token']]),handlers=new Map(),calls=[],badges=[];
 let state,click,tick,unmount,now=0,cancelled=0,failed=false;
 let rows=[{id:5,userId:2,name:'Bob',text:'old',createdAt:'now'}],latestId=5;
 const activity=after=>({latestId,unreadCount:rows.filter(m=>m.id>after&&m.userId!==1).length,oldestUnreadId:rows.find(m=>m.id>after&&m.userId!==1)?.id??null});
 const ctx={state:value=>{state=value;return{get:()=>state,set:v=>{state=v;}};},newTray:()=>({onClick:fn=>click=fn,updateBadge:value=>badges.push(value.number)}),newWebview:()=>({channel:{sync:()=>{},on:(name,fn)=>handlers.set(name,fn)},setContent:()=>{},show:()=>{},hide:()=>{},onMount:()=>{},onUnmount:fn=>unmount=fn}),setInterval:(fn,ms)=>{assert.equal(ms,10000);tick=fn;return()=>cancelled++;},fetch:async(url,options)=>{
   const u=new URL(url);calls.push(u.pathname);const after=Number(u.searchParams.get('after')||0);
   if(failed&&u.pathname==='/activity')return{ok:false,status:503,json:()=>({error:'temporary'})};
   const value=u.pathname==='/profile'?{userId:1,name:'Alice',color:'#a78bfa',avatar:''}:u.pathname==='/activity'?activity(after):u.pathname==='/replies'?{replies:[]}:u.pathname.startsWith('/messages/context/')?{messages:[{id:6,userId:2,name:'Bob',text:'earlier unread',createdAt:'now'}]}:{messages:rows,revision:'r',activity:activity(after)};
   return{ok:true,status:200,json:()=>value};
 }};
 const sandbox={$ui:{register:fn=>fn(ctx)},$storage:{get:k=>storage.get(k),set:(k,v)=>storage.set(k,v),remove:k=>storage.delete(k)},Date:{now:()=>now}};
 vm.runInNewContext(readFileSync(new URL('../plugin.js',import.meta.url),'utf8'),sandbox);sandbox.init();
 await tick();assert.equal(storage.get('messageRead:http://127.0.0.1:8787:1'),5);assert.equal(badges.at(-1),0);assert.ok(!calls.includes('/messages'));
 rows.push({id:6,userId:2,name:'Bob',text:'new',createdAt:'now'});latestId=6;now=10000;await tick();assert.equal(badges.at(-1),0);
 now=30000;await tick();assert.equal(badges.at(-1),1);assert.ok(!calls.includes('/replies'));
 click();for(let n=0;n<50&&!state.visible;n++)await new Promise(r=>setImmediate(r));assert.equal(state.initialTarget,-1);assert.equal(badges.at(-1),1,'opening does not acknowledge');
 await handlers.get('readMessages')({messageId:999});assert.equal(badges.at(-1),1,'cannot acknowledge messages never displayed');
 await handlers.get('readMessages')({messageId:5});assert.equal(badges.at(-1),1);
 await handlers.get('readMessages')({messageId:6});assert.equal(badges.at(-1),0);
 handlers.get('close')();assert.equal(cancelled,0);
 rows.push({id:7,userId:1,name:'Alice',text:'own',createdAt:'now'},{id:8,userId:2,name:'Bob',text:'unread',createdAt:'now'});latestId=8;now=60000;await tick();assert.equal(badges.at(-1),1);
 click();for(let n=0;n<50&&!state.visible;n++)await new Promise(r=>setImmediate(r));assert.equal(state.initialTarget,8);assert.equal(badges.at(-1),1);
 await handlers.get('readMessages')({messageId:7});assert.equal(badges.at(-1),1,'new arrivals remain unread after older snapshot acknowledgement');
 await handlers.get('readMessages')({messageId:8});assert.equal(badges.at(-1),0);
 handlers.get('close')();failed=true;now=90000;await tick();const count=calls.length;now=120000;await tick();assert.equal(calls.length,count,'failed checks back off');failed=false;now=150000;await tick();assert.ok(calls.length>count);
 unmount();assert.equal(cancelled,1);
});
