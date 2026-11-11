import { mkdir, readFile, writeFile } from 'node:fs/promises';

const dist = new URL('../dist/', import.meta.url);
const entry = new URL('nk001/', dist);
let html = await readFile(new URL('index.html', dist), 'utf8');

for (const [original, replacement] of [
  ['<title>NK 订单管理 · 订单管理</title>', '<title>NK 订单处理 · 员工登录</title>'],
  ['<body class="locked">', '<body class="locked" data-entry="staff">'],
  ['<h1>订单管理后台</h1>', '<h1>员工订单处理</h1>'],
  ['使用后台账号登录，查看和处理客户订单。', '使用员工账号登录，查看和处理分配给你的订单。'],
  ['>登录后台</button>', '>登录员工后台</button>'],
  ['href="./style.css?', 'href="../style.css?'],
  ['src="./app.js?', 'src="../app.js?'],
]) {
  if (!html.includes(original)) throw new Error(`Staff entry template is missing ${original}`);
  html = html.replace(original, replacement);
}

await mkdir(entry, { recursive: true });
await writeFile(new URL('index.html', entry), html);
