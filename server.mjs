import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('./dist/',import.meta.url));
http.createServer(async(req,res)=>{try{const p=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const file=path.resolve(root,'.'+(p==='/'?'/index.html':p));if(!file.startsWith(root)){res.writeHead(403).end();return;}const data=await readFile(file);res.writeHead(200,{'Content-Type':({'html':'text/html; charset=utf-8','css':'text/css','js':'text/javascript'})[path.extname(file).slice(1)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);}catch{res.writeHead(404).end('Not found');}}).listen(4180,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:4180'));
