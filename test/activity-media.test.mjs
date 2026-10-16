import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createChatServer } from '../server.mjs';
import { validateAttachment, messageContent } from '../media.mjs';

const media = {provider:'klipy',kind:'gif',id:'hello',title:'Hello',url:'https://static.klipy.com/hello.gif?delivery=exact',previewUrl:'https://static1.klipy.com/hello.jpg',width:200,height:150};
test('media validation preserves delivery URLs and rejects arbitrary content', () => {
  assert.deepEqual(validateAttachment(media),media);
  for (const invalid of [{url:'https://evil.example/a.gif'}, {url:'https://static.klipy.com.evil.example/a.gif'}, {url:'https://user:pass@static.klipy.com/a.gif'}, {url:'http://static.klipy.com/a.gif'}, {url:'https://static.klipy.com/a.svg'}, {id:'../evil'}, {width:0}, {height:99999}, {kind:'html'}, {title:'bad\n'}]) assert.throws(()=>validateAttachment({...media,...invalid}),{status:400});
  assert.throws(()=>messageContent({attachment:media},false),{status:503});
  assert.throws(()=>messageContent({},true),{status:400});
});

for(const platform of ['Node','Cloudflare']) test(platform+': activity snapshots and media message lifecycle',async t=>{
  let dispatch;
  if(platform==='Node'){
    const server=createChatServer({dbPath:':memory:',adminToken:'admin',mediaEnabled:true});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
    dispatch=(path,opts)=>fetch('http://127.0.0.1:'+server.address().port+path,opts);
  }else{
    const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
    const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'activity-media',modules:['cloudflare/worker.mjs','profile.mjs','messages.mjs','media.mjs','klipy.mjs'].map(f=>({type:'ESModule',path:fileURLToPath(new URL('../'+f,import.meta.url))})),compatibilityDate:config.compatibility_date,d1Databases:{DB:'activity-media'},bindings:{ADMIN_TOKEN:'admin',MEDIA_ENABLED:'true'},ratelimits:Object.fromEntries(config.ratelimits.map(({name,...value})=>[name,value]))}]}));
    t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
    for(const name of ['0001_chat.sql','0002_profiles.sql','0003_replies.sql','0004_message_edits.sql','0005_media.sql', '0006_spoilers_presence.sql', '0007_watch_badge.sql']){const sql=readFileSync(new URL('../cloudflare/migrations/'+name,import.meta.url),'utf8');await db.batch(sql.split(/;\s*(?=CREATE|INSERT|PRAGMA|ALTER|UPDATE|$)/).filter(s=>s.trim()).map(s=>db.prepare(s)));}
    dispatch=(path,opts)=>mf.dispatchFetch('https://chat.example.com'+path,opts);
  }
  async function call(path,method='GET',token='',body){const res=await dispatch(path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.50'},body:body===undefined?undefined:JSON.stringify(body)});return{status:res.status,data:await res.json()};}
  assert.equal((await call('/activity')).status,401);
  const alice=(await call('/sessions','POST','',{name:'Alice'})).data,bob=(await call('/sessions','POST','',{name:'Bob'})).data;
  assert.deepEqual((await call('/activity','GET',alice.token)).data,{latestId:0,unreadCount:0,oldestUnreadId:null});
  assert.equal((await call('/activity?after=no','GET',alice.token)).status,400);
  const original=await call('/messages','POST',alice.token,{attachment:media});assert.equal(original.status,201);
  assert.equal((await call('/activity','GET',alice.token)).data.unreadCount,0);
  assert.deepEqual((await call('/activity','GET',bob.token)).data,{latestId:original.data.id,unreadCount:1,oldestUnreadId:original.data.id});
  const reply=await call('/messages','POST',bob.token,{text:'Nice',replyToId:original.data.id,attachment:{...media,kind:'sticker'}});assert.equal(reply.status,201);
  const history=(await call('/messages?after='+original.data.id,'GET',alice.token)).data;
  assert.equal(history.activity.unreadCount,1);assert.equal(history.activity.oldestUnreadId,reply.data.id);
  assert.deepEqual(history.messages[0].attachment,media);assert.equal(history.messages[0].caption,'');assert.equal(history.messages[0].text,'[GIF] Hello');assert.equal(history.messages[1].reply.text,'[GIF] Hello');
  assert.equal((await call('/messages/'+original.data.id,'PATCH',bob.token,{text:'Hijack'})).status,403);
  assert.equal((await call('/messages/'+original.data.id,'PATCH',alice.token,{text:'New caption',attachment:{url:'bad'}})).status,200);
  const changed=(await call('/messages'+(history.revision?'?revision='+history.revision:''),'GET',bob.token)).data;assert.equal(changed.messages[0].text,'New caption');assert.deepEqual(changed.messages[0].attachment,media);
  assert.equal((await call('/messages/'+original.data.id,'PATCH',alice.token,{text:''})).status,200);
  assert.equal((await call('/messages/'+original.data.id+'/report','POST',bob.token,{reason:'Other',details:'Media report'})).status,200);
  assert.equal((await call('/messages/context/'+original.data.id,'GET',bob.token)).data.messages[0].attachment.url,media.url);
  await call('/messages/'+original.data.id,'DELETE',alice.token);
  const deleted=(await call('/messages','GET',bob.token)).data;
  assert.equal(deleted.messages[0].reply.available,false);assert.equal(deleted.messages[0].reply.text,null);assert.equal(deleted.activity.unreadCount,0);
  await call('/messages/'+reply.data.id,'DELETE',bob.token);
  const cleared=(await call('/activity','GET',alice.token)).data;assert.equal(cleared.unreadCount,0);assert.equal(cleared.latestId,reply.data.id,'high-water ID survives deletions');
});
