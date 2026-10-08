import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const configPath = new URL('./chat.config.json', import.meta.url);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const url = new URL(process.argv[2] || config.serverOrigin);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Use HTTPS for the public chat server.');
if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use a server origin, such as https://chat.example.com');
const payload = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8').replace('http://127.0.0.1:8787', url.origin);
const manifest = {
  id: 'seachat', name: 'SeaChat', version: '0.2.0', manifestURI: 'https://raw.githubusercontent.com/DefnoJae/SeaChat/main/Manifest.json',
  language: 'javascript', type: 'plugin', description: 'A shared public chat room for Seanime users.',
  author: 'DefnoJae', icon: '', website: 'https://github.com/DefnoJae/SeaChat', readme: 'https://github.com/DefnoJae/SeaChat#readme', notes: 'Display names are unverified. Messages are public.', lang: 'en', payload,
  plugin: { version: '1', permissions: { scopes: [], allow: { networkAccess: { allowedDomains: [url.hostname], reasoning: 'Connect to the shared global chat server to send, retrieve and report public messages.' } } } }
};
mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
const json = JSON.stringify(manifest, null, 2) + '\n';
if (process.argv[2]) writeFileSync(configPath, JSON.stringify({ serverOrigin: url.origin }, null, 2) + '\n');
writeFileSync(new URL('./dist/seachat.json', import.meta.url), json);
writeFileSync(new URL('./Manifest.json', import.meta.url), json);
console.log('Built Manifest.json and dist/seachat.json for ' + url.origin);
