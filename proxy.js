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
let LAST_SIGLA = 'CPG';

function getSession(sigla) {
  if (!SESSIONS[sigla]) {
    SESSIONS[sigla] = { cookies: {}, loggedIn: false, loginInProgress: false };
  }
  return SESSIONS[sigla];
}

function cookieString(sigla) {
  const c = getSession(sigla).cookies;
  return Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; ');
}

function parseCookies(sigla, headers) {
  const sc = headers['set-cookie'];
  if (!sc) return;
  const arr = Array.isArray(sc) ? sc : [sc];
  const c = getSession(sigla).cookies;
  arr.forEach(line => {
    const part = line.split(';')[0].trim();
    const eq = part.indexOf('=');
    if (eq > 0) c[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  });
}

function clearSession(sigla) {
  SESSIONS[sigla] = { cookies: {}, loggedIn: false, loginInProgress: false };
}

function httpReq(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf-8')
      }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function looksLikeVertivLogin(body, headers = {}, statusCode = 200) {
  const location = String(headers.location || '');
  const text = String(body || '');
  return statusCode === 401 ||
         statusCode === 403 ||
         /login/i.test(location) ||
         /NetSure\s+CONTROL\s+UNIT/i.test(text) ||
         /name=["']user_name["']/i.test(text) ||
         /name=["']user_password["']/i.test(text) ||
         /data\.login\.html/i.test(text) ||
         /Forgot Password/i.test(text);
}

function looksLikePHBLogin(body, headers = {}, statusCode = 200) {
  const location = String(headers.location || '');
  const text = String(body || '');
  return statusCode === 401 ||
         statusCode === 403 ||
         /login/i.test(location) ||
         (/password/i.test(text) && /form/i.test(text));
}

async function loginVertiv(sigla, ip) {
  const sess = getSession(sigla);
  if (sess.loginInProgress) return;
  sess.loginInProgress = true;
  sess.loggedIn = false;

  console.log(`[${sigla}] Login Vertiv em ${ip}...`);
  try {
    const r1 = await httpReq({
      hostname: ip,
      port: 80,
      path: '/app/www_user/html/eng/login.html',
      method: 'GET',
      headers: {
        'Host': ip,
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html,*/*'
      }
    });
    parseCookies(sigla, r1.headers);

    const sessionMatch = r1.body.match(/name=["']session_id["'][^>]*value=["'](\d+)["']/i);
    const sessionId = sessionMatch ? sessionMatch[1] : '2';

    const postBody =
      `user_name=${encodeURIComponent(CREDS.vertiv.user)}` +
      `&user_password=${encodeURIComponent(CREDS.vertiv.pass)}` +
      `&language_type=0&session_id=${encodeURIComponent(sessionId)}`;

    const r2 = await httpReq({
      hostname: ip,
      port: 80,
      path: '/app/www_user/html/cgi-bin/web_cgi_main.cgi',
      method: 'POST',
      headers: {
        'Host': ip,
        'User-Agent': 'Mozilla/5.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postBody),
        'Cookie': cookieString(sigla),
        'Referer': `http://${ip}/app/www_user/html/eng/login.html`,
        'Origin': `http://${ip}`,
        'Accept': 'text/html,*/*'
      }
    }, postBody);
    parseCookies(sigla, r2.headers);

    const r3 = await httpReq({
      hostname: ip,
      port: 80,
      path: '/app/www_user/html/eng/index.html',
      method: 'GET',
      headers: {
        'Host': ip,
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html,*/*',
        'Cookie': cookieString(sigla),
        'Referer': `http://${ip}/app/www_user/html/eng/login.html`
      }
    });
    parseCookies(sigla, r3.headers);

    if (looksLikeVertivLogin(r3.body, r3.headers, r3.statusCode)) {
      throw new Error('Vertiv continuou na tela de login');
    }

    sess.loggedIn = true;
    console.log(`[${sigla}] Login Vertiv OK`);
  } catch (e) {
    console.error(`[${sigla}] Erro login Vertiv: ${e.message}`);
    sess.loggedIn = false;
  } finally {
    sess.loginInProgress = false;
  }
}

async function loginPHB(sigla, ip) {
  const sess = getSession(sigla);
  if (sess.loginInProgress) return;
  sess.loginInProgress = true;
  sess.loggedIn = false;

  console.log(`[${sigla}] Login PHB em ${ip}...`);
  try {
    const r1 = await httpReq({
      hostname: ip,
      port: 80,
      path: '/',
      method: 'GET',
      headers: {
        'Host': ip,
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html,*/*'
      }
    });
    parseCookies(sigla, r1.headers);

    const postBody = `password=${encodeURIComponent(CREDS.phb.pass)}`;
    const r2 = await httpReq({
      hostname: ip,
      port: 80,
      path: '/',
      method: 'POST',
      headers: {
        'Host': ip,
        'User-Agent': 'Mozilla/5.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postBody),
        'Cookie': cookieString(sigla),
        'Referer': `http://${ip}/`,
        'Origin': `http://${ip}`,
        'Accept': 'text/html,*/*'
      }
    }, postBody);
    parseCookies(sigla, r2.headers);

    const r3 = await httpReq({
      hostname: ip,
      port: 80,
      path: '/',
      method: 'GET',
      headers: {
        'Host': ip,
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html,*/*',
        'Cookie': cookieString(sigla),
        'Referer': `http://${ip}/`
      }
    });
    parseCookies(sigla, r3.headers);

    if (looksLikePHBLogin(r3.body, r3.headers, r3.statusCode)) {
      throw new Error('PHB continuou na tela de login');
    }

    sess.loggedIn = true;
    console.log(`[${sigla}] Login PHB OK`);
  } catch (e) {
    console.error(`[${sigla}] Erro login PHB: ${e.message}`);
    sess.loggedIn = false;
  } finally {
    sess.loginInProgress = false;
  }
}

async function ensureLogin(sigla, force = false) {
  if (!RETIFICADORAS[sigla]) return;
  if (force) clearSession(sigla);
  if (getSession(sigla).loggedIn) return;

  const retif = RETIFICADORAS[sigla];
  if (retif.type === 'vertiv') await loginVertiv(sigla, retif.ip);
  else await loginPHB(sigla, retif.ip);
}

function getSiglaFromRequest(req) {
  const m = req.url.match(/^\/proxy\/([A-Z]+)(?:\/|$)/i);
  if (m) return m[1].toUpperCase();

  const referer = String(req.headers.referer || '');
  const m2 = referer.match(/\/proxy\/([A-Z]+)(?:\/|$)/i);
  if (m2) return m2[1].toUpperCase();

  return LAST_SIGLA;
}

function isAbsoluteEquipmentPath(reqUrl) {
  if (!reqUrl || reqUrl === '/' || reqUrl === '/index.html' || reqUrl === '/status') {
    return false;
  }

  return (
    reqUrl.startsWith('/var/') ||
    reqUrl.startsWith('/app/') ||
    reqUrl.startsWith('/cgi-bin/') ||
    reqUrl.startsWith('/js/') ||
    reqUrl.startsWith('/css/') ||
    reqUrl.startsWith('/images/') ||
    reqUrl.startsWith('/img/') ||
    reqUrl.startsWith('/xml/') ||
    reqUrl.startsWith('/ajax/') ||
    reqUrl.startsWith('/api/') ||
    /\.(gif|png|jpg|jpeg|bmp|ico|svg|js|css|xml|json)$/i.test(reqUrl)
  );
}

function proxyPipe(sigla, targetPath, clientReq, clientRes, retry = true) {
  const retif = RETIFICADORAS[sigla];
  if (!retif) {
    clientRes.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    clientRes.end(`Sigla nao encontrada: ${sigla}`);
    return;
  }

  const headers = {
    'Host': retif.ip,
    'Cookie': cookieString(sigla),
    'User-Agent': clientReq.headers['user-agent'] || 'Mozilla/5.0',
    'Accept': clientReq.headers['accept'] || '*/*',
    'Accept-Language': clientReq.headers['accept-language'] || 'pt-BR,pt;q=0.9',
    'Connection': 'close',
    'Referer': `http://${retif.ip}/`,
    'Origin': `http://${retif.ip}`
  };

  if (clientReq.headers['content-type']) headers['Content-Type'] = clientReq.headers['content-type'];
  if (clientReq.headers['content-length']) headers['Content-Length'] = clientReq.headers['content-length'];
  if (clientReq.headers['x-requested-with']) headers['X-Requested-With'] = clientReq.headers['x-requested-with'];

  const options = {
    hostname: retif.ip,
    port: 80,
    path: targetPath,
    method: clientReq.method,
    headers
  };

  const proxyReq = http.request(options, proxyRes => {
    parseCookies(sigla, proxyRes.headers);

    const status = proxyRes.statusCode || 0;
    const ctype = String(proxyRes.headers['content-type'] || '');
    const location = String(proxyRes.headers['location'] || '');

    if ([301, 302, 303, 307, 308].includes(status)) {
      let loc = location || '/';
      if (loc.startsWith('http')) {
        try {
          const u = new url.URL(loc);
          loc = u.pathname + (u.search || '');
        } catch (_) {}
      }
      if (!loc.startsWith('/')) loc = '/' + loc;
      clientRes.writeHead(302, {
        'Location': `/proxy/${sigla}${loc}`,
        'Access-Control-Allow-Origin': '*'
      });
      clientRes.end();
      return;
    }

    const chunks = [];
    proxyRes.on('data', d => chunks.push(d));
    proxyRes.on('end', async () => {
      let bodyBuffer = Buffer.concat(chunks);
      const isText =
        ctype.includes('text/') ||
        ctype.includes('javascript') ||
        ctype.includes('json') ||
        ctype.includes('xml');

      let bodyText = isText ? bodyBuffer.toString('utf-8') : null;

      const isLoginPage = retif.type === 'vertiv'
        ? looksLikeVertivLogin(bodyText, proxyRes.headers, status)
        : looksLikePHBLogin(bodyText, proxyRes.headers, status);

      if (isLoginPage && retry) {
        console.log(`[${sigla}] Sessao expirada em ${targetPath}. Refazendo login...`);
        await ensureLogin(sigla, true);
        return proxyPipe(sigla, targetPath, clientReq, clientRes, false);
      }

      const outH = { 'Access-Control-Allow-Origin': '*' };

      Object.entries(proxyRes.headers).forEach(([k, v]) => {
        const kl = k.toLowerCase();

        if ([
          'x-frame-options',
          'content-security-policy',
          'content-security-policy-report-only',
          'transfer-encoding',
          'connection',
          'content-length'
        ].includes(kl)) return;

        if (kl === 'set-cookie') {
          outH['Set-Cookie'] = (Array.isArray(v) ? v : [v]).map(c =>
            c.replace(/;\s*domain=[^;]*/i, '')
             .replace(/;\s*secure/i, '')
             .replace(/;\s*samesite=[^;]*/i, '')
          );
          return;
        }

        if (kl === 'location') {
          let loc = String(v);
          if (loc.startsWith('http')) {
            try {
              const u = new url.URL(loc);
              loc = u.pathname + (u.search || '');
            } catch (_) {}
          }
          if (!loc.startsWith('/')) loc = '/' + loc;
          outH['Location'] = `/proxy/${sigla}${loc}`;
          return;
        }

        outH[k] = v;
      });

      if (bodyText !== null) {
        bodyText = rewriteTextBody(sigla, bodyText);
        outH['Content-Length'] = Buffer.byteLength(bodyText);
        clientRes.writeHead(status, outH);
        clientRes.end(bodyText);
        return;
      }

      outH['Content-Length'] = bodyBuffer.length;
      clientRes.writeHead(status, outH);
      clientRes.end(bodyBuffer);
    });
  });

  proxyReq.on('error', err => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      clientRes.end(`<h3>Equipamento inacessivel: ${sigla} (${retif.ip})</h3><p>${err.message}</p>`);
    }
  });

  proxyReq.setTimeout(10000, () => proxyReq.destroy(new Error('Timeout')));

  if (clientReq.method === 'POST') clientReq.pipe(proxyReq);
  else proxyReq.end();
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/' || req.url === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(htmlPath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('index.html nao encontrado');
    }
    return;
  }

  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'online', porta: PORT }));
    return;
  }

  const match = req.url.match(/^\/proxy\/([A-Z]+)(\/[^?]*)?(\?.*)?$/);

  if (match) {
    const sigla = match[1].toUpperCase();
    let subPath = (match[2] || '/') + (match[3] || '');

    if (RETIFICADORAS[sigla] && RETIFICADORAS[sigla].type === 'vertiv' && subPath === '/') {
  subPath = '/app/www_user/html/eng/index.html';
}
    if (!RETIFICADORAS[sigla]) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Sigla nao encontrada: ${sigla}`);
      return;
    }

    LAST_SIGLA = sigla;
    await ensureLogin(sigla);
    console.log(`[${new Date().toLocaleTimeString()}] ${sigla} -> ${subPath}`);
    return proxyPipe(sigla, subPath, req, res);
  }

  if (isAbsoluteEquipmentPath(req.url)) {
    const sigla = getSiglaFromRequest(req);

    if (!RETIFICADORAS[sigla]) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Nao foi possivel identificar a retificadora para ${req.url}`);
      return;
    }

    LAST_SIGLA = sigla;
    await ensureLogin(sigla);
    console.log(`[${new Date().toLocaleTimeString()}] ${sigla} -> ${req.url} [ABS]`);
    return proxyPipe(sigla, req.url, req, res);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Use /proxy/SIGLA/');
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log('\n=================================================');
  console.log('  Proxy Retificadoras - login automatico');
  console.log('=================================================');
  Object.entries(RETIFICADORAS).forEach(([s, r]) => {
    console.log(`  ${s.padEnd(4)} -> ${r.ip} [${r.type}]`);
  });
  console.log('\nFazendo pre-login...');
  for (const sigla of Object.keys(RETIFICADORAS)) {
    await ensureLogin(sigla, true);
  }
  console.log('\n  ABRA: http://localhost:5050/');
  console.log('=================================================\n');
});