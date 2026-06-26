#!/usr/bin/env node
/**
 * verif-avant-publish.js — Garde-fou anti-régression pour TRI-ANGLE.
 *
 * À LANCER AVANT CHAQUE PUBLISH :  node verif-avant-publish.js
 * Si ça affiche "❌", NE PAS PUBLIER tant que ce n'est pas réglé.
 *
 * Ce script attrape les erreurs que le simple check de syntaxe NE VOIT PAS :
 *  1. Syntaxe JS de chaque bloc <script>
 *  2. COHÉRENCE onglets ↔ tables DOM (le bug v0.3.35 : archac/archvc dans TABS
 *     mais pas de <table id="tbl-archac">) → crash au démarrage
 *  3. Patterns dangereux au démarrage (localStorage.clear, etc.)
 *  4. package.json : version présente, pas de BOM, JSON valide
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const HTML = path.join(ROOT, 'crm-pro.html');
const PKG  = path.join(ROOT, 'electron-app', 'package.json');

let errors = 0, warnings = 0;
const fail = (m) => { console.log('❌ ' + m); errors++; };
const warn = (m) => { console.log('⚠️  ' + m); warnings++; };
const ok   = (m) => console.log('✅ ' + m);

const html = fs.readFileSync(HTML, 'utf8');

// ── 1. Syntaxe de chaque bloc <script> ──────────────────────────────
(() => {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m, i = 0, bad = 0;
  while ((m = re.exec(html))) {
    i++; if (!m[1].trim()) continue;
    try { new Function(m[1]); }
    catch (e) { fail('Syntaxe bloc <script> #' + i + ' : ' + e.message); bad++; }
  }
  if (!bad) ok('Syntaxe JS : ' + i + ' bloc(s), 0 erreur');
})();

// ── 2. COHÉRENCE onglets ↔ tables DOM (LE bug v0.3.35) ──────────────
(() => {
  // Extraire TABS = [...] et le .concat([...]) de TABS_UI
  const tabsM = html.match(/var\s+TABS\s*=\s*\[([^\]]*)\]/);
  const uiM   = html.match(/var\s+TABS_UI\s*=\s*TABS\.concat\(\[([^\]]*)\]/);
  if (!tabsM) { warn('Impossible de localiser `var TABS = [...]` — vérif onglets sautée'); return; }
  const parseList = (s) => (s.match(/'([^']+)'|"([^"]+)"/g) || []).map(x => x.replace(/['"]/g, ''));
  const tabs = parseList(tabsM[1]);
  const ui   = uiM ? parseList(uiM[1]) : [];
  const allTabs = tabs.concat(ui);

  // Tables réellement présentes dans le DOM
  const domTables = new Set((html.match(/id="tbl-([a-z0-9-]+)"/g) || []).map(x => x.replace(/id="tbl-|"/g, '')));
  // Définitions de colonnes COLS (clé: [ ... )
  const colsKeys = new Set();
  const colsBlock = html.match(/var\s+COLS\s*=\s*\{([\s\S]*?)\n\s*\};/);
  // fallback : repérer "xxx: [" en début de ligne dans tout le fichier (COLS est gros)
  (html.match(/^\s{2,}([a-z0-9_-]+)\s*:\s*\[/gim) || []).forEach(l => {
    const k = l.trim().split(':')[0]; colsKeys.add(k);
  });

  let problems = 0;
  allTabs.forEach(t => {
    const hasTable = domTables.has(t);
    if (!hasTable) {
      // buildHeaders/renderTab bouclent sur TABS_UI → si pas de table, risque de crash
      // (sauf si le code a une garde — mais on signale quand même comme incohérence à vérifier)
      fail('Onglet "' + t + '" est dans TABS/TABS_UI mais AUCUNE <table id="tbl-' + t + '"> dans le HTML → risque de crash au démarrage (buildHeaders/null.parentElement)');
      problems++;
    }
  });
  if (!problems) ok('Cohérence onglets ↔ tables DOM : ' + allTabs.length + ' onglet(s), tous ont leur table');
})();

// ── 3. Patterns dangereux ───────────────────────────────────────────
(() => {
  let bad = 0;
  if (/localStorage\.clear\s*\(/.test(html)) { fail('localStorage.clear() présent — risque d\'effacer licence/données'); bad++; }
  // removeItem licence : OK si dans une fonction _licClear, mais alerter si appelé au top-level d'init
  if (!bad) ok('Patterns dangereux : aucun localStorage.clear()');
})();

// ── 4. package.json ─────────────────────────────────────────────────
(() => {
  const raw = fs.readFileSync(PKG);
  if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) { fail('package.json a un BOM UTF-8 → electron-builder va crasher. Ré-écrire via node fs.writeFileSync.'); return; }
  let j;
  try { j = JSON.parse(raw.toString('utf8')); }
  catch (e) { fail('package.json JSON invalide : ' + e.message); return; }
  if (!j.version) { fail('package.json sans version'); return; }
  ok('package.json OK — version ' + j.version + ', pas de BOM');
})();

// ── Verdict ─────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
if (errors > 0) {
  console.log('❌ ' + errors + ' ERREUR(S) — NE PAS PUBLIER avant correction.');
  process.exit(1);
} else {
  console.log('✅ Tout est bon' + (warnings ? ' (' + warnings + ' avertissement(s))' : '') + ' — publish autorisé.');
  process.exit(0);
}
