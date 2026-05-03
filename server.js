const express = require('express');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || 'sk-b6dfe3530a064e86b412c2d553b7e11c';
const BZZ_TOKEN    = process.env.BZZOIRO_TOKEN    || '7a23ce5699426d2a0d1f99a56fbd254f33c4184f';

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── HTTP helper ────────────────────────────────────────────
function httpRequest(options, bodyStr) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    const timeoutMs = (options._timeout || 60) * 1000;

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        done(resolve, { status: res.statusCode, json, raw });
      });
      res.on('error', err => { clearTimeout(timer); done(reject, err); });
    });

    const timer = setTimeout(() => {
      req.destroy();
      done(reject, new Error(`Timeout after ${options._timeout||60}s`));
    }, timeoutMs);

    req.on('error', err => { clearTimeout(timer); done(reject, err); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function httpGet(hostname, urlPath, headers, timeoutSec = 12) {
  return httpRequest({
    hostname, path: urlPath, method: 'GET',
    headers: { 'Accept': 'application/json', ...headers },
    _timeout: timeoutSec
  });
}

function httpPost(hostname, urlPath, headers, bodyObj, timeoutSec = 58) {
  const bodyStr = JSON.stringify(bodyObj);
  return httpRequest({
    hostname, path: urlPath, method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      ...headers
    },
    _timeout: timeoutSec
  }, bodyStr);
}

// ── Poisson en servidor ────────────────────────────────────
function poisson(lambda, k) {
  let r = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) r *= lambda / i;
  return r;
}

function calcPoisson(lH, lA) {
  let pH = 0, pD = 0, pA = 0, pO = 0;
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      const p = poisson(lH, i) * poisson(lA, j);
      if (i > j) pH += p; else if (i === j) pD += p; else pA += p;
      if (i + j >= 3) pO += p;
    }
  }
  const tot = pH + pD + pA;
  return {
    probHome:   +(pH/tot).toFixed(4),
    probDraw:   +(pD/tot).toFixed(4),
    probAway:   +(pA/tot).toFixed(4),
    probOver25: +Math.min(pO, 0.99).toFixed(4),
    probBTTS:   +((1-Math.exp(-lH))*(1-Math.exp(-lA))).toFixed(4)
  };
}

// ── Reparar JSON truncado ─────────────────────────────────
function repairJSON(str) {
  // Intenta parsear directo
  try { return JSON.parse(str); } catch {}

  // Buscar el array
  const s = str.indexOf('[');
  if (s === -1) throw new Error('No se encontró [ en la respuesta');
  let content = str.substring(s);

  // Intentar cerrar el JSON si está truncado
  // Contar objetos completos
  const objects = [];
  let depth = 0, inStr = false, escape = false, objStart = -1;

  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;

    if (c === '{') {
      if (depth === 1) objStart = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 1 && objStart !== -1) {
        try {
          const obj = JSON.parse(content.substring(objStart, i + 1));
          objects.push(obj);
          objStart = -1;
        } catch {}
      }
    } else if (c === '[') {
      if (i === 0) depth++;
    }
  }

  if (objects.length > 0) {
    console.log(`[repairJSON] Recuperados ${objects.length} objetos de JSON truncado`);
    return objects;
  }

  throw new Error('No se pudo reparar el JSON truncado');
}

// ── Bzzoiro ────────────────────────────────────────────────
async function getBzzMatches() {
  const today = new Date().toISOString().split('T')[0];
  try {
    const res = await httpGet(
      'sports.bzzoiro.com',
      `/api/events/?date_from=${today}&date_to=${today}&sport=soccer`,
      { 'Authorization': BZZ_TOKEN }
    );
    if (res.status === 200 && res.json) {
      const r = res.json?.results ?? res.json?.data ?? res.json?.events ?? res.json?.matches ?? (Array.isArray(res.json) ? res.json : []);
      const arr = Array.isArray(r) ? r : [];
      console.log(`[Bzzoiro] ${arr.length} partidos`);
      return arr.slice(0, 5); // MAX 5 para no truncar DeepSeek
    }
    console.warn(`[Bzzoiro] status ${res.status}`);
    return [];
  } catch(e) {
    console.warn('[Bzzoiro]', e.message);
    return [];
  }
}

// ── DeepSeek ───────────────────────────────────────────────
async function analyzeWithDeepSeek(bzzMatches) {
  const today = new Date().toLocaleDateString('es-MX', {
    weekday:'long', year:'numeric', month:'long', day:'numeric',
    timeZone:'America/Mexico_City'
  });

  const hasReal = bzzMatches.length > 0;
  const matchList = hasReal
    ? bzzMatches.slice(0, 5).map((m, i) => {
        const home   = m.home_team || m.home || m.homeTeam || 'Local';
        const away   = m.away_team || m.away || m.awayTeam || 'Visitante';
        const league = m.league_name || m.competition || m.league || 'Liga';
        const time   = m.time || m.kickoff_time || '';
        const status = m.status || 'upcoming';
        return `${i+1}. ${home} vs ${away} | ${league} | ${time} | ${status}`;
      }).join('\n')
    : `Genera exactamente 5 partidos reales de hoy ${today}:\n1. Premier League\n2. La Liga\n3. Bundesliga\n4. Serie A\n5. Liga MX`;

  // Prompt MÁS CORTO para evitar truncamiento
  const userMsg = `${today}. Analiza estos partidos y devuelve SOLO JSON array. Sin texto extra. Sin markdown.

Partidos:
${matchList}

Por cada partido:
- Usa estadísticas reales de esos equipos
- lambdaH=(avgGH/1.35)*(avgCA/1.35)*1.35*1.15, lambdaA=(avgGA/1.35)*(avgCH/1.35)*1.35
- Poisson k=0..8, normalizar probs
- probOver25=suma(i+j>=3), probBTTS=(1-e^-lH)*(1-e^-lA)
- cuota=1/(prob*0.94), value=prob*cuota-1, kelly=max(0,(p*(q-1)-(1-p))/(q-1))*0.25
- Solo incluir valueBets con value>0.05

Formato JSON (5 objetos máximo):
[{"id":"1","home":"X","away":"Y","league":"L","time":"HH:MM","status":"upcoming","score":"","venue":"Estadio, Ciudad","lambdaHome":1.5,"lambdaAway":1.1,"probHome":0.45,"probDraw":0.26,"probAway":0.29,"probOver25":0.62,"probBTTS":0.65,"avgGolesH":1.6,"avgGolesA":1.3,"avgConcH":1.1,"avgConcA":1.2,"formHome":["W","W","D","L","W"],"formAway":["L","W","W","D","W"],"h2h":{"homeWins":4,"draws":3,"awayWins":3,"history":[{"date":"DD/MM/AAAA","home":"X","score":"2-1","away":"Y","winner":"home"}]},"valueBets":[{"market":"O/U","selection":"Over 2.5","odds":1.72,"impliedProb":0.58,"estProb":0.62,"value":0.066,"kelly":0.016,"confidence":"MEDIA"}],"topPick":{"selection":"Over 2.5","confidence":72,"odds":1.72},"corners":{"avg":10.5,"over95":1.65,"over115":2.10},"cards":{"avg":3.8,"over35":1.55,"over45":2.30},"bttsOdds":1.65,"ou25Odds":{"over":1.72,"under":2.10},"odds1x2":{"home":2.20,"draw":3.50,"away":3.10},"hasValue":true}]`;

  const res = await httpPost(
    'api.deepseek.com',
    '/v1/chat/completions',
    { 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
    {
      model: 'deepseek-chat',
      max_tokens: 8000,
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'Responde SOLO con JSON array válido. Empieza con [ y termina con ]. Sin markdown ni texto adicional.' },
        { role: 'user', content: userMsg }
      ]
    }
  );

  console.log(`[DeepSeek] status: ${res.status}, raw length: ${res.raw?.length}`);

  if (res.status !== 200) throw new Error(`DeepSeek ${res.status}: ${(res.raw||'').substring(0,300)}`);
  if (!res.json) throw new Error(`DeepSeek no devolvió JSON: ${(res.raw||'').substring(0,200)}`);

  const content = res.json?.choices?.[0]?.message?.content || '';
  if (!content) throw new Error('DeepSeek: content vacío');

  console.log(`[DeepSeek] content length: ${content.length}, preview: ${content.substring(0,80)}`);

  // Limpiar markdown
  const clean = content.replace(/```json|```/gi, '').trim();

  // Parsear con reparación automática si está truncado
  let parsed;
  try {
    parsed = repairJSON(clean);
  } catch(e) {
    throw new Error(`JSON inválido: ${e.message} | Preview: ${clean.substring(0,200)}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('DeepSeek no devolvió array válido');
  }

  // Validar y enriquecer con Poisson del servidor
  return parsed.map((m, idx) => {
    const lH = parseFloat(m.lambdaHome) || 1.35;
    const lA = parseFloat(m.lambdaAway) || 1.10;
    const sp = calcPoisson(lH, lA); // server poisson

    return {
      id: String(m.id || idx + 1),
      home:   String(m.home || 'Local'),
      away:   String(m.away || 'Visitante'),
      league: String(m.league || 'Liga'),
      time:   String(m.time || '--:--'),
      status: ['live','upcoming','finished'].includes(m.status) ? m.status : 'upcoming',
      score:  String(m.score || ''),
      venue:  String(m.venue || ''),
      lambdaHome: +lH.toFixed(2),
      lambdaAway: +lA.toFixed(2),
      probHome:   m.probHome   || sp.probHome,
      probDraw:   m.probDraw   || sp.probDraw,
      probAway:   m.probAway   || sp.probAway,
      probOver25: m.probOver25 || sp.probOver25,
      probBTTS:   m.probBTTS   || sp.probBTTS,
      avgGolesH: parseFloat(m.avgGolesH) || 1.4,
      avgGolesA: parseFloat(m.avgGolesA) || 1.2,
      avgConcH:  parseFloat(m.avgConcH)  || 1.2,
      avgConcA:  parseFloat(m.avgConcA)  || 1.3,
      formHome: Array.isArray(m.formHome) && m.formHome.length === 5 ? m.formHome : ['W','D','W','L','W'],
      formAway: Array.isArray(m.formAway) && m.formAway.length === 5 ? m.formAway : ['L','W','D','W','L'],
      h2h: {
        homeWins: m.h2h?.homeWins || 3,
        draws:    m.h2h?.draws    || 2,
        awayWins: m.h2h?.awayWins || 3,
        history:  Array.isArray(m.h2h?.history) ? m.h2h.history : []
      },
      valueBets: Array.isArray(m.valueBets)
        ? m.valueBets.filter(v => v && typeof v.value === 'number' && v.value > 0.05 && v.odds > 1.05 && v.odds < 20)
        : [],
      topPick: m.topPick || null,
      corners:  m.corners  || { avg: 10.0, over95: 1.70, over115: 2.20 },
      cards:    m.cards    || { avg: 3.8,  over35: 1.60, over45:  2.30 },
      bttsOdds: parseFloat(m.bttsOdds) || 1.70,
      ou25Odds: m.ou25Odds || { over: 1.75, under: 2.05 },
      odds1x2:  m.odds1x2  || {
        home: +(1/((m.probHome||sp.probHome)*0.94)).toFixed(2),
        draw: +(1/((m.probDraw||sp.probDraw)*0.94)).toFixed(2),
        away: +(1/((m.probAway||sp.probAway)*0.94)).toFixed(2)
      },
      hasValue: Array.isArray(m.valueBets) && m.valueBets.some(v => v && v.value > 0.05)
    };
  });
}

// ── Cache ──────────────────────────────────────────────────
let cache = { data: null, ts: 0 };
const CACHE_TTL = 5 * 60 * 1000;

// ── Keep-alive Render free ─────────────────────────────────
setInterval(() => {
  const host = process.env.RENDER_EXTERNAL_URL;
  if (!host) return;
  httpGet(host.replace('https://',''), '/api/health', {}, 10)
    .catch(e => console.log('[KeepAlive]', e.message));
}, 14 * 60 * 1000);

// ── Health ─────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    cached: !!cache.data,
    cacheAge: cache.ts ? Math.floor((Date.now()-cache.ts)/1000)+'s' : null
  });
});

// ── Matches ────────────────────────────────────────────────
app.get('/api/matches', async (req, res) => {
  const now = Date.now();
  if (cache.data && (now - cache.ts) < CACHE_TTL) {
    return res.json({ ...cache.data, cached: true });
  }

  try {
    console.log('\n=== Analysis start ===');
    const bzzMatches = await getBzzMatches();
    const matches = await analyzeWithDeepSeek(bzzMatches);

    const result = {
      ok: true,
      updated: new Date().toISOString(),
      total: matches.length,
      liveCount: matches.filter(m => m.status === 'live').length,
      source: bzzMatches.length > 0 ? 'bzzoiro+deepseek' : 'deepseek-only',
      matches
    };

    cache = { data: result, ts: now };
    res.json(result);

  } catch(err) {
    console.error('[ERROR]', err.message);
    // Devolver cache viejo si existe
    if (cache.data) return res.json({ ...cache.data, cached: true, stale: true, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`✅ BSD Value Bet → puerto ${PORT}`);
  console.log(`   DeepSeek: ${DEEPSEEK_KEY ? '✓' : '✗ FALTA'}`);
  console.log(`   Bzzoiro:  ${BZZ_TOKEN  ? '✓' : '✗ FALTA'}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
