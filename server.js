// ─────────────────────────────────────────────────────────────────────────
//  server.js — Express-Server: liefert das Frontend aus und stellt die API
//  bereit. Rechnet die Analyse serverseitig und reicht sie ans UI durch.
// ─────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/store.js';
import { analyze, DEFAULT_CONFIG } from './lib/analytics.js';
import { coachAdvice } from './lib/coach.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const APP_PASSWORD = process.env.APP_PASSWORD || '';

const store = await createStore(process.env);
const app = express();
app.use(express.json());

// Optionaler, sehr simpler Zugriffsschutz (nur für den privaten Gebrauch).
if (APP_PASSWORD) {
  app.use((req, res, next) => {
    const token = req.get('x-app-password') || req.query.pw;
    const isApi = req.path.startsWith('/api/');
    if (!isApi) return next();                       // statische Seite lädt immer
    if (token === APP_PASSWORD) return next();
    res.status(401).json({ error: 'unauthorized' });
  });
}

// ── API ────────────────────────────────────────────────────────────────────
app.get('/api/state', wrap(async (_req, res) => {
  const [entries, config] = await Promise.all([store.getEntries(), store.getConfig()]);
  const analysis = analyze(entries, config);
  res.json({ backend: store.backend, entries, config, analysis, passwordRequired: !!APP_PASSWORD });
}));

app.get('/api/entries', wrap(async (_req, res) => res.json(await store.getEntries())));

app.post('/api/entries', wrap(async (req, res) => {
  const entry = sanitizeEntry(req.body);
  if (!entry.date) return res.status(400).json({ error: 'date fehlt (YYYY-MM-DD)' });
  await store.upsertEntry(entry);
  await respondWithState(res);
}));

app.delete('/api/entries/:date', wrap(async (req, res) => {
  await store.deleteEntry(req.params.date);
  await respondWithState(res);
}));

app.get('/api/config', wrap(async (_req, res) => res.json(await store.getConfig())));

app.put('/api/config', wrap(async (req, res) => {
  const patch = sanitizeConfig(req.body);
  await store.setConfig(patch);
  await respondWithState(res);
}));

app.get('/api/analysis', wrap(async (_req, res) => {
  const [entries, config] = await Promise.all([store.getEntries(), store.getConfig()]);
  res.json(analyze(entries, config));
}));

// KI-Coach: Bewertung + konkrete Plan-Anpassungen (via Claude).
app.post('/api/coach', wrap(async (req, res) => {
  const [entries, config] = await Promise.all([store.getEntries(), store.getConfig()]);
  const analysis = analyze(entries, config);
  const mealPlan = req.body?.mealPlan || null;
  try {
    const advice = await coachAdvice({ analysis, mealPlan, config });
    res.json(advice);
  } catch (err) {
    console.error('Coach-Fehler:', err.message);
    const status = err.code === 'NO_KEY' ? 400 : 502;
    res.status(status).json({ error: err.message, code: err.code || 'coach_error' });
  }
}));

// ── Statisches Frontend ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Lokal: eigenen Server starten. In der Cloud (Vercel) wird die App als
// Funktion importiert – dort NICHT selbst lauschen.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n  weight-coach läuft →  http://localhost:${PORT}\n`);
  });
}

export default app;

// ── Helfer ───────────────────────────────────────────────────────────────
async function respondWithState(res) {
  const [entries, config] = await Promise.all([store.getEntries(), store.getConfig()]);
  res.json({ backend: store.backend, entries, config, analysis: analyze(entries, config) });
}

function wrap(fn) {
  return (req, res) => fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });
}

function sanitizeEntry(b = {}) {
  return {
    date: (b.date || '').slice(0, 10),
    weight: numOrNull(b.weight),
    musclePct: numOrNull(b.musclePct),
    fatPct: numOrNull(b.fatPct),
    waterPct: numOrNull(b.waterPct),
    calories: numOrNull(b.calories),
    note: (b.note || '').toString().slice(0, 200),
  };
}

function sanitizeConfig(b = {}) {
  const out = {};
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (!(key in b)) continue;
    if (key === 'startDate') out.startDate = b.startDate ? String(b.startDate).slice(0, 10) : null;
    else if (typeof DEFAULT_CONFIG[key] === 'number') { const n = numOrNull(b[key]); if (n != null) out[key] = n; }
    else out[key] = b[key];
  }
  return out;
}

function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : Number(v);
  return Number.isFinite(n) ? n : null;
}
