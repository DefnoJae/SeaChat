export async function klipyRequest(input, userId, key, fetcher = fetch) {
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  if (!key) fail(503, 'Media search is not configured.');
  if (!input || !['gif','sticker'].includes(input.kind)) fail(400, 'Invalid media kind.');
  const share = input.action === 'share';
  if (input.action && !share) fail(400, 'Invalid media action.');
  const query = String(input.query || '').trim();
  if (query.length > 100 || /[\x00-\x1f]/.test(query)) fail(400, 'Invalid search.');
  const page = input.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > 100) fail(400, 'Invalid page.');
  if (share && !/^[a-zA-Z0-9_-]{1,200}$/.test(input.id || '')) fail(400, 'Invalid media ID.');
  const url = new URL('https://api.klipy.com/api/v1/' + encodeURIComponent(key) + '/' + (input.kind === 'gif' ? 'gifs' : 'stickers') + '/' + (share ? 'share/' + encodeURIComponent(input.id) : query ? 'search' : 'trending'));
  const customer = 'seachat-' + userId;
  if (!share) {
    for (const [name,value] of Object.entries({page,per_page:24,customer_id:customer,content_filter:'off',format_filter:input.kind === 'gif' ? 'gif,webp,jpg' : 'webp,png,gif'})) url.searchParams.set(name,String(value));
    if (query) url.searchParams.set('q',query);
  }
  try {
    const response = await fetcher(url.href, {method:share?'POST':'GET',redirect:'manual',signal:AbortSignal.timeout(10000),headers:share?{'Content-Type':'application/json'}:undefined,body:share?JSON.stringify({customer_id:customer,q:query}):undefined});
    if (!response.ok) fail(response.status === 429 ? 429 : 502, response.status === 429 ? 'Search limit reached. Try again later.' : 'Media provider returned HTTP '+response.status+'. Try again.');
    const reader=response.body.getReader();let size=0;const chunks=[];
    try { while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2_000_000){await reader.cancel();fail(502,'Media response is too large.');}chunks.push(value);} } finally {reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const data=JSON.parse(new TextDecoder().decode(bytes));
    if(data.result===false)fail(502,'Media provider rejected this request. Try again.');
    // Only return known media fields; never return upstream diagnostics or URLs containing the key.
    if(share)return {result:true};
    return {result:true,data:{data:(data.data?.data||[]).slice(0,24).map(item=>({slug:item.slug,title:item.title,file:item.file})),has_next:!!data.data?.has_next}};
  } catch(error) { if(error.status)throw error; console.error('Media gateway failure', error.name); fail(502,'Media search is unavailable ('+(error.name||'Error')+'). Try again.'); }
}
