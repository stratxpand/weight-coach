// Vercel-Serverless-Einstiegspunkt.
// Die komplette Express-App wird als Handler durchgereicht; alle Routen
// (Frontend + /api) laufen darüber. Lokal wird stattdessen server.js direkt
// gestartet (npm start).
export { default } from '../server.js';
