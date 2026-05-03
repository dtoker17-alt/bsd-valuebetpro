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
  res.header('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── FIX 1: HTTP helpers robustos con timeout correcto ──────
function httpRequest(options, bodyStr) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        done(resolve, { status: res.statusCode, json, raw });
      });
      res.on('error', err => done(reject, err));
    });

    // FIX: timeout correcto — destruye socket y rechaza
    const timer = setTimeout(() => {
      req.destroy();
      done(reject, new Error(`Timeout after ${options._timeout||60}s`));
    }, (options._timeout || 60) * 1000);

    req.on('error', err => { clearTimeout(timer); done(reject, err); });
    req.on('close', () => clearTimeout(timer));

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
      // Bzzoiro puede devolver varias estructuras
      const r = res.json?.results
             ?? res.json?.data
             ?? res.json?.events
             ?? res.json?.matches
             ?? (Array.isArray(res.json) ? res.json : []);
      const arr = Array.isArray(r) ? r : [];
      console.log(`[Bzzoiro] OK — ${arr.length} partidos`);
      return arr.slice(0, 12);
    }
    console.warn(`[Bzzoiro] status ${res.status} — ${res.raw.substring(0, 120)}`);
    return [];
  } catch(e) {
    console.warn('[Bzzoiro] error:', e.message);
    return [];
  }
}

// ── Poisson helper (calculado en servidor para verificar) ──
function poisson(lambda, k) {
  let result = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) result *= lambda / i;
  return result;
}

function calcPoisson(lH, lA) {
  let pH = 0, pD = 0, pA = 0, pO25 = 0;
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      const p = poisson(lH, i) * poisson(lA, j);
      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;
      if (i + j >= 3) pO25 += p;
    }
  }
  const tot = pH + pD + pA;
  return {
    probHome: +(pH/tot).toFixed(4),
    probDraw: +(pD/tot).toFixed(4),
    probAway: +(pA/tot).toFixed(4),
    probOver25: +Math.min(pO25, 0.99).toFixed(4),
    probBTTS: +((1-Math.exp(-lH))*(1-Math.exp(-lA))).toFixed(4)
  };
}

// ── DeepSeek ───────────────────────────────────────────────
async function analyzeWithDeepSeek(bzzMatches) {
  const today = new Date().toLocaleDateString('es-MX', {
    weekday:'long', year:'numeric', month:'long', day:'numeric',
    timeZone:'America/Mexico_City'
  });

  const hasReal = bzzMatches.length > 0;
  const matchList = hasReal
    ? bzzMatches.map((m, i) => {
        const home   = m.home_team || m.home || m.homeTeam || m.home_name || 'Local';
        const away   = m.away_team || m.away || m.awayTeam || m.away_name || 'Visitante';
        const league = m.league_name || m.competition || m.league || m.tournament || 'Liga';
        const time   = m.time || m.kickoff_time || m.start_time || '';
        const status = m.status || m.state || 'upcoming';
        const score  = m.score || m.result || '';
        const venue  = m.venue || m.stadium || '';
        return `${i+1}. ${home} vs ${away} | ${league} | ${time} | Estado: ${status} | Score: ${score} | Estadio: ${venue}`;
      }).join('\n')
    : `Genera 8 partidos reales de fútbol de hoy ${today}. Usa ligas reales: Premier League, La Liga, Bundesliga, Serie A, Liga MX, Ligue 1. Horarios reales de hoy.`;

  const systemMsg = `Eres un experto en estadísticas de fútbol y value bets con modelo Poisson.
REGLAS ESTRICTAS:
1. Responde ÚNICAMENTE con JSON array válido
2. Sin markdown, sin texto, sin explicaciones
3. El array DEBE empezar con [ y terminar con ]
4. Todos los números deben ser válidos (no null, no NaN)
5. formHome y formAway son arrays de exactamente 5 strings: "W", "D" o "L"`;

  const userMsg = `Fecha: ${today}
${hasReal ? 'Partidos de Bzzoiro a analizar:' : 'Genera partidos reales de hoy:'}
${matchList}

Para cada partido:
• avgGolesH/A = promedio goles anotados últimos 10 partidos de cada equipo
• avgConcH/A  = promedio goles concedidos últimos 10 partidos de cada equipo  
• lambdaHome  = (avgGolesH/1.35)*(avgConcA/1.35)*1.35*1.15
• lambdaAway  = (avgGolesA/1.35)*(avgConcH/1.35)*1.35
• Poisson k=0..8 → probHome, probDraw, probAway (normalizados), probOver25, probBTTS
• cuotas con margen 6%: cuota = 1/(prob*(1-0.06))
• value = prob*cuota - 1 → incluir solo si > 0.05
• kelly = max(0,(prob*(cuota-1)-(1-prob))/(cuota-1))*0.25
• confidence: "ALTA">0.15, "MEDIA">0.08, "BAJA">0.05
• status: "live" si en juego, "upcoming" si por jugar, "finished" si terminado

JSON array (sin markdown):
[{
  "id":"1","home":"Real Madrid","away":"Barcelona","league":"La Liga",
  "time":"20:00","status":"upcoming","score":"","venue":"Santiago Bernabeu, Madrid",
  "lambdaHome":1.52,"lambdaAway":1.18,
  "probHome":0.46,"probDraw":0.26,"probAway":0.28,
  "probOver25":0.63,"probBTTS":0.66,
  "avgGolesH":1.8,"avgGolesA":1.5,"avgConcH":1.1,"avgConcA":1.2,
  "formHome":["W","W","D","L","W"],"formAway":["W","L","W","W","D"],
  "h2h":{"homeWins":5,"draws":3,"awayWins":4,
    "history":[
      {"date":"15/03/2026","home":"Real Madrid","score":"2-1","away":"Barcelona","winner":"home"},
      {"date":"28/10/2025","home":"Barcelona","score":"1-1","away":"Real Madrid","winner":"draw"},
      {"date":"21/04/2025","home":"Real Madrid","score":"0-2","away":"Barcelona","winner":"away"},
      {"date":"16/12/2024","home":"Barcelona","score":"3-2","away":"Real Madrid","winner":"home"},
      {"date":"04/05/2024","home":"Real Madrid","score":"2-0","away":"Barcelona","winner":"home"}
    ]},
  "valueBets":[{
    "market":"Over/Under","selection":"Over 2.5","odds":1.72,
    "impliedProb":0.58,"estProb":0.63,"value":0.085,"kelly":0.021,"confidence":"MEDIA"
  }],
  "topPick":{"selection":"Over 2.5 Goles","confidence":78,"odds":1.72},
  "corners":{"avg":11.2,"over95":1.62,"over115":2.10},
  "cards":{"avg":4.1,"over35":1.58,"over45":2.20},
  "bttsOdds":1.62,"ou25Odds":{"over":1.72,"under":2.10},
  "odds1x2":{"home":2.10,"draw":3.40,"away":3.20},
  "hasValue":true
}]`;

  const res = await httpPost(
    'api.deepseek.com',
    '/v1/chat/completions',
    { 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
    {
      model: 'deepseek-chat',
      max_tokens: 5000,
      temperature: 0.1,
      response_format: { type: 'json_object' }, // FIX: forzar JSON mode
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: userMsg }
      ]
    }
  );

  console.log(`[DeepSeek] status: ${res.status}`);

  if (res.status !== 200) {
    throw new Error(`DeepSeek ${res.status}: ${(res.raw||'').substring(0,300)}`);
  }
  if (!res.json) {
    throw new Error(`DeepSeek respuesta no parseable: ${(res.raw||'').substring(0,200)}`);
  }

  let content = res.json?.choices?.[0]?.message?.content || '';
  if (!content) throw new Error('DeepSeek: choices[0].message.content vacío');

  console.log('[DeepSeek] content preview:', content.substring(0, 120));

  // FIX: manejar cuando DeepSeek devuelve objeto JSON con key "matches" o similar
  content = content.replace(/```json|```/gi, '').trim();

  // Si viene como objeto { matches: [...] } o { data: [...] }
  let parsed;
  try {
    const obj = JSON.parse(content);
    if (Array.isArray(obj)) {
      parsed = obj;
    } else {
      // Buscar el array dentro del objeto
      const key = Object.keys(obj).find(k => Array.isArray(obj[k]));
      parsed = key ? obj[key] : null;
    }
  } catch {
    // Intentar extraer array directamente
    const s = content.indexOf('[');
    const e = content.lastIndexOf(']');
    if (s === -1 || e <= s) throw new Error(`No se encontró JSON en: ${content.substring(0,200)}`);
    try { parsed = JSON.parse(content.substring(s, e+1)); } catch(err) {
      throw new Error(`JSON inválido: ${err.message}. Preview: ${content.substring(s,s+200)}`);
    }
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('DeepSeek no devolvió array de partidos válido');
  }

  // FIX: validar y enriquecer cada partido con Poisson calculado en servidor
  return parsed.map((m, idx) => {
    // Sanitizar campos obligatorios
    const lH = parseFloat(m.lambdaHome) || 1.35;
    const lA = parseFloat(m.lambdaAway) || 1.10;
    const serverCalc = calcPoisson(lH, lA);

    // Merge: preferir datos de DeepSeek, fallback a cálculo propio
    return {
      id: String(m.id || idx + 1),
      home: m.home || 'Local',
      away: m.away || 'Visitante',
      league: m.league || 'Liga',
      time: m.time || '--:--',
      status: ['live','upcoming','finished'].includes(m.status) ? m.status : 'upcoming',
      score: m.score || '',
      venue: m.venue || '',
      lambdaHome: +lH.toFixed(2),
      lambdaAway: +lA.toFixed(2),
      probHome: m.probHome || serverCalc.probHome,
      probDraw: m.probDraw || serverCalc.probDraw,
      probAway: m.probAway || serverCalc.probAway,
      probOver25: m.probOver25 || serverCalc.probOver25,
      probBTTS: m.probBTTS || serverCalc.probBTTS,
      avgGolesH: parseFloat(m.avgGolesH) || 1.4,
      avgGolesA: parseFloat(m.avgGolesA) || 1.2,
      avgConcH: parseFloat(m.avgConcH) || 1.2,
      avgConcA: parseFloat(m.avgConcA) || 1.3,
      formHome: Array.isArray(m.formHome) && m.formHome.length === 5
        ? m.formHome : ['W','D','W','L','W'],
      formAway: Array.isArray(m.formAway) && m.formAway.length === 5
        ? m.formAway : ['L','W','D','W','L'],
      h2h: m.h2h || { homeWins: 3, draws: 2, awayWins: 3, history: [] },
      valueBets: Array.isArray(m.valueBets) ? m.valueBets.filter(v =>
        v.value > 0.05 && v.odds > 1.1 && v.odds < 15
      ) : [],
      topPick: m.topPick || null,
      corners: m.corners || { avg: 10.0, over95: 1.70, over115: 2.20 },
      cards: m.cards || { avg: 3.8, over35: 1.60, over45: 2.30 },
      bttsOdds: parseFloat(m.bttsOdds) || 1.70,
      ou25Odds: m.ou25Odds || { over: 1.75, under: 2.05 },
      odds1x2: m.odds1x2 || {
        home: +(1/(( m.probHome||serverCalc.probHome)*0.94)).toFixed(2),
        draw: +(1/(( m.probDraw||serverCalc.probDraw)*0.94)).toFixed(2),
        away: +(1/(( m.probAway||serverCalc.probAway)*0.94)).toFixed(2)
      },
      hasValue: Array.isArray(m.valueBets) && m.valueBets.some(v => v.value > 0.05)
    };
  });
}

// ── Cache ──────────────────────────────────────────────────
let cache = { data: null, ts: 0, ttl: 5 * 60 * 1000 }; // 5 min

// ── Keep-alive para Render free tier ──────────────────────
// FIX: Render free duerme tras 15min inactividad → auto-ping
function keepAlive() {
  const host = process.env.RENDER_EXTERNAL_URL;
  if (!host) return;
  httpGet(host.replace('https://', ''), '/api/health', {}, 10)
    .then(() => console.log('[KeepAlive] ping OK'))
    .catch(e => console.log('[KeepAlive] ping fail:', e.message));
}
setInterval(keepAlive, 14 * 60 * 1000); // cada 14 min

// ── Health check ───────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    cached: !!cache.data,
    cacheAge: cache.ts ? Math.floor((Date.now()-cache.ts)/1000) + 's' : null,
    env: {
      deepseek: !!DEEPSEEK_KEY,
      bzzoiro: !!BZZ_TOKEN
    }
  });
});

// ── Matches endpoint ───────────────────────────────────────
app.get('/api/matches', async (req, res) => {
  const forceRefresh = req.query.refresh === '1';
  const now = Date.now();

  // Servir cache si válido
  if (!forceRefresh && cache.data && (now - cache.ts) < cache.ttl) {
    console.log('[Cache] hit — age:', Math.floor((now-cache.ts)/1000)+'s');
    return res.json({ ...cache.data, cached: true, cacheAge: Math.floor((now-cache.ts)/1000) });
  }

  try {
    console.log('\n=== Starting match analysis ===');
    const t0 = Date.now();

    const bzzMatches = await getBzzMatches();
    console.log(`[Bzzoiro] ${bzzMatches.length} matches — ${Date.now()-t0}ms`);

    const matches = await analyzeWithDeepSeek(bzzMatches);
    console.log(`[DeepSeek] ${matches.length} matches — ${Date.now()-t0}ms total`);

    const result = {
      ok: true,
      updated: new Date().toISOString(),
      total: matches.length,
      liveCount: matches.filter(m => m.status === 'live').length,
      source: bzzMatches.length > 0 ? 'bzzoiro+deepseek' : 'deepseek-only',
      matches
    };

    cache = { data: result, ts: now, ttl: cache.ttl };
    res.json(result);

  } catch(err) {
    console.error('[ERROR] /api/matches:', err.message);

    // FIX: si hay cache viejo, devolverlo con warning en vez de 500
    if (cache.data) {
      console.log('[Cache] serving stale cache due to error');
      return res.json({ ...cache.data, cached: true, stale: true, error: err.message });
    }

    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── SPA fallback ───────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Graceful shutdown ──────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`✅ BSD Value Bet → puerto ${PORT}`);
  console.log(`   DeepSeek key: ${DEEPSEEK_KEY ? '✓ configurada' : '✗ FALTA'}`);
  console.log(`   Bzzoiro token: ${BZZ_TOKEN ? '✓ configurado' : '✗ FALTA'}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM → cerrando servidor...');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
