// Module Google Calendar : OAuth desktop flow + API events
// - OAuth via loopback localhost (pattern recommandé par Google pour apps desktop)
// - Tokens chiffrés avec Electron safeStorage si disponible
// - Refresh automatique géré par googleapis

const { google } = require('googleapis');
const { app, shell, safeStorage } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Identifiants OAuth — embarqués dans l'app (le "secret" desktop n'est PAS confidentiel selon Google's doc)
const CLIENT_ID = '605577026323-u5jrbai8q2ij6b4ti3ll4gf9soikahmo.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

function tokensPath() { return path.join(app.getPath('userData'), 'google-calendar-tokens.bin'); }

// ─── Stockage tokens ─────────────────────────────────────────
function _saveTokens(payload) {
  const json = JSON.stringify(payload);
  let buf;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      buf = safeStorage.encryptString(json);
    } else {
      buf = Buffer.from(json, 'utf8');
    }
  } catch (e) {
    buf = Buffer.from(json, 'utf8');
  }
  fs.writeFileSync(tokensPath(), buf);
}

function _loadTokens() {
  try {
    const p = tokensPath();
    if (!fs.existsSync(p)) return null;
    const buf = fs.readFileSync(p);
    let json;
    try {
      if (safeStorage.isEncryptionAvailable()) {
        json = safeStorage.decryptString(buf);
      } else {
        json = buf.toString('utf8');
      }
    } catch (e) {
      // Fallback : peut-être stocké en clair
      json = buf.toString('utf8');
    }
    return JSON.parse(json);
  } catch (e) {
    console.warn('[gcal] _loadTokens error:', e.message);
    return null;
  }
}

function _clearTokens() {
  try { if (fs.existsSync(tokensPath())) fs.unlinkSync(tokensPath()); } catch (e) {}
}

// ─── OAuth client ─────────────────────────────────────────────
function _makeClient(redirectUri) {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, redirectUri || 'http://127.0.0.1');
}

async function _authedClient() {
  const stored = _loadTokens();
  if (!stored || !stored.refresh_token) return null;
  const client = _makeClient();
  client.setCredentials(stored);
  // Persister les tokens rafraîchis automatiquement
  client.on('tokens', (newTokens) => {
    try {
      const merged = Object.assign({}, _loadTokens() || {}, newTokens);
      _saveTokens(merged);
    } catch (e) {
      console.warn('[gcal] refresh persist failed:', e.message);
    }
  });
  return client;
}

// ─── Flow OAuth complet (interactif) ─────────────────────────
async function connect() {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    const server = http.createServer();
    let done = false;

    server.on('error', (err) => {
      if (!done) { done = true; reject(err); }
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}/`;
      const client = _makeClient(redirectUri);

      const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',
        state: state,
        include_granted_scopes: true
      });

      server.on('request', async (req, res) => {
        try {
          const reqUrl = new URL(req.url, redirectUri);
          if (reqUrl.pathname !== '/') {
            res.writeHead(404); res.end(); return;
          }

          const code = reqUrl.searchParams.get('code');
          const returnedState = reqUrl.searchParams.get('state');
          const oauthErr = reqUrl.searchParams.get('error');

          if (oauthErr) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(_resultPage('Autorisation refusée', 'Vous pouvez fermer cet onglet et réessayer dans TRI-ANGLE.', false));
            done = true; server.close();
            return reject(new Error('OAuth refusé : ' + oauthErr));
          }

          if (returnedState !== state) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(_resultPage('Erreur', 'État OAuth invalide. Fermez cet onglet et réessayez.', false));
            done = true; server.close();
            return reject(new Error('State mismatch'));
          }

          if (!code) {
            res.writeHead(400); res.end('Missing code');
            return;
          }

          const { tokens } = await client.getToken(code);
          _saveTokens(Object.assign({}, tokens, { connectedAt: new Date().toISOString() }));

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(_resultPage('Connecté !', 'TRI-ANGLE est maintenant lié à votre Google Calendar. Vous pouvez fermer cet onglet et retourner dans l\'application.', true));

          done = true; server.close();
          resolve({ ok: true });
        } catch (e) {
          try {
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(_resultPage('Erreur', 'Détails : ' + (e.message || 'inconnue'), false));
          } catch (_) {}
          done = true; server.close();
          reject(e);
        }
      });

      shell.openExternal(authUrl);
    });

    // Timeout 5 min
    setTimeout(() => {
      if (!done) { done = true; try { server.close(); } catch (e) {} reject(new Error('Délai dépassé — fermez l\'onglet du navigateur et réessayez.')); }
    }, 5 * 60 * 1000);
  });
}

function _resultPage(title, msg, ok) {
  const accent = ok ? '#84CC16' : '#EF4444';
  const icon = ok ? '&#9989;' : '&#10060;';
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>TRI-ANGLE Calendar</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,Segoe UI,sans-serif;background:linear-gradient(135deg,#0F172A,#1E293B);color:#fff;padding:30px}
.card{max-width:480px;text-align:center;padding:40px 36px;background:#0F172A;border-radius:14px;border:1px solid #334155;box-shadow:0 20px 60px rgba(0,0,0,.4)}
.brand{font-size:11px;letter-spacing:.25em;color:#06B6D4;text-transform:uppercase;margin-bottom:24px;font-weight:700}
.icon{font-size:56px;margin-bottom:16px;color:${accent}}
h1{margin:0 0 12px;font-size:22px;color:#fff}
p{color:#94A3B8;line-height:1.6;margin:0;font-size:14px}
</style></head>
<body><div class="card">
<div class="brand">&#9650; TRI-ANGLE</div>
<div class="icon">${icon}</div>
<h1>${title}</h1>
<p>${msg}</p>
</div></body></html>`;
}

// ─── API publique (utilisée par main.js via IPC) ──────────────
async function getStatus() {
  const tokens = _loadTokens();
  if (!tokens) return { connected: false };
  return { connected: true, connectedAt: tokens.connectedAt || null };
}

async function disconnect() {
  try {
    const tokens = _loadTokens();
    if (tokens && tokens.refresh_token) {
      const client = _makeClient();
      client.setCredentials(tokens);
      await client.revokeCredentials().catch(() => {});
    }
  } catch (_) {}
  _clearTokens();
  return { ok: true };
}

// rose → 4 (Flamingo), ambre → 5 (Banana)
function _colorId(name) {
  if (name === 'rose') return '4';
  if (name === 'ambre') return '5';
  return undefined;
}

async function createEvent({ title, description, startISO, endISO, color }) {
  const auth = await _authedClient();
  if (!auth) throw new Error('Non connecté à Google Calendar');
  const cal = google.calendar({ version: 'v3', auth });
  const { data } = await cal.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: title || '',
      description: description || '',
      start: { dateTime: startISO },
      end: { dateTime: endISO },
      colorId: _colorId(color),
      reminders: { useDefault: true }
    }
  });
  return { ok: true, eventId: data.id, htmlLink: data.htmlLink };
}

async function updateEvent({ eventId, title, description, startISO, endISO, color }) {
  const auth = await _authedClient();
  if (!auth) throw new Error('Non connecté à Google Calendar');
  const cal = google.calendar({ version: 'v3', auth });
  try {
    const { data } = await cal.events.patch({
      calendarId: 'primary',
      eventId: eventId,
      requestBody: {
        summary: title || '',
        description: description || '',
        start: { dateTime: startISO },
        end: { dateTime: endISO },
        colorId: _colorId(color)
      }
    });
    return { ok: true, eventId: data.id };
  } catch (e) {
    // 404/410 = supprimé manuellement ; 400 = ID legacy invalide (ancien webhook customId)
    if (e.code === 404 || e.code === 410 || e.code === 400) {
      return await createEvent({ title, description, startISO, endISO, color });
    }
    throw e;
  }
}

async function deleteEvent({ eventId }) {
  const auth = await _authedClient();
  if (!auth) throw new Error('Non connecté à Google Calendar');
  const cal = google.calendar({ version: 'v3', auth });
  try {
    await cal.events.delete({ calendarId: 'primary', eventId: eventId });
  } catch (e) {
    // 404/410 = déjà disparu ; 400 = ID legacy invalide
    if (e.code === 404 || e.code === 410 || e.code === 400) return { ok: true, alreadyGone: true };
    throw e;
  }
  return { ok: true };
}

module.exports = { connect, disconnect, getStatus, createEvent, updateEvent, deleteEvent };
