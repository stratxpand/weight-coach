// ─────────────────────────────────────────────────────────────────────────
//  store.js — Datenhaltung mit zwei austauschbaren Backends
//
//   • LocalStore  – JSON-Datei unter ./data/db.json (Standard/Fallback,
//                   startet mit Demodaten)
//   • SheetsStore – Google Sheets über einen Service-Account
//
//  Beide bieten dieselbe Schnittstelle:
//     init(), getEntries(), upsertEntry(entry), deleteEntry(date),
//     getConfig(), setConfig(patch)
// ─────────────────────────────────────────────────────────────────────────
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from './analytics.js';
import { generateSeed } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Spalten-/Tab-Namen im Google Sheet
const ENTRIES_TAB = 'Eintraege';
const CONFIG_TAB = 'Config';
const ENTRY_HEADERS = ['Datum', 'Gewicht', 'Muskel%', 'Fett%', 'Wasser%', 'Kalorien', 'Notiz'];
const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

// Reihenfolge/Parsing der Eintrags-Felder
const entryToRow = (e) => [
  e.date, num(e.weight), num(e.musclePct), num(e.fatPct), num(e.waterPct), num(e.calories), e.note ?? '',
];
const rowToEntry = (r) => ({
  date: r[0],
  weight: parse(r[1]), musclePct: parse(r[2]), fatPct: parse(r[3]),
  waterPct: parse(r[4]), calories: parse(r[5]), note: r[6] ?? '',
});

// Liest die Service-Account-Zugangsdaten – bevorzugt aus einer Umgebungsvariable
// (für Cloud-Hosting wie Vercel), sonst aus der lokalen JSON-Datei.
export function resolveCredentials(env = process.env) {
  if (env.GOOGLE_CREDENTIALS_JSON) return { credentials: JSON.parse(env.GOOGLE_CREDENTIALS_JSON) };
  if (env.GOOGLE_CREDENTIALS_B64) return { credentials: JSON.parse(Buffer.from(env.GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8')) };
  return { keyFile: env.GOOGLE_CREDENTIALS_FILE || './credentials/service-account.json' };
}

// ── Fabrik ────────────────────────────────────────────────────────────────
export async function createStore(env = process.env) {
  const wantSheets = (env.STORAGE || '').toLowerCase() === 'sheets' && env.GOOGLE_SHEET_ID;
  if (wantSheets) {
    try {
      const store = new SheetsStore(env.GOOGLE_SHEET_ID, resolveCredentials(env));
      await store.init();
      console.log(`✓ Storage: Google Sheets (${env.GOOGLE_SHEET_ID})`);
      return store;
    } catch (err) {
      console.error('✗ Google Sheets nicht verfügbar:', err.message);
      // In der Cloud (read-only Dateisystem) kein lokaler Fallback – Fehler zeigen.
      if (env.VERCEL || env.STORAGE?.toLowerCase() === 'sheets') throw err;
    }
  }
  const store = new LocalStore();
  await store.init();
  console.log(`✓ Storage: lokal (${store.file})`);
  return store;
}

// ── Lokaler JSON-Store ─────────────────────────────────────────────────────
export class LocalStore {
  constructor(file = path.join(ROOT, 'data', 'db.json')) {
    this.file = file;
    this.db = null;
    this.backend = 'local';
  }
  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      this.db = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      this.db = generateSeed();           // erster Start → Demodaten
      await this._flush();
    }
    if (!this.db.config) this.db.config = { ...DEFAULT_CONFIG };
    if (!Array.isArray(this.db.entries)) this.db.entries = [];
  }
  async _flush() { await fs.writeFile(this.file, JSON.stringify(this.db, null, 2)); }

  async getEntries() {
    return [...this.db.entries].sort((a, b) => a.date.localeCompare(b.date));
  }
  async upsertEntry(entry) {
    const i = this.db.entries.findIndex((e) => e.date === entry.date);
    if (i >= 0) this.db.entries[i] = { ...this.db.entries[i], ...entry };
    else this.db.entries.push(entry);
    await this._flush();
    return entry;
  }
  async deleteEntry(date) {
    this.db.entries = this.db.entries.filter((e) => e.date !== date);
    await this._flush();
  }
  async getConfig() { return { ...DEFAULT_CONFIG, ...this.db.config }; }
  async setConfig(patch) {
    this.db.config = { ...DEFAULT_CONFIG, ...this.db.config, ...patch };
    await this._flush();
    return this.db.config;
  }
}

// ── Google-Sheets-Store ────────────────────────────────────────────────────
export class SheetsStore {
  // auth: { credentials: {...} }  ODER  { keyFile: '…/service-account.json' }
  constructor(sheetId, auth) {
    this.sheetId = sheetId;
    this.auth = auth || {};
    this.sheets = null;
    this.backend = 'sheets';
  }

  async init() {
    // Schlanke Einzel-API + Auth-Lib erst hier laden (kleiner als das volle
    // "googleapis"-Paket → schnellere Kaltstarts in der Cloud).
    const { GoogleAuth } = await import('google-auth-library');
    const { sheets } = await import('@googleapis/sheets');

    const authOpts = { scopes: ['https://www.googleapis.com/auth/spreadsheets'] };
    if (this.auth.credentials) authOpts.credentials = this.auth.credentials;
    else authOpts.keyFile = path.isAbsolute(this.auth.keyFile) ? this.auth.keyFile : path.join(ROOT, this.auth.keyFile);
    this.sheets = sheets({ version: 'v4', auth: new GoogleAuth(authOpts) });

    // Vorhandene Tabs prüfen und fehlende anlegen.
    const meta = await this.sheets.spreadsheets.get({ spreadsheetId: this.sheetId });
    const tabs = new Set(meta.data.sheets.map((s) => s.properties.title));
    const hadEntries = tabs.has(ENTRIES_TAB);
    const hadConfig = tabs.has(CONFIG_TAB);

    const requests = [];
    if (!hadEntries) requests.push({ addSheet: { properties: { title: ENTRIES_TAB } } });
    if (!hadConfig) requests.push({ addSheet: { properties: { title: CONFIG_TAB } } });
    if (requests.length) {
      await this.sheets.spreadsheets.batchUpdate({ spreadsheetId: this.sheetId, requestBody: { requests } });
    }

    // Kopfzeile bzw. Default-Config nur beim erstmaligen Anlegen schreiben
    // (spart Roundtrips bei jedem Kaltstart).
    if (!hadEntries) await this._update(`${ENTRIES_TAB}!A1:G1`, [ENTRY_HEADERS]);
    if (!hadConfig) {
      const rows = [['Schlüssel', 'Wert'], ...CONFIG_KEYS.map((k) => [k, DEFAULT_CONFIG[k] ?? ''])];
      await this._update(`${CONFIG_TAB}!A1:B${rows.length}`, rows);
    }
  }

  async _get(range) {
    const res = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.sheetId, range });
    return res.data.values || [];
  }
  async _update(range, values) {
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.sheetId, range, valueInputOption: 'RAW', requestBody: { values },
    });
  }
  async _append(values) {
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.sheetId, range: `${ENTRIES_TAB}!A2`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values },
    });
  }

  async getEntries() {
    const rows = await this._get(`${ENTRIES_TAB}!A2:G`);
    return rows.filter((r) => r[0]).map(rowToEntry).sort((a, b) => a.date.localeCompare(b.date));
  }

  async upsertEntry(entry) {
    const rows = await this._get(`${ENTRIES_TAB}!A2:G`);
    const idx = rows.findIndex((r) => r[0] === entry.date);
    if (idx >= 0) {
      const merged = { ...rowToEntry(rows[idx]), ...entry };
      await this._update(`${ENTRIES_TAB}!A${idx + 2}:G${idx + 2}`, [entryToRow(merged)]);
    } else {
      await this._append([entryToRow(entry)]);
    }
    return entry;
  }

  async deleteEntry(date) {
    const rows = await this._get(`${ENTRIES_TAB}!A2:G`);
    const idx = rows.findIndex((r) => r[0] === date);
    if (idx < 0) return;
    // Zeile leeren (einfacher & robust gegenüber Zeilen-IDs)
    await this._update(`${ENTRIES_TAB}!A${idx + 2}:G${idx + 2}`, [['', '', '', '', '', '', '']]);
  }

  async getConfig() {
    const rows = await this._get(`${CONFIG_TAB}!A2:B`);
    const obj = {};
    for (const [k, v] of rows) {
      if (!k) continue;
      obj[k] = typeof DEFAULT_CONFIG[k] === 'number' ? parse(v) : v;
    }
    return { ...DEFAULT_CONFIG, ...obj };
  }

  async setConfig(patch) {
    const current = await this.getConfig();
    const next = { ...current, ...patch };
    const rows = [['Schlüssel', 'Wert'], ...CONFIG_KEYS.map((k) => [k, next[k] ?? ''])];
    await this._update(`${CONFIG_TAB}!A1:B${rows.length}`, rows);
    return next;
  }
}

// ── Helfer ─────────────────────────────────────────────────────────────────
function num(v) { return v == null || v === '' ? '' : Number(v); }
function parse(v) {
  if (v === '' || v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : Number(v);
  return Number.isFinite(n) ? n : null;
}
