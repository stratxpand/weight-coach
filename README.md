# Weight Coach

Ein privater, adaptiver Gewichts- & Körperkompositions-Tracker.
Du trägst täglich **Gewicht, Muskel-%, Fett-%, Körperwasser-%** (und optional deine
gegessenen Kalorien) ein – die App glättet die Schwankungen, schätzt deinen echten
Erhaltungsbedarf und gibt dir **jede Woche ein angepasstes Kalorienziel**, damit du
deinem Zielverlauf folgst.

Daten liegen in **deinem Google Sheet** (per Service-Account) oder – ohne jede
Einrichtung – lokal in einer JSON-Datei mit Demodaten.

---

## Schnellstart (lokal, ohne Google – zum Ausprobieren)

Voraussetzung: **Node.js ≥ 18**.

```bash
cd weight-coach
npm install
npm start
```

→ http://localhost:5173 öffnen. Die App startet mit **6 Wochen Demodaten**, damit du
sofort alles siehst. Deine echten Werte trägst du über **„Heute eintragen"** ein,
dein Ziel über **⚙ Einstellungen**.

> Ohne konfiguriertes Google Sheet läuft die App automatisch im lokalen Modus.
> Die lokale Datei liegt unter `data/db.json` (per `.gitignore` ausgeschlossen).

---

## Mit Google Sheets verbinden

Einmalige Einrichtung (~10 Min). Du brauchst ein Google-Konto.

### 1. Google Sheet anlegen
Neues leeres Google Sheet erstellen. Die App legt die Tabs **`Eintraege`** und
**`Config`** samt Kopfzeilen selbst an. Die **Sheet-ID** steht in der URL:
`https://docs.google.com/spreadsheets/d/`**`DIESE_LANGE_ID`**`/edit`

### 2. Google-Cloud-Projekt + Sheets-API
1. https://console.cloud.google.com → oben ein **Projekt anlegen** (z. B. „weight-coach").
2. **APIs & Dienste → Bibliothek** → „**Google Sheets API**" suchen → **Aktivieren**.

### 3. Service-Account erstellen
1. **APIs & Dienste → Anmeldedaten → Anmeldedaten erstellen → Dienstkonto**.
2. Namen vergeben (z. B. `weight-coach-bot`) → **Fertig**.
3. Auf das erstellte Dienstkonto klicken → Reiter **Schlüssel** →
   **Schlüssel hinzufügen → Neuen Schlüssel erstellen → JSON** → herunterladen.
4. Die heruntergeladene Datei nach `weight-coach/credentials/service-account.json`
   legen (Ordner `credentials/` anlegen; er ist per `.gitignore` geschützt).

### 4. Sheet für den Service-Account freigeben
Öffne die JSON-Datei und kopiere die **`client_email`** (endet auf
`…@….iam.gserviceaccount.com`). In deinem Google Sheet oben rechts auf
**Teilen** → diese E-Mail als **Bearbeiter** hinzufügen.

> Ohne diese Freigabe darf die App nicht in dein Sheet schreiben – das ist der
> häufigste Fehler.

### 5. `.env` anlegen
```bash
cp .env.example .env
```
Dann in `.env` eintragen:
```
STORAGE=sheets
GOOGLE_SHEET_ID=deine_sheet_id_aus_der_url
GOOGLE_CREDENTIALS_FILE=./credentials/service-account.json
```

### 6. Starten
```bash
npm start
```
Beim ersten Start legt die App die Tabs und Kopfzeilen im Sheet an. Ab jetzt landet
jede Eingabe direkt in deinem Google Sheet – du kannst dort auch manuell Zeilen
ergänzen (Spalten: `Datum, Gewicht, Muskel%, Fett%, Wasser%, Kalorien, Notiz`).

---

## Optionaler Passwortschutz
Willst du die App z. B. im Heimnetz/übers Internet erreichbar machen, setze in `.env`:
```
APP_PASSWORD=deinGeheimes
```
Dann fragt die Web-App beim ersten Aufruf einmal danach.

---

## Online stellen (GitHub + Vercel)

Damit du vom Handy zugreifen kannst. Deine Secrets (`.env`, `credentials/`) bleiben
dank `.gitignore` außen vor – auf Vercel kommen sie als Umgebungsvariablen rein.

1. **Repo zu GitHub pushen**
   ```bash
   git init && git add -A && git commit -m "Weight Coach"
   gh repo create weight-coach --private --source=. --push   # oder manuell auf github.com
   ```
2. **Auf [vercel.com](https://vercel.com)** mit GitHub anmelden → **Add New… → Project**
   → dein `weight-coach`-Repo importieren.
3. **Environment Variables** setzen (Project Settings → Environment Variables):

   | Name | Wert |
   |------|------|
   | `STORAGE` | `sheets` |
   | `GOOGLE_SHEET_ID` | deine Sheet-ID |
   | `GOOGLE_CREDENTIALS_JSON` | **kompletter Inhalt** deiner `service-account.json` (in einer Zeile) |
   | `APP_PASSWORD` | ein selbst gewähltes Passwort (die URL ist öffentlich!) |

4. **Deploy** klicken. Nach ~1 Min bekommst du eine URL wie
   `https://weight-coach-xyz.vercel.app`.
5. Auf dem Handy öffnen → **Teilen → Zum Home-Bildschirm** – dann liegt sie wie eine
   App als Icon auf dem Startbildschirm (PWA).

> Der Service-Account bleibt derselbe – dein Sheet ist bereits für ihn freigegeben.
> Nichts weiter zu tun.

---

## Wie die wöchentliche Anpassung rechnet

Die Logik steckt kommentiert in [`lib/analytics.js`](lib/analytics.js). Kurz:

1. **Glättung:** Tägliche Gewichte schwanken (Wasser, Salz, Darminhalt). Wir bilden
   einen Trend per **gleitender linearer Regression** über ein Fenster (Standard
   14 Tage) auf einem täglich interpolierten Raster → das „Trendgewicht". Der
   Vorteil gegenüber einem EMA: kein Nachlauf, der Rand schätzt Gewicht und Tempo
   unverzerrt.
2. **Erhaltungsbedarf:** Aus der tatsächlichen Trend-Veränderung pro Woche und der
   (gegessenen bzw. vorgegebenen) Kalorienmenge:
   `Erhaltung = Aufnahme − Δkg · kcalPerKg / 7`.
3. **Gesamtbild:** Diese Schätzung wird über die Wochen **gedämpft** (gleitender
   Mittelwert), damit eine einzelne gute/schlechte Woche das Ziel nicht kippt.
4. **Neues Ziel:** `Ziel-kcal = Erhaltung + Ziel-Energiebilanz`. Nimmst du **zu
   schnell** ab, steigt das Ziel; **zu langsam**, sinkt es. Ein Rückstand auf deinen
   geplanten Verlauf wird über mehrere Wochen **sanft aufgeholt** (nicht ruckartig).
5. **Sicherungen:** maximale Änderung pro Woche (Standard ±250 kcal) und eine
   kcal-Untergrenze.

Alle Parameter (Tempo, kcal/kg, Glättungsfenster, Dämpfung, Deckel …) sind unter
**⚙ Einstellungen → Feineinstellungen** editierbar.

---

## Projektstruktur
```
weight-coach/
├─ server.js            Express-Server + JSON-API
├─ lib/
│  ├─ analytics.js      Die adaptive Kalorien-Engine (Kernlogik)
│  ├─ store.js          Datenhaltung: lokal (JSON) oder Google Sheets
│  └─ seed.js           Demodaten für den lokalen Modus
├─ public/
│  ├─ index.html        Dashboard
│  ├─ styles.css        Designsystem (dunkles „Messinstrument")
│  ├─ charts.js         SVG-Charts (Gewicht, Komposition, Kalorien, Gauge)
│  └─ app.js            UI-Logik
├─ .env.example
└─ README.md
```

## API (falls du sie direkt nutzen willst)
| Methode | Pfad | Zweck |
|--------|------|------|
| GET | `/api/state` | Einträge + Config + fertige Analyse |
| POST | `/api/entries` | Tageswert anlegen/aktualisieren |
| DELETE | `/api/entries/:date` | Tageswert löschen |
| GET/PUT | `/api/config` | Ziel & Plan lesen/ändern |
| GET | `/api/analysis` | nur die Analyse |
