// GET /api/admin (rewritten from /admin)
// Sert la page HTML du dashboard d'administration des licences TRI-ANGLE.
// Protégée par Basic Auth — le navigateur affiche son prompt natif au chargement.

const { requireAuth } = require('../../lib/auth');

const HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TRI-ANGLE · Administration des licences</title>
<style>
  *,*::before,*::after { box-sizing: border-box; }
  html,body { margin:0; padding:0; height:100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #F8FAFC;
    color: #0F172A;
    font-size: 14px;
    line-height: 1.5;
  }

  /* Header */
  header.topbar {
    background: #0F172A;
    color: #fff;
    padding: 16px 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-shadow: 0 1px 0 rgba(255,255,255,0.05);
  }
  .brand { display:flex; align-items:center; gap:12px; }
  .brand-logo {
    width: 32px; height: 32px;
    background: linear-gradient(135deg, #06B6D4, #84CC16, #F59E0B);
    clip-path: polygon(50% 0%, 0% 100%, 100% 100%);
  }
  .brand-name { font-weight: 700; font-size: 18px; letter-spacing: 0.5px; }
  .brand-tag { font-style: italic; font-size: 13px; color: #94A3B8; margin-left: 4px; }
  .header-actions { display:flex; align-items:center; gap:12px; }
  .badge-server { font-size:12px; color:#64748B; }

  /* Main */
  main { padding: 24px 32px 48px; max-width: 1280px; margin: 0 auto; }

  /* Stats */
  .stats { display:grid; grid-template-columns: repeat(5, 1fr); gap:12px; margin-bottom:24px; }
  .stat {
    border: 1px solid #E2E8F0;
    border-radius: 8px;
    padding: 16px;
    background: #fff;
  }
  .stat-label { font-size:11px; text-transform:uppercase; letter-spacing:0.8px; color:#64748B; font-weight:600; }
  .stat-value { font-size:28px; font-weight:700; margin-top:6px; }
  .stat.active .stat-value { color:#84CC16; }
  .stat.expiring .stat-value { color:#F59E0B; }
  .stat.expired .stat-value { color:#EF4444; }
  .stat.revoked .stat-value { color:#64748B; }
  .stat.total .stat-value { color:#0F172A; }

  /* Action bar */
  .actionbar { display:flex; gap:12px; margin-bottom:16px; align-items:center; }
  .btn {
    border: none;
    border-radius: 6px;
    padding: 8px 14px;
    font-size:13px;
    font-weight:600;
    cursor:pointer;
    display:inline-flex;
    align-items:center;
    gap:6px;
    transition: opacity 0.15s, transform 0.05s;
  }
  .btn:active { transform: translateY(1px); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background:#0EA5E9; color:#fff; }
  .btn-primary:hover:not(:disabled) { background:#0284C7; }
  .btn-ghost { background:transparent; color:#475569; border:1px solid #CBD5E1; }
  .btn-ghost:hover:not(:disabled) { background:#F1F5F9; }
  .btn-cyan { background:#06B6D4; color:#fff; }
  .btn-cyan:hover:not(:disabled) { background:#0891B2; }
  .btn-red { background:#EF4444; color:#fff; }
  .btn-red:hover:not(:disabled) { background:#DC2626; }
  .btn-sm { padding: 4px 10px; font-size: 12px; }

  .search {
    flex: 1;
    max-width: 320px;
    padding: 8px 12px;
    border: 1px solid #CBD5E1;
    border-radius: 6px;
    font-size: 13px;
    outline: none;
  }
  .search:focus { border-color: #0EA5E9; box-shadow: 0 0 0 3px rgba(14,165,233,0.15); }

  /* Table */
  .card {
    background: #fff;
    border: 1px solid #E2E8F0;
    border-radius: 8px;
    overflow: hidden;
  }
  table { width:100%; border-collapse: collapse; }
  thead th {
    background: #F1F5F9;
    color: #475569;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    text-align: left;
    padding: 10px 16px;
    font-weight: 700;
    border-bottom: 1px solid #E2E8F0;
  }
  tbody td { padding: 12px 16px; border-bottom: 1px solid #F1F5F9; vertical-align: middle; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: #F8FAFC; }

  .key-cell { font-family: "SF Mono", Consolas, monospace; font-size: 12px; font-weight: 600; }
  .key-cell .copy-btn {
    margin-left: 6px;
    background:none; border:none; cursor:pointer; color:#64748B; font-size:12px;
    padding: 2px 6px; border-radius: 4px;
  }
  .key-cell .copy-btn:hover { background:#E2E8F0; color:#0F172A; }

  .status {
    display:inline-block;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 3px 8px;
    border-radius: 12px;
  }
  .status-active { background: rgba(132,204,22,0.15); color: #4D7C0F; }
  .status-expiring { background: rgba(245,158,11,0.15); color: #92400E; }
  .status-expired { background: rgba(239,68,68,0.15); color: #991B1B; }
  .status-revoked { background: #E2E8F0; color: #475569; }

  .row-actions { display:flex; gap:6px; justify-content:flex-end; }

  /* Modal */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(15,23,42,0.6);
    display: none; align-items: center; justify-content: center;
    z-index: 100;
  }
  .modal-overlay.on { display: flex; }
  .modal {
    background: #fff;
    border-radius: 10px;
    padding: 24px;
    width: 100%; max-width: 480px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
  }
  .modal h2 { margin: 0 0 16px; font-size: 18px; }
  .modal p { margin: 0 0 16px; color: #475569; font-size: 13px; }
  .form-group { margin-bottom: 14px; }
  .form-group label { display:block; font-size:12px; font-weight:600; color:#475569; margin-bottom:4px; text-transform:uppercase; letter-spacing:0.4px; }
  .form-group input, .form-group select {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid #CBD5E1;
    border-radius: 6px;
    font-size: 14px;
    outline: none;
    font-family: inherit;
  }
  .form-group input:focus, .form-group select:focus {
    border-color: #0EA5E9;
    box-shadow: 0 0 0 3px rgba(14,165,233,0.15);
  }
  .modal-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:8px; }
  .modal-key-result {
    background:#0F172A;
    color:#84CC16;
    padding: 16px;
    border-radius:6px;
    font-family: "SF Mono", Consolas, monospace;
    font-size: 16px;
    font-weight: 700;
    text-align:center;
    letter-spacing: 1px;
    margin: 16px 0;
  }

  /* Toast */
  #toast {
    position: fixed; bottom: 24px; right: 24px;
    background: #0F172A; color: #fff;
    padding: 12px 20px; border-radius: 6px;
    font-size: 13px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.2);
    opacity: 0; transform: translateY(10px);
    transition: opacity 0.2s, transform 0.2s;
    pointer-events: none;
    z-index: 200;
    max-width: 360px;
  }
  #toast.on { opacity: 1; transform: translateY(0); }
  #toast.error { background:#991B1B; }
  #toast.success { background:#15803D; }

  /* Loading */
  .loading { text-align:center; padding: 60px 20px; color:#64748B; }

  /* Empty */
  .empty { text-align:center; padding: 60px 20px; color:#64748B; }

  @media (max-width: 720px) {
    .stats { grid-template-columns: repeat(2, 1fr); }
    header.topbar { padding: 12px 16px; }
    main { padding: 16px; }
    .actionbar { flex-wrap: wrap; }
    .search { max-width: 100%; }
  }
</style>
</head>
<body>

<header class="topbar">
  <div class="brand">
    <div class="brand-logo"></div>
    <div>
      <span class="brand-name">TRI-ANGLE</span>
      <span class="brand-tag">Administration des licences</span>
    </div>
  </div>
  <div class="header-actions">
    <span class="badge-server" id="server-time"></span>
  </div>
</header>

<main>
  <section class="stats">
    <div class="stat total"><div class="stat-label">Total</div><div class="stat-value" id="stat-total">—</div></div>
    <div class="stat active"><div class="stat-label">Actives</div><div class="stat-value" id="stat-active">—</div></div>
    <div class="stat expiring"><div class="stat-label">Expirent &lt;30j</div><div class="stat-value" id="stat-expiring">—</div></div>
    <div class="stat expired"><div class="stat-label">Expirées</div><div class="stat-value" id="stat-expired">—</div></div>
    <div class="stat revoked"><div class="stat-label">Révoquées</div><div class="stat-value" id="stat-revoked">—</div></div>
  </section>

  <div class="actionbar">
    <button class="btn btn-primary" id="btn-new">+ Nouvelle clé</button>
    <input type="text" class="search" id="search" placeholder="Rechercher par nom ou clé…">
    <button class="btn btn-ghost" id="btn-refresh">⟳ Rafraîchir</button>
  </div>

  <div class="card">
    <div id="table-container">
      <div class="loading">Chargement…</div>
    </div>
  </div>
</main>

<!-- Modal: Create -->
<div class="modal-overlay" id="modal-create">
  <div class="modal">
    <h2>Nouvelle clé de licence</h2>
    <div class="form-group">
      <label>Nom du client</label>
      <input type="text" id="create-name" placeholder="ex. Sophie Tremblay">
    </div>
    <div class="form-group">
      <label>Plan</label>
      <select id="create-plan">
        <option value="trial">Essai (free_trial)</option>
        <option value="paid">Payé</option>
      </select>
    </div>
    <div class="form-group">
      <label>Durée (mois)</label>
      <input type="number" id="create-months" min="1" max="120" value="3">
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-close>Annuler</button>
      <button class="btn btn-primary" id="create-submit">Générer</button>
    </div>
  </div>
</div>

<!-- Modal: Create Result -->
<div class="modal-overlay" id="modal-create-result">
  <div class="modal">
    <h2>Clé générée</h2>
    <p>Envoie cette clé au client par courriel. <strong>Elle est immédiatement active.</strong></p>
    <div class="modal-key-result" id="result-key"></div>
    <p id="result-details" style="font-size:12px; color:#64748B; text-align:center;"></p>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="result-copy">Copier</button>
      <button class="btn btn-primary" data-close>Fermer</button>
    </div>
  </div>
</div>

<!-- Modal: Renew -->
<div class="modal-overlay" id="modal-renew">
  <div class="modal">
    <h2>Renouveler la clé</h2>
    <p id="renew-context"></p>
    <div class="form-group">
      <label>Mois à ajouter</label>
      <input type="number" id="renew-months" min="1" max="120" value="12">
    </div>
    <p style="font-size:12px; color:#64748B;" id="renew-hint"></p>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-close>Annuler</button>
      <button class="btn btn-cyan" id="renew-submit">Renouveler</button>
    </div>
  </div>
</div>

<!-- Modal: Revoke -->
<div class="modal-overlay" id="modal-revoke">
  <div class="modal">
    <h2>Révoquer la clé ?</h2>
    <p id="revoke-context"></p>
    <p style="font-size:12px; color:#64748B;">Le client perdra l'accès au prochain check serveur (jusqu'à 24h selon son cache local). Tu pourras la réactiver plus tard via "Renouveler".</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-close>Annuler</button>
      <button class="btn btn-red" id="revoke-submit">Révoquer</button>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
const STATUS_LABELS = { active:'ACTIVE', expiring:'EXPIRE BIENTÔT', expired:'EXPIRÉE', revoked:'RÉVOQUÉE' };
const STATUS_ORDER  = { expired:0, expiring:1, active:2, revoked:3 };
let CURRENT_DATA = {};
let RENEW_TARGET = null;
let REVOKE_TARGET = null;

function $(sel) { return document.querySelector(sel); }

function toast(msg, kind) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = (kind || '');
  t.classList.add('on');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('on'), 3000);
}

function openModal(id) {
  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('on'));
  $('#' + id).classList.add('on');
}
function closeModals() { document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('on')); }

document.addEventListener('click', e => {
  if (e.target.matches('[data-close]') || (e.target.classList.contains('modal-overlay'))) {
    closeModals();
  }
});

async function api(path, opts) {
  opts = opts || {};
  const headers = opts.headers || {};
  if (opts.body && typeof opts.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  opts.headers = headers;
  opts.credentials = 'same-origin';
  const r = await fetch(path, opts);
  if (r.status === 401) {
    // Auth expired or invalid — force re-prompt
    window.location.reload();
    return null;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Erreur ' + r.status);
  return data;
}

function renderTable(keys, filter) {
  const rows = Object.entries(keys).map(([k, e]) => ({ key:k, ...e }));
  rows.sort((a, b) => {
    if (STATUS_ORDER[a.status] !== STATUS_ORDER[b.status]) return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    return a.daysRemaining - b.daysRemaining;
  });

  const q = (filter || '').toLowerCase().trim();
  const visible = q ? rows.filter(r => (r.name || '').toLowerCase().includes(q) || r.key.toLowerCase().includes(q)) : rows;

  if (visible.length === 0) {
    $('#table-container').innerHTML = '<div class="empty">' + (q ? 'Aucun résultat' : 'Aucune clé. Clique "+ Nouvelle clé" pour commencer.') + '</div>';
    return;
  }

  let html = '<table><thead><tr><th>Clé</th><th>Nom</th><th>Plan</th><th>Expire</th><th>Jours</th><th>Statut</th><th style="text-align:right">Actions</th></tr></thead><tbody>';
  for (const r of visible) {
    const days = r.status === 'expired' ? 'expirée' : (r.daysRemaining + ' j');
    html += '<tr>'
      + '<td class="key-cell">' + r.key + '<button class="copy-btn" data-copy="' + r.key + '" title="Copier">⧉</button></td>'
      + '<td>' + escapeHtml(r.name || '—') + '</td>'
      + '<td>' + r.plan + '</td>'
      + '<td>' + r.expires + '</td>'
      + '<td>' + days + '</td>'
      + '<td><span class="status status-' + r.status + '">' + STATUS_LABELS[r.status] + '</span></td>'
      + '<td><div class="row-actions">'
      + '<button class="btn btn-cyan btn-sm" data-renew="' + r.key + '">' + (r.status === 'revoked' ? 'Réactiver' : 'Renouveler') + '</button>'
      + (r.status !== 'revoked' ? '<button class="btn btn-red btn-sm" data-revoke="' + r.key + '">Révoquer</button>' : '')
      + '</div></td>'
      + '</tr>';
  }
  html += '</tbody></table>';
  $('#table-container').innerHTML = html;

  $('#table-container').querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.copy);
      toast('Clé copiée : ' + btn.dataset.copy, 'success');
    });
  });
  $('#table-container').querySelectorAll('[data-renew]').forEach(btn => {
    btn.addEventListener('click', () => openRenew(btn.dataset.renew));
  });
  $('#table-container').querySelectorAll('[data-revoke]').forEach(btn => {
    btn.addEventListener('click', () => openRevoke(btn.dataset.revoke));
  });
}

function renderStats(keys) {
  const counts = { active:0, expiring:0, expired:0, revoked:0 };
  for (const e of Object.values(keys)) counts[e.status] = (counts[e.status] || 0) + 1;
  $('#stat-total').textContent = Object.keys(keys).length;
  $('#stat-active').textContent = counts.active;
  $('#stat-expiring').textContent = counts.expiring;
  $('#stat-expired').textContent = counts.expired;
  $('#stat-revoked').textContent = counts.revoked;
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function refresh() {
  $('#table-container').innerHTML = '<div class="loading">Chargement…</div>';
  try {
    const data = await api('/api/admin/list');
    if (!data) return;
    CURRENT_DATA = data.keys;
    $('#server-time').textContent = 'KV · ' + new Date(data.serverTime).toLocaleString('fr-CA');
    renderStats(data.keys);
    renderTable(data.keys, $('#search').value);
  } catch (err) {
    $('#table-container').innerHTML = '<div class="empty" style="color:#991B1B">Erreur : ' + escapeHtml(err.message) + '</div>';
  }
}

// Create
$('#btn-new').addEventListener('click', () => {
  $('#create-name').value = '';
  $('#create-plan').value = 'trial';
  $('#create-months').value = 3;
  openModal('modal-create');
  setTimeout(() => $('#create-name').focus(), 50);
});
$('#create-plan').addEventListener('change', () => {
  $('#create-months').value = $('#create-plan').value === 'trial' ? 3 : 12;
});
$('#create-submit').addEventListener('click', async () => {
  const btn = $('#create-submit'); btn.disabled = true;
  try {
    const data = await api('/api/admin/create', {
      method: 'POST',
      body: { name: $('#create-name').value, plan: $('#create-plan').value, months: parseInt($('#create-months').value) }
    });
    if (!data) return;
    $('#result-key').textContent = data.key;
    $('#result-details').textContent = data.entry.name + ' · ' + data.entry.plan + ' · expire ' + data.entry.expires;
    openModal('modal-create-result');
    refresh();
    toast('Clé créée : ' + data.key, 'success');
  } catch (err) {
    toast('Erreur : ' + err.message, 'error');
  } finally { btn.disabled = false; }
});
$('#result-copy').addEventListener('click', () => {
  const k = $('#result-key').textContent;
  navigator.clipboard.writeText(k);
  toast('Copié : ' + k, 'success');
});

// Renew
function openRenew(key) {
  const e = CURRENT_DATA[key]; if (!e) return;
  RENEW_TARGET = key;
  $('#renew-context').innerHTML = '<strong>' + escapeHtml(e.name || '—') + '</strong> · ' + key + '<br>Expire actuellement : ' + e.expires + (e.revoked ? ' (révoquée, sera réactivée)' : '');
  $('#renew-months').value = 12;
  $('#renew-hint').textContent = e.status === 'expired' ? 'La clé est expirée — le compteur repart d\\'aujourd\\'hui.' : '';
  openModal('modal-renew');
}
$('#renew-submit').addEventListener('click', async () => {
  const btn = $('#renew-submit'); btn.disabled = true;
  try {
    const data = await api('/api/admin/renew', {
      method: 'POST',
      body: { key: RENEW_TARGET, months: parseInt($('#renew-months').value) }
    });
    if (!data) return;
    closeModals();
    refresh();
    toast('Renouvelée : ' + data.key + ' jusqu\\'au ' + data.entry.expires, 'success');
  } catch (err) {
    toast('Erreur : ' + err.message, 'error');
  } finally { btn.disabled = false; }
});

// Revoke
function openRevoke(key) {
  const e = CURRENT_DATA[key]; if (!e) return;
  REVOKE_TARGET = key;
  $('#revoke-context').innerHTML = '<strong>' + escapeHtml(e.name || '—') + '</strong> · ' + key + '<br>Expire : ' + e.expires;
  openModal('modal-revoke');
}
$('#revoke-submit').addEventListener('click', async () => {
  const btn = $('#revoke-submit'); btn.disabled = true;
  try {
    const data = await api('/api/admin/revoke', {
      method: 'POST',
      body: { key: REVOKE_TARGET }
    });
    if (!data) return;
    closeModals();
    refresh();
    toast('Révoquée : ' + data.key, 'success');
  } catch (err) {
    toast('Erreur : ' + err.message, 'error');
  } finally { btn.disabled = false; }
});

// Search + refresh
$('#search').addEventListener('input', () => renderTable(CURRENT_DATA, $('#search').value));
$('#btn-refresh').addEventListener('click', refresh);

// Keyboard
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModals();
});

// Boot
refresh();
</script>
</body>
</html>`;

module.exports = (req, res) => {
  if (!requireAuth(req, res)) return;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(HTML);
};
