import {writeFile} from 'node:fs/promises';
const [url,key]=process.argv.slice(2);
if(!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url||'')||!(key||'').startsWith('eyJ'))throw Error('Supply a Supabase project URL and legacy anon JWT. Never a secret key.');
if(key.startsWith('eyJ')){const payload=JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString());if(payload.role!=='anon')throw Error('Only the anon key is accepted');}
const c={url,publishableKey:key,ready:true};
await writeFile(new URL('../dist/config.js',import.meta.url),'export const config=Object.freeze('+JSON.stringify(c)+');\n');
await writeFile(new URL('../../landing-page/backend-config.js',import.meta.url),'window.BACKEND_CONFIG=Object.freeze('+JSON.stringify(c)+');\n');
console.log('Public configuration updated for both sites.');
