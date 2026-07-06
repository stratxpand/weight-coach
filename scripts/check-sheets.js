// Prüft die Google-Sheets-Verbindung und gibt bei Problemen konkrete
// Handlungsanweisungen aus.  Aufruf:  npm run check
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const sheetId = process.env.GOOGLE_SHEET_ID;
const credFile = process.env.GOOGLE_CREDENTIALS_FILE || './credentials/service-account.json';
const line = () => console.log('  ' + '─'.repeat(56));

console.log('\n  Weight Coach · Google-Sheets-Check');
line();

// 1) Service-Account-Datei ----------------------------------------------------
const credPath = path.isAbsolute(credFile) ? credFile : path.join(process.cwd(), credFile);
if (!fs.existsSync(credPath)) {
  fail(`Service-Account-Datei fehlt:\n      ${credPath}`,
    'Lege die aus der Google-Cloud-Konsole heruntergeladene JSON dort ab\n      (README Schritt 3).');
}
let creds;
try { creds = JSON.parse(fs.readFileSync(credPath, 'utf8')); }
catch { fail('Die Service-Account-Datei ist kein gültiges JSON.', 'Lade den Schlüssel erneut als JSON herunter.'); }
console.log('  ✓ Service-Account gefunden');
console.log('      E-Mail :', creds.client_email);
console.log('      Projekt:', creds.project_id);
console.log('\n  ⚑ Diese E-Mail MUSS in deinem Sheet als *Bearbeiter* freigegeben sein:');
console.log('      ' + creds.client_email);

// 2) Sheet-ID -----------------------------------------------------------------
line();
if (!sheetId) {
  fail('GOOGLE_SHEET_ID fehlt in .env',
    'Kopiere die ID aus der Sheet-URL\n      https://docs.google.com/spreadsheets/d/<DIESE_ID>/edit\n      und trage sie in .env ein.');
}
console.log('  ✓ GOOGLE_SHEET_ID gesetzt:', sheetId);

// 3) Verbindung testen --------------------------------------------------------
const { GoogleAuth } = await import('google-auth-library');
const { sheets: sheetsApi } = await import('@googleapis/sheets');
try {
  const auth = new GoogleAuth({ keyFile: credPath, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = sheetsApi({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  line();
  console.log('  ✓ Zugriff erfolgreich');
  console.log('      Sheet :', JSON.stringify(meta.data.properties.title));
  console.log('      Tabs  :', meta.data.sheets.map(s => s.properties.title).join(', ') || '(werden beim ersten Start angelegt)');
  line();
  console.log('  ✔ Alles bereit!  Setze STORAGE=sheets in .env und starte mit  npm start\n');
} catch (err) {
  const msg = (err && err.message) ? err.message : String(err);
  line();
  console.log('  ✗ Verbindung fehlgeschlagen:');
  console.log('      ' + msg.split('\n')[0]);
  if (/403|permission|PERMISSION_DENIED|does not have|caller does not/i.test(msg)) {
    console.log('\n  → Das Sheet ist wahrscheinlich nicht freigegeben.');
    console.log('    Öffne dein Sheet → „Teilen" → füge als *Bearbeiter* hinzu:');
    console.log('    ' + creds.client_email);
  } else if (/404|not found|Requested entity|Unable to parse/i.test(msg)) {
    console.log('\n  → GOOGLE_SHEET_ID passt vermutlich nicht. Prüfe die ID in der Sheet-URL.');
  } else if (/has not been used|disabled|SERVICE_DISABLED|accessNotConfigured/i.test(msg)) {
    console.log('\n  → Die „Google Sheets API" ist im Projekt noch nicht aktiviert.');
    console.log('    Konsole → APIs & Dienste → Bibliothek → „Google Sheets API" → Aktivieren.');
  } else {
    console.log('\n  → Siehe README, Abschnitt „Mit Google Sheets verbinden".');
  }
  console.log('');
  process.exit(1);
}

function fail(what, how) {
  console.log('  ✗ ' + what);
  console.log('\n  → ' + how + '\n');
  process.exit(1);
}
