import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('watch sharing is opt-in, selects latest recorded anime, retries titles and never uploads playback details',async()=>{
 const storage=new Map([['sessionToken','token']]),handlers=new Map(),uploads=[];
 let state,click,tick,now=100000,historyCalls=0,titleCalls=0,failTitle=false;
 let history={21:{mediaId:21,timeUpdated:'2026-10-10T12:00:00Z',episodeNumber:12,filepath:'private/path'},154587:{mediaId:154587,timeUpdated:'2026-10-11T12:00:00Z'}};
 let profile={userId:1,name:'Alice',color:'#a78bfa',avatar:'',watchSharing:false,watchBadge:null};
 const activity={latestId:0,unreadCount:0};
 const ctx={continuity:{getWatchHistory:()=>{historyCalls++;return history;}},anime:{getAnimeEntry:async id=>{titleCalls++;if(failTitle)throw Error('temporary');return{media:{title:{english:id===21?'One Piece':'Frieren'}}};}},state:s=>{state=s;return{get:()=>state,set:s=>state=s};},newTray:()=>({onClick:f=>click=f,updateBadge:()=>{}}),newWebview:()=>({channel:{sync:()=>{},on:(n,f)=>handlers.set(n,f)},setContent:()=>{},show:()=>{},hide:()=>{},onMount:()=>{},onUnmount:()=>{}}),setInterval:f=>{tick=f;return()=>{};},fetch:async(url,opts)=>{
   const path=new URL(url).pathname;let value;
   if(path==='/profile')value=profile;
   else if(path==='/watch-badge'){const body=JSON.parse(opts.body);uploads.push(body);profile={...profile,watchSharing:body.shared,watchBadge:body.shared?(body.mediaId?{mediaId:body.mediaId,title:body.title,color:'#22d3ee'}:profile.watchBadge):null};value={watchSharing:profile.watchSharing,watchBadge:profile.watchBadge};}
   else if(path==='/activity')value=activity;else if(path==='/replies')value={replies:[]};else value={messages:[],activity};
   return{ok:true,json:()=>value};
 }};
 class Clock extends Date{static now(){return now;}}
 const box={$ui:{register:f=>f(ctx)},$storage:{get:k=>storage.get(k),set:(k,v)=>storage.set(k,v)},Date:Clock};
 vm.runInNewContext(readFileSync(new URL('../plugin.js',import.meta.url),'utf8'),box);box.init();
 await tick();assert.equal(historyCalls,0,'no history access before consent');
 click();for(let i=0;i<50&&!state.visible;i++)await new Promise(r=>setImmediate(r));
 await handlers.get('watchSharing')({shared:true});assert.equal(state.profile.watchBadge.title,'Frieren');assert.equal(titleCalls,1);
 assert.deepEqual(uploads[1],{shared:true,automatic:true,mediaId:154587,title:'Frieren'});
 now+=31000;await tick();assert.equal(titleCalls,1,'same anime avoids metadata fetches and uploads');
 history[21].timeUpdated='2026-10-12T12:00:00Z';failTitle=true;now+=31000;await tick();assert.ok(state.watchStatus.includes('retry'));assert.equal(state.profile.watchBadge.title,'Frieren');
 failTitle=false;now+=31000;await tick();assert.equal(state.profile.watchBadge.title,'One Piece');
 assert.deepEqual(uploads.at(-1),{shared:true,automatic:true,mediaId:21,title:'One Piece'});
 await handlers.get('watchSharing')({shared:false});assert.equal(state.profile.watchBadge,null);
 const before=historyCalls;now+=31000;await tick();assert.equal(historyCalls,before,'hiding stops history access');
});
