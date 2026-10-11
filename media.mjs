const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
export function validateAttachment(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || value.provider !== 'klipy' || !['gif','sticker'].includes(value.kind)) fail('Unsupported attachment.');
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value.id)) fail('Invalid media identifier.');
  if (typeof value.title !== 'string' || value.title.length > 200 || /[\x00-\x1f]/.test(value.title)) fail('Invalid media title.');
  for (const key of ['url','previewUrl']) {
    if (typeof value[key] !== 'string' || value[key].length > 2048) fail('Invalid media URL.');
    let url; try { url = new URL(value[key]); } catch { fail('Invalid media URL.'); }
    if (url.protocol !== 'https:' || !['static.klipy.com','static1.klipy.com','static2.klipy.com'].includes(url.hostname) || url.port || url.username || url.password || !/\.(gif|webp|png|jpg)(?:$)/i.test(url.pathname)) fail('Invalid media host or format.');
  }
  if (![value.width,value.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 4096)) fail('Invalid media dimensions.');
  return Object.fromEntries(['provider','kind','id','title','url','previewUrl','width','height'].map(key => [key,value[key]]));
}
export function messageContent(data, enabled) {
  const attachment = validateAttachment(data.attachment);
  if (attachment && !enabled) throw Object.assign(new Error('GIFs and stickers are not enabled yet.'), { status: 503 });
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if ((!text && !attachment) || text.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail('Messages must contain 1–1000 characters or an attachment.');
  if (data.spoiler != null && typeof data.spoiler !== 'boolean') fail('Invalid spoiler flag.');
  return { text, attachment, spoiler: data.spoiler === true };
}
export function mediaSummary(media) { return '[' + (media.kind === 'gif' ? 'GIF' : 'Sticker') + '] ' + (media.title || 'KLIPY'); }
