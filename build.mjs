import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const configPath = new URL('./chat.config.json', import.meta.url);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const previewIndex = process.argv.indexOf('--media-preview');
const preview = previewIndex !== -1;
const media = preview ? { enabled: true, appKey: readFileSync(process.argv[previewIndex + 1], 'utf8').trim(), productionFreeConfirmed: false } : JSON.parse(readFileSync(new URL('./media-config.json', import.meta.url), 'utf8'));
if (preview && !/^[a-zA-Z0-9_-]+$/.test(media.appKey)) throw new Error('Invalid KLIPY test key.');
if (!preview && media.enabled && (!(media.productionFreeConfirmed || media.testRollout === true) || (!media.proxy && !/^[a-zA-Z0-9_-]+$/.test(media.appKey)))) throw new Error('Configure a client app key and explicitly select confirmed production access or a limited test rollout.');
const url = new URL(preview ? 'http://127.0.0.1:8787' : process.argv[2] || config.serverOrigin);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Use HTTPS for the public chat server.');
if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use a server origin, such as https://chat.example.com');
const html = readFileSync(new URL('./chat.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace('"__SEACHAT_MEDIA_CONFIG__"', JSON.stringify(media));
const payload = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace('http://127.0.0.1:8787', url.origin).replace('"__SEACHAT_WEBVIEW__"', JSON.stringify(html));
const manifest = {
  id: 'seachat', name: 'SeaChat', version: '0.6.1', manifestURI: 'https://raw.githubusercontent.com/DefnoJae/SeaChat/main/Manifest.json',
  language: 'javascript', type: 'plugin', description: 'A shared public chat room for Seanime users.',
  author: 'DefnoJae', icon: 'https://raw.githubusercontent.com/DefnoJae/SeaChat/main/assets/icon.png', website: 'https://github.com/DefnoJae/SeaChat', readme: 'https://github.com/DefnoJae/SeaChat#readme', notes: 'Display names are unverified. Messages are public.', lang: 'en', payload,
  plugin: { version: '1', permissions: { scopes: ['storage'], allow: { networkAccess: { allowedDomains: [url.hostname], reasoning: 'Connect to the shared global chat server to send messages, update profiles and report messages.' } } } }
};
mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
const json = JSON.stringify(manifest, null, 2) + '\n';
if (preview) {
  writeFileSync(new URL('./dist/seachat-media-preview.json', import.meta.url), json);
  console.log('Built private local media preview in ignored dist directory. Public manifest unchanged.');
  process.exit(0);
}
if (process.argv[2]) writeFileSync(configPath, JSON.stringify({ serverOrigin: url.origin }, null, 2) + '\n');
writeFileSync(new URL('./dist/seachat.json', import.meta.url), json);
writeFileSync(new URL('./Manifest.json', import.meta.url), json);
console.log('Built Manifest.json and dist/seachat.json for ' + url.origin);
