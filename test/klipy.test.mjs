import {test} from 'node:test';
import assert from 'node:assert/strict';
import {klipyRequest} from '../klipy.mjs';
test('media gateway confines provider requests, strips diagnostics, and hides credentials on errors',async()=>{
 let request;
 const data=await klipyRequest({kind:'gif',query:'hello',page:2},7,'private-test-key',async(url,options)=>{
  request={url:new URL(url),options};return Response.json({result:true,diagnostic:'private-test-key',data:{data:[{slug:'hello',title:'Hello',file:{sm:{gif:{url:'https://static.klipy.com/a.gif',width:10,height:10}}}}],has_next:true}});
 });
 assert.equal(request.url.hostname,'api.klipy.com');assert.equal(request.url.searchParams.get('customer_id'),'seachat-7');assert.equal(request.url.searchParams.get('page'),'2');assert.equal(request.options.headers,undefined);assert.ok(!JSON.stringify(data).includes('private-test-key'));
 await assert.rejects(klipyRequest({kind:'gif',page:-1},7,'key'),{status:400});
 await assert.rejects(klipyRequest({kind:'gif'},7,'key',async()=>{throw Error('https://api.klipy.com/key');}),error=>error.status===502&&!error.message.includes('/key'));
 await assert.rejects(klipyRequest({kind:'sticker'},7,'key',async()=>new Response('',{status:429})),{status:429});
 await assert.rejects(klipyRequest({kind:'sticker'},7,''),{status:503});
});
