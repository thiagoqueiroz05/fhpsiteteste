const http = require('http');
const url  = require('url');
const fs   = require('fs');
const path = require('path');

const PORT = 5050;

const RETIFICADORAS = {
  GUA: { ip: '172.30.245.71',  type: 'vertiv' },
  AGB: { ip: '172.30.245.12',  type: 'vertiv' },
  CRT: { ip: '172.30.245.14',  type: 'vertiv' },
  BAN: { ip: '172.30.255.75',  type: 'vertiv' },
  JDB: { ip: '172.30.245.11',  type: 'phb'    },
  CPG: { ip: '172.30.245.13',  type: 'vertiv' },
  ANL: { ip: '172.30.245.72',  type: 'phb'    },
  CMP: { ip: '172.30.245.76',  type: 'vertiv' },
};

const CREDS = {
  vertiv: { user: 'admin', pass: '640275' },
  phb:    { pass: '1234' },
};

const SESSIONS = {};

function getSession(sigla) {
  if (!SESSIONS[sigla]) SESSIONS[sigla] = { cookies: {}, loggedIn: false };
  return SESSIONS[sigla];
}

function cookieString(sigla) {
  const c = getSession(sigla).cookies;
  return Object.entries(c).map(([k,v]) => `${k}=${v}`).join('; ');
}

function parseCookies(sigla, headers) {
  const sc = headers['set-cookie'];
  if (!sc) return;
  const arr = Array.isArray(sc) ? sc : [sc];
  const c = getSession(sigla).cookies;
  arr.forEach(line => {
    const part = line.split(';')[0].trim();
    const eq = part.indexOf('=');
    if (eq > 0) c[part.slice(0,eq).trim()] = part.slice(eq+1).trim();
  });
}

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

async function loginVertiv(sigla, ip) {
  const sess = getSession(sigla);
  console.log(`[${sigla}] Login Vertiv em ${ip}...`);
  try {
    // Passo 1 — GET pagina de login para pegar cookies de sessao
    const r1 = await httpReq({
      hostname: ip, port: 80,
      path: '/app/www_user/html/eng/login.html',
      method: 'GET',
      headers: { 'Host': ip, 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,*/*' }
    });
    parseCookies(sigla, r1.headers);

    // Extrai session_id do HTML se existir
    const sessionMatch = r1.body.match(/name="session_id"[^>]*value="(\d+)"/);
    const sessionId = sessionMatch ? sessionMatch[1] : '2';
    console.log(`[${sigla}] session_id=${sessionId}, cookies=${cookieString(sigla)}`);

    // Passo 2 — POST para o endpoint correto encontrado no login.html
    // action="/app/www_user/html/cgi-bin/web_cgi_main.cgi"
    const postBody = `user_name=admin&user_password=640275&language_type=0&session_id=${sessionId}`;
    const r2 = await httpReq({
      hostname: ip, port: 80,
      path: '/app/www_user/html/cgi-bin/web_cgi_main.cgi',
      method: 'POST',
      headers: {
        'Host': ip,
        'User-Agent': 'Mozilla/5.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postBody),
        'Cookie': cookieString(sigla),
        'Referer': `http://${ip}/app/www_user/html/eng/login.html`,
        'Accept': 'text/html,*/*',
      }
    }, postBody);
    parseCookies(sigla, r2.headers);
    console.log(`[${sigla}] POST login: ${r2.statusCode} | redirect: ${r2.headers['location'] || 'nenhum'}`);
    console.log(`[${sigla}] Body inicio: ${r2.body.slice(0,200)}`);

    sess.loggedIn = true;
    console.log(`[${sigla}] *** Login Vertiv OK! Cookies: ${cookieString(sigla)} ***`);
  } catch(e) {
    console.error(`[${sigla}] Erro login Vertiv:`, e.message);
    sess.loggedIn = true;
  }
}

async function loginPHB(sigla, ip) {
  const sess = getSession(sigla);
  console.log(`[${sigla}] Login PHB em ${ip}...`);
  try {
    const r1 = await httpReq({
      hostname: ip, port: 80, path: '/',
      method: 'GET',
      headers: { 'Host': ip, 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,*/*' }
    });
    parseCookies(sigla, r1.headers);

    const postBody = `password=${CREDS.phb.pass}`;
    const r2 = await httpReq({
      hostname: ip, port: 80, path: '/',
      method: 'POST',
      headers: {
        'Host': ip, 'User-Agent': 'Mozilla/5.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postBody),
        'Cookie': cookieString(sigla), 'Referer': `http://${ip}/`,
      }
    }, postBody);
    parseCookies(sigla, r2.headers);
    sess.loggedIn = true;
    console.log(`[${sigla}] PHB OK (${r2.statusCode})`);
  } catch(e) {
    console.error(`[${sigla}] Erro login PHB:`, e.message);
    sess.loggedIn = true;
  }
}

async function ensureLogin(sigla) {
  const sess = getSession(sigla);
  if (sess.loggedIn) return;
  const retif = RETIFICADORAS[sigla];
  if (retif.type === 'vertiv') await loginVertiv(sigla, retif.ip);
  else await loginPHB(sigla, retif.ip);
}

function proxyPipe(sigla, targetPath, clientReq, clientRes) {
  const retif = RETIFICADORAS[sigla];

  const options = {
    hostname: retif.ip, port: 80,
    path: targetPath, method: clientReq.method,
    headers: {
      'Host': retif.ip, 'Cookie': cookieString(sigla),
      'User-Agent': 'Mozilla/5.0',
      'Accept': clientReq.headers['accept'] || '*/*',
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'Connection': 'close',
    },
  };

  if (clientReq.method === 'POST') {
    if (clientReq.headers['content-type'])   options.headers['Content-Type']   = clientReq.headers['content-type'];
    if (clientReq.headers['content-length']) options.headers['Content-Length'] = clientReq.headers['content-length'];
  }

  const proxyReq = http.request(options, proxyRes => {
    parseCookies(sigla, proxyRes.headers);

    // Detecta se voltou para pagina de login — refaz login
    const ct = proxyRes.headers['content-type'] || '';

    if ([301,302,303,307,308].includes(proxyRes.statusCode)) {
      let loc = proxyRes.headers['location'] || '/';
      if (loc.startsWith('http')) { try { loc = new url.URL(loc).pathname; } catch(e) {} }
      clientRes.writeHead(302, { 'Location': `/proxy/${sigla}${loc}`, 'Access-Control-Allow-Origin': '*' });
      clientRes.end();
      return;
    }

    const outH = { 'Access-Control-Allow-Origin': '*' };
    Object.entries(proxyRes.headers).forEach(([k, v]) => {
      const kl = k.toLowerCase();
      if (['x-frame-options','content-security-policy','content-security-policy-report-only',
           'transfer-encoding','connection'].includes(kl)) return;
      if (kl === 'set-cookie') {
        outH['Set-Cookie'] = (Array.isArray(v)?v:[v]).map(c =>
          c.replace(/;\s*domain=[^;]*/i,'').replace(/;\s*secure/i,'').replace(/;\s*samesite=[^;]*/i,'')
        );
        return;
      }
      outH[k] = v;
    });

    clientRes.writeHead(proxyRes.statusCode, outH);
    proxyRes.pipe(clientRes);
  });

  proxyReq.on('error', err => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, {'Content-Type':'text/html','Access-Control-Allow-Origin':'*'});
      clientRes.end(`<h3>Equipamento inacessivel: ${sigla} (${retif.ip})</h3><p>${err.message}</p>`);
    }
  });
  proxyReq.setTimeout(10000, () => proxyReq.destroy());
  if (clientReq.method === 'POST') clientReq.pipe(proxyReq);
  else proxyReq.end();
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/' || req.url === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      fs.createReadStream(htmlPath).pipe(res);
    } else {
      res.writeHead(404); res.end('index.html nao encontrado');
    }
    return;
  }

  if (req.url === '/status') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({status:'online', porta: PORT}));
    return;
  }

  const match = req.url.match(/^\/proxy\/([A-Z]+)(\/[^?]*)?(\?.*)?$/);
  if (!match) { res.writeHead(404); res.end('Use /proxy/SIGLA/'); return; }

  const sigla   = match[1].toUpperCase();
  const subPath = (match[2] || '/') + (match[3] || '');
  if (!RETIFICADORAS[sigla]) { res.writeHead(404); res.end(`Sigla nao encontrada: ${sigla}`); return; }

  await ensureLogin(sigla);
  console.log(`[${new Date().toLocaleTimeString()}] ${sigla} -> ${subPath}`);
  proxyPipe(sigla, subPath, req, res);
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log('\n=================================================');
  console.log('  Proxy Retificadoras - porta ' + PORT);
  console.log('=================================================');
  Object.entries(RETIFICADORAS).forEach(([s,r]) => console.log(`  ${s.padEnd(4)} -> ${r.ip} [${r.type}]`));
  console.log('\nFazendo pre-login...');
  for (const sigla of Object.keys(RETIFICADORAS)) await ensureLogin(sigla);
  console.log('\n  ABRA: http://localhost:5050/');
  console.log('=================================================\n');
});
// Este arquivo sera substituido pelo proximo comando
