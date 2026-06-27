// Module Outlook Calendar (Microsoft Graph) — OAuth desktop flow + API events
// - OAuth via PKCE flow (loopback localhost) — pas de client secret nécessaire pour apps natives
// - Tokens chiffrés avec Electron safeStorage
// - Refresh automatique via refresh_token + offline_access scope

const { app, shell, safeStorage } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Client ID Azure (App Registration "TRI-ANGLE Calendar Sync")
// Public client/native, redirect http://localhost, multi-tenant + personal
const CLIENT_ID = '5255805d-6160-4a2d-8eb2-32c59874a517';
const TENANT = 'common'; // multi-tenant + personal
const SCOPES = ['https://graph.microsoft.com/Calendars.ReadWrite', 'offline_access', 'User.Read'];
const AUTH_BASE = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TZ = 'America/Montreal';

function tokensPath() { return path.join(app.getPath('userData'), 'outlook-calendar-tokens.bin'); }

// ─── Stockage tokens (chiffré via safeStorage) ────────────────
function _saveTokens(payload) {
  const json = JSON.stringify(payload);
  let buf;
  try {
    buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8');
  } catch (e) { buf = Buffer.from(json, 'utf8'); }
  fs.writeFileSync(tokensPath(), buf);
}

function _loadTokens() {
  try {
    const p = tokensPath();
    if (!fs.existsSync(p)) return null;
    const buf = fs.readFileSync(p);
    let json;
    try {
      json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    } catch (e) { json = buf.toString('utf8'); }
    return JSON.parse(json);
  } catch (e) {
    console.warn('[outlook] _loadTokens error:', e.message);
    return null;
  }
}

function _clearTokens() {
  try { if (fs.existsSync(tokensPath())) fs.unlinkSync(tokensPath()); } catch (e) {}
}

// ─── PKCE helpers ─────────────────────────────────────────────
function _base64UrlEncode(buf) {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function _makePkce() {
  const verifier = _base64UrlEncode(crypto.randomBytes(32));
  const challenge = _base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ─── Token exchange + refresh ─────────────────────────────────
async function _exchangeCodeForTokens(code, redirectUri, codeVerifier) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: SCOPES.join(' '),
    code: code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier
  });
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token exchange failed: ${data.error || res.status} ${data.error_description || ''}`);
  // data : { access_token, refresh_token, expires_in (sec), token_type, scope }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in * 1000) - 60000 // 60s safety
  };
}

async function _refreshTokens(refreshToken) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: SCOPES.join(' '),
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed: ${data.error || res.status} ${data.error_description || ''}`);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken, // Microsoft renvoie un nouveau parfois
    expires_at: Date.now() + (data.expires_in * 1000) - 60000
  };
}

async function _getValidAccessToken() {
  const stored = _loadTokens();
  if (!stored || !stored.refresh_token) return null;
  if (stored.access_token && stored.expires_at && Date.now() < stored.expires_at) {
    return stored.access_token;
  }
  // Refresh
  try {
    const fresh = await _refreshTokens(stored.refresh_token);
    const merged = Object.assign({}, stored, fresh);
    _saveTokens(merged);
    return fresh.access_token;
  } catch (e) {
    console.warn('[outlook] refresh failed:', e.message);
    return null;
  }
}

// ─── Flow OAuth complet (interactif via loopback) ─────────────
async function connect() {
  if (CLIENT_ID.startsWith('__')) {
    throw new Error('CLIENT_ID Azure non configuré. Voir outlook-calendar.js.');
  }
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    const pkce = _makePkce();
    const server = http.createServer();
    let done = false;

    server.on('error', (err) => { if (!done) { done = true; reject(err); } });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://localhost:${port}/`;
      const authParams = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: SCOPES.join(' '),
        state: state,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account'
      });
      const authUrl = `${AUTH_BASE}/authorize?${authParams.toString()}`;

      server.on('request', async (req, res) => {
        try {
          const reqUrl = new URL(req.url, redirectUri);
          if (reqUrl.pathname !== '/') { res.writeHead(404); res.end(); return; }

          const code = reqUrl.searchParams.get('code');
          const returnedState = reqUrl.searchParams.get('state');
          const oauthErr = reqUrl.searchParams.get('error');
          const oauthErrDesc = reqUrl.searchParams.get('error_description');

          if (oauthErr) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(_resultPage('Autorisation refusée', oauthErrDesc || 'Vous pouvez fermer cet onglet et réessayer.', false));
            done = true; server.close();
            return reject(new Error('OAuth refusé : ' + oauthErr));
          }
          if (returnedState !== state) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(_resultPage('Erreur', 'État OAuth invalide. Fermez et réessayez.', false));
            done = true; server.close();
            return reject(new Error('State mismatch'));
          }
          if (!code) { res.writeHead(400); res.end('Missing code'); return; }

          const tokens = await _exchangeCodeForTokens(code, redirectUri, pkce.verifier);
          _saveTokens(Object.assign({}, tokens, { connectedAt: new Date().toISOString() }));

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(_resultPage('Connecté !', 'TRI-ANGLE est maintenant lié à votre Outlook Calendar. Vous pouvez fermer cet onglet et retourner dans l\'application.', true));

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

    setTimeout(() => {
      if (!done) { done = true; try { server.close(); } catch (e) {} reject(new Error('Délai dépassé — fermez l\'onglet du navigateur et réessayez.')); }
    }, 5 * 60 * 1000);
  });
}

function _resultPage(title, msg, ok) {
  const accent = ok ? '#0EA5E9' : '#EF4444';
  const icon = ok ? '&#9989;' : '&#10060;';
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>TRI-ANGLE Outlook</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,Segoe UI,sans-serif;background:linear-gradient(135deg,#0F172A,#1E293B);color:#fff;padding:30px}
.card{max-width:480px;text-align:center;padding:40px 36px;background:#0F172A;border-radius:14px;border:1px solid #334155;box-shadow:0 20px 60px rgba(0,0,0,.4)}
.brand{font-size:11px;letter-spacing:.25em;color:#0EA5E9;text-transform:uppercase;margin-bottom:24px;font-weight:700}
.icon{font-size:56px;margin-bottom:16px;color:${accent}}
h1{margin:0 0 12px;font-size:22px;color:#fff}
p{color:#94A3B8;line-height:1.6;margin:0;font-size:14px}
</style></head>
<body><div class="card">
<div class="brand">&#9650; TRI-ANGLE — OUTLOOK</div>
<div class="icon">${icon}</div>
<h1>${title}</h1>
<p>${msg}</p>
</div></body></html>`;
}

// ─── API publique ─────────────────────────────────────────────
async function getStatus() {
  const tokens = _loadTokens();
  if (!tokens) return { connected: false };
  return { connected: true, connectedAt: tokens.connectedAt || null };
}

async function disconnect() {
  _clearTokens();
  return { ok: true };
}

// Catégories Outlook pour couleurs (création auto si nécessaire — simplifié : on n'utilise pas)
function _categoriesFor(color) {
  if (!color) return [];
  if (color === 'rose') return ['TRI-ANGLE Rose'];
  if (color === 'ambre') return ['TRI-ANGLE Ambre'];
  return [];
}

async function _graphCall(method, pathOrUrl, body) {
  const token = await _getValidAccessToken();
  if (!token) throw new Error('Non connecté à Outlook');
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : (GRAPH_BASE + pathOrUrl);
  const opts = {
    method: method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (res.status === 204) return { ok: true }; // No Content (DELETE)
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `Graph ${res.status}`);
    err.code = res.status;
    err.graphCode = data.error && data.error.code;
    throw err;
  }
  return data;
}

async function createEvent({ title, description, startISO, endISO, color, location }) {
  const body = {
    subject: title || '',
    body: { contentType: 'Text', content: description || '' },
    start: { dateTime: _stripZ(startISO), timeZone: TZ },
    end: { dateTime: _stripZ(endISO), timeZone: TZ },
    categories: _categoriesFor(color)
  };
  if (location) body.location = { displayName: location };
  const data = await _graphCall('POST', '/me/events', body);
  return { ok: true, eventId: data.id, htmlLink: data.webLink };
}

async function updateEvent({ eventId, title, description, startISO, endISO, color, location }) {
  const body = {
    subject: title || '',
    body: { contentType: 'Text', content: description || '' },
    start: { dateTime: _stripZ(startISO), timeZone: TZ },
    end: { dateTime: _stripZ(endISO), timeZone: TZ },
    categories: _categoriesFor(color)
  };
  if (location) body.location = { displayName: location };
  try {
    const data = await _graphCall('PATCH', `/me/events/${encodeURIComponent(eventId)}`, body);
    return { ok: true, eventId: data.id };
  } catch (e) {
    // 404 = supprimé manuellement → fallback create
    if (e.code === 404 || e.code === 410) {
      return await createEvent({ title, description, startISO, endISO, color, location });
    }
    throw e;
  }
}

async function deleteEvent({ eventId }) {
  try {
    await _graphCall('DELETE', `/me/events/${encodeURIComponent(eventId)}`);
  } catch (e) {
    if (e.code === 404 || e.code === 410) return { ok: true, alreadyGone: true };
    throw e;
  }
  return { ok: true };
}

function _stripZ(iso) {
  if (!iso) return iso;
  // Graph veut un dateTime sans suffixe Z (avec timezone séparée)
  return String(iso).replace(/Z$/, '').replace(/([+-])\d{2}:\d{2}$/, '');
}

module.exports = { connect, disconnect, getStatus, createEvent, updateEvent, deleteEvent };
