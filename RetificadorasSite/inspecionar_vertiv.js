/**
 * Roda este script UMA VEZ para descobrir o endpoint de login da Vertiv
 * Execute: node inspecionar_vertiv.js
 */
const http = require('http');

const IP = '172.30.245.71'; // GUA - qualquer Vertiv serve

function httpReq(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  console.log('Buscando emerson.login.min.js para descobrir endpoint de login...\n');

  // Busca o arquivo JS de login
  const r = await httpReq({
    hostname: IP, port: 80,
    path: '/app/www_user/html/js/emerson.login.min.js',
    method: 'GET',
    headers: { 'Host': IP, 'User-Agent': 'Mozilla/5.0' }
  });

  console.log('=== emerson.login.min.js (primeiros 3000 chars) ===');
  console.log(r.body.slice(0, 3000));

  // Procura por URLs de login no JS
  const urlMatches = r.body.match(/(url|path|action|href|ajax|post|fetch)['":\s]+(['"\/][^'"<>\s]{3,80}['"])/gi);
  console.log('\n=== URLs encontradas no JS ===');
  if (urlMatches) urlMatches.forEach(m => console.log(m));

  // Busca tambem o HTML da pagina de login
  const r2 = await httpReq({
    hostname: IP, port: 80,
    path: '/app/www_user/html/eng/login.html',
    method: 'GET',
    headers: { 'Host': IP, 'User-Agent': 'Mozilla/5.0' }
  });
  console.log('\n=== login.html ===');
  console.log(r2.body.slice(0, 2000));
}

main().catch(console.error);
