// ═══ Test isolé du moteur de sync (Étape 32) ═══
// Extrait le bloc ⟦SYNC-ENGINE⟧ de crm-pro.html et simule 2 postes (A=courtier, B=adjointe).
// Chaque poste a : state (db), meta ({tomb,fts}), clock, shadow, journal (ops émises).
// Convergence = après échange complet des journaux, états identiques.
// Lancer : node test-sync-engine.js
'use strict';
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'crm-pro.html'), 'utf8');
const m = html.match(/\/\/ ⟦SYNC-ENGINE-BEGIN⟧[\s\S]*?\/\/ ⟦SYNC-ENGINE-END⟧/);
if (!m) { console.error('FAIL: bloc SYNC-ENGINE introuvable'); process.exit(1); }
const engine = {};
new Function('exports', m[0] + '\nexports.SYNC_COLLS=SYNC_COLLS;exports.diff=_syncDiffOps;exports.apply=_syncApplyOps;exports.tick=_syncTick;exports.rescue=_syncRescueOps;exports.sanitize=_collabSanitize;exports.filterIn=_collabFilterIncoming;exports.COLLAB_COLLS=COLLAB_COLLS;exports.compact=_syncCompactOps;')(engine);

// ── Simulateur de poste ──
let fakeNow = 1000000;
const realNow = Date.now; Date.now = () => fakeNow; // horloge contrôlée
function device(dev) {
  return {
    dev, state: {}, meta: { tomb: {}, fts: {} }, clock: { v: 0 }, shadow: {}, journal: [],
    snap() { this.shadow = JSON.parse(JSON.stringify(this.state)); },
    // mutation locale → diff → ops dans le journal
    commit() {
      const ops = engine.diff(this.shadow, this.state, this.dev, this.meta, this.clock);
      this.journal.push(...ops); this.snap(); return ops;
    },
    // reçoit les ops d'un autre poste (comme l'app : sauvetage + avance d'horloge)
    receive(ops) {
      const resc = [];
      engine.apply(this.state, this.meta, JSON.parse(JSON.stringify(ops)), resc, this.clock);
      if (resc.length) this.journal.push(...engine.rescue(this.state, this.meta, this.dev, this.clock, resc));
      this.snap();
    },
    coll(c) { if (!this.state[c]) this.state[c] = []; return this.state[c]; },
    find(c, id) { return (this.state[c] || []).find(r => r.id === id) || null; }
  };
}
function exchange(A, B) { // échange complet des journaux (depuis le début — idempotent requis)
  B.receive(A.journal); A.receive(B.journal);
}
// Sérialisation canonique (clés triées récursivement) — l'ordre d'insertion des clés ne
// constitue pas une divergence de données
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function deepEq(a, b) { return canon(a) === canon(b); }
function sortedState(s) {
  const out = {};
  Object.keys(s).sort().forEach(c => { out[c] = (s[c] || []).slice().sort((x, y) => x.id < y.id ? -1 : 1); });
  return out;
}
let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
}
function checkConverge(label, A, B) {
  check(label + ' — convergence A=B', deepEq(sortedState(A.state), sortedState(B.state)));
}

// ── Scénario 1 : création propagée ──
console.log('S1 — Création sur A apparaît chez B');
let A = device('AAAA'), B = device('BBBB');
A.coll('a').push({ id: 'r1', prenom: 'Kim', nom: 'Lessard', telephone: '418-111-1111' });
fakeNow += 1000; A.commit();
exchange(A, B);
check('B a la fiche', !!B.find('a', 'r1') && B.find('a', 'r1').prenom === 'Kim');
checkConverge('S1', A, B);

// ── Scénario 2 : éditions concurrentes de CHAMPS DIFFÉRENTS sur la même fiche ──
console.log('S2 — A change le téléphone, B change l\'adresse (concurrent) → les deux gagnent');
fakeNow += 1000; A.find('a', 'r1').telephone = '418-222-2222'; A.commit();
fakeNow += 7; B.find('a', 'r1').adresse = '233 rue St-Alphonse Nord'; B.commit();
exchange(A, B);
check('téléphone de A conservé chez B', B.find('a', 'r1').telephone === '418-222-2222');
check('adresse de B conservée chez A', A.find('a', 'r1').adresse === '233 rue St-Alphonse Nord');
checkConverge('S2', A, B);

// ── Scénario 3 : édition concurrente du MÊME champ → dernier ts gagne, des deux côtés ──
console.log('S3 — Même champ édité des deux côtés → le plus récent gagne partout');
fakeNow += 1000; A.find('a', 'r1').notes = 'note de A'; A.commit();
fakeNow += 500; B.find('a', 'r1').notes = 'note de B (plus récente)'; B.commit();
exchange(A, B);
check('A adopte la note de B', A.find('a', 'r1').notes === 'note de B (plus récente)');
check('B garde sa note', B.find('a', 'r1').notes === 'note de B (plus récente)');
checkConverge('S3', A, B);

// ── Scénario 4 : suppression SANS résurrection ──
console.log('S4 — A supprime ; les vieilles ops de B ne ressuscitent pas la fiche');
fakeNow += 1000;
A.state.a = A.state.a.filter(r => r.id !== 'r1'); A.commit();
exchange(A, B);
check('fiche supprimée chez B', !B.find('a', 'r1'));
// ré-échange complet (vieilles ops 'up' de B re-reçues par A) → ne doit PAS revenir
exchange(A, B);
check('pas de résurrection chez A', !A.find('a', 'r1'));
check('pas de résurrection chez B', !B.find('a', 'r1'));
checkConverge('S4', A, B);

// ── Scénario 5 : suppression vs édition concurrente → l'ÉDITION gagne (jamais perdre une donnée) ──
console.log('S5 — A supprime (t1), B édite après (t2>t1) → la fiche survit partout avec l\'édition');
A = device('AAAA'); B = device('BBBB');
A.coll('pa').push({ id: 'p1', prenom: 'Marc', statutPa: 'En cours' });
fakeNow += 1000; A.commit(); exchange(A, B);
fakeNow += 1000; A.state.pa = []; A.commit();             // A supprime à t1
fakeNow += 500; B.find('pa', 'p1').statutPa = 'Acceptée'; B.commit(); // B édite à t2 > t1
exchange(A, B);
check('fiche survit chez A (édition > suppression)', !!A.find('pa', 'p1'));
check('statut de B conservé', A.find('pa', 'p1') && A.find('pa', 'p1').statutPa === 'Acceptée');
checkConverge('S5', A, B);

// ── Scénario 6 : recréation légitime APRÈS suppression ──
console.log('S6 — fiche supprimée puis recréée plus tard (même id) → existe partout');
fakeNow += 1000; B.state.pa = []; B.commit(); exchange(A, B); // tout le monde l'a supprimée
check('supprimée partout', !A.find('pa', 'p1') && !B.find('pa', 'p1'));
fakeNow += 1000; A.coll('pa').push({ id: 'p1', prenom: 'Marc', statutPa: 'Relancée' }); A.commit();
exchange(A, B);
check('recréée chez B', !!B.find('pa', 'p1') && B.find('pa', 'p1').statutPa === 'Relancée');
checkConverge('S6', A, B);

// ── Scénario 7 : retrait de champ (__DEL__) ──
console.log('S7 — champ retiré localement → retiré partout');
fakeNow += 1000; delete A.find('pa', 'p1').statutPa; A.commit();
exchange(A, B);
check('champ retiré chez B', !('statutPa' in B.find('pa', 'p1')));
checkConverge('S7', A, B);

// ── Scénario 8 : idempotence (ré-appliquer 3× les mêmes journaux ne change rien) ──
console.log('S8 — idempotence');
const before = canon(sortedState(A.state));
exchange(A, B); exchange(A, B); exchange(A, B);
check('état stable après ré-applications', canon(sortedState(A.state)) === before);
checkConverge('S8', A, B);

// ── Scénario 9 : horloge B en retard (décalage d'horloge système) ──
console.log('S9 — horloge de B 1h en retard : son édition POSTÉRIEURE doit quand même finir appliquée via l\'horloge monotone');
A = device('AAAA'); B = device('BBBB');
A.coll('v').push({ id: 'v1', prenom: 'Sophie', prix: '300000' });
fakeNow += 1000; A.commit(); exchange(A, B);
// receive() avance maintenant l'horloge logique de B au max des ts reçus (comme l'app)
fakeNow -= 3600000; // mur de B "recule" d'une heure
B.find('v', 'v1').prix = '295000'; B.commit();
fakeNow += 3600000 + 2000;
exchange(A, B);
check('édition de B appliquée chez A malgré l\'horloge en retard', A.find('v', 'v1').prix === '295000');
checkConverge('S9', A, B);

// ── Scénario 10 : volume — 300 fiches, éditions croisées ──
console.log('S10 — volume (300 fiches, éditions croisées)');
A = device('AAAA'); B = device('BBBB');
for (let i = 0; i < 300; i++) A.coll('cp').push({ id: 'c' + i, prenom: 'P' + i, notes: '' });
fakeNow += 1000; A.commit(); exchange(A, B);
for (let i = 0; i < 300; i += 2) { A.find('cp', 'c' + i).notes = 'A' + i; }
fakeNow += 1000; A.commit();
for (let i = 1; i < 300; i += 2) { B.find('cp', 'c' + i).notes = 'B' + i; }
fakeNow += 1000; B.commit();
exchange(A, B);
check('300 fiches partout', A.state.cp.length === 300 && B.state.cp.length === 300);
check('édits A et B fusionnés', A.find('cp', 'c0').notes === 'A0' && A.find('cp', 'c1').notes === 'B1');
checkConverge('S10', A, B);

// ── Scénario 11 : Collaboration — la sanitisation ne laisse JAMAIS passer les commissions ──
console.log('S11 — sanitisation collab : commissions retirées, part du collaborateur injectée');
const rec = { id: 'v9', prenom: 'Luc', adresse: '12 rue Test', prix: '300000', montant: '295000', commTot: '4', commAutre: '2', commission: '2', commissionSophie: '1200', _evt_notaire: 'evt123', _collab: { ch: 'chX', pct: 20 }, notes: 'dossier chaud' };
const clean = engine.sanitize(rec, 'chX', 20, 1180, 'AAAA');
check('commTot retiré', !('commTot' in clean));
check('commAutre retiré', !('commAutre' in clean));
check('commission retirée', !('commission' in clean));
check('commissionSophie retirée', !('commissionSophie' in clean));
check('eventId calendrier retiré', !('_evt_notaire' in clean));
check('flag _collab local retiré', !('_collab' in clean));
check('prix opérationnel conservé', clean.prix === '300000');
check('part collaborateur injectée', clean._collabPct === 20 && clean._collabMontant === 1180);
check('propriétaire estampillé', clean._ownerDev === 'AAAA');

// ── Scénario 12 : Collaboration — protection propriétaire sur les ops entrantes ──
console.log('S12 — protection propriétaire : del du collègue ignoré, % non modifiable');
const state = { v: [{ id: 'v9', prenom: 'Luc', _collab: { ch: 'chX', pct: 20 }, _ownerDev: 'AAAA' }] };
const incoming = [
  { ts: 10, dev: 'BBBB', op: 'del', c: 'v', id: 'v9' },                                  // le collègue supprime sa copie
  { ts: 11, dev: 'BBBB', op: 'up', c: 'v', id: 'v9', d: { _collabPct: 95, notes: 'maj du collègue', commission: '9' } }, // tentative de gonfler son %
  { ts: 12, dev: 'BBBB', op: 'up', c: 'v', id: 'newrec', d: { id: 'newrec', prenom: 'Eve', _ownerDev: 'BBBB' } }       // fiche du collègue (légitime)
];
const kept = engine.filterIn(JSON.parse(JSON.stringify(incoming)), state, 'AAAA');
check('del du collègue ignoré (je suis propriétaire)', !kept.some(o => o.op === 'del'));
const up9 = kept.find(o => o.id === 'v9' && o.op === 'up');
check('up conservé mais % et commission filtrés', up9 && !('_collabPct' in up9.d) && !('commission' in up9.d) && up9.d.notes === 'maj du collègue');
check('fiche légitime du collègue passe', kept.some(o => o.id === 'newrec'));

// ── Scénario 13 : Compaction du journal — équivalence stricte ──
console.log('S13 — compaction : le journal compacté reproduit l\'état, sans écraser plus récent');
// Poste C construit un historique : créations, éditions, suppression
let C = device('CCCC'), D = device('DDDD');
C.coll('a').push({ id: 'c1', prenom: 'Ana', telephone: '111' });
C.coll('v').push({ id: 'c2', prenom: 'Bob', adresse: 'ici' });
fakeNow += 1000; C.commit();
fakeNow += 1000; C.find('a', 'c1').telephone = '222'; C.commit();
fakeNow += 1000; C.state.v = C.state.v.filter(r => r.id !== 'c2'); C.commit(); // suppression → tombstone
const compacted = engine.compact(C.state, C.meta, 'CCCC');
// 13a : rejouer le journal compacté sur un poste VIERGE = même état
D.receive(compacted);
check('état reproduit à l\'identique', deepEq(sortedState(D.state), sortedState(C.state)));
check('tombstone présent dans la compaction', compacted.some(o => o.op === 'del' && o.id === 'c2'));
// 13b : la fiche supprimée ne ressuscite pas chez un poste qui avait l'ancienne version
let E = device('EEEE');
E.receive(C.journal.slice(0, 2)); // E n'a que les créations (avant suppression)
E.receive(compacted);
check('suppression appliquée via compaction chez le retardataire', !E.find('v', 'c2'));
// 13c : une édition PLUS RÉCENTE d'un autre poste n'est pas écrasée par la compaction
fakeNow += 1000; D.find('a', 'c1').telephone = '333-nouveau'; D.commit();
C.receive(D.journal); // C connaît l'édition de D
const compacted2 = engine.compact(C.state, C.meta, 'CCCC');
const opTel = compacted2.filter(o => o.op === 'up' && o.id === 'c1' && o.d.telephone !== undefined);
check('le champ édité par D garde le ts/dev de D', opTel.length === 1 && opTel[0].dev === 'DDDD');
// rejouer compacted2 chez D ne change rien (idempotence croisée)
const avant13 = canon(sortedState(D.state));
D.receive(compacted2);
check('rejouer la compaction chez D = aucun changement', canon(sortedState(D.state)) === avant13);
checkConverge('S13', C, D);
// 13d : champs jamais synchronisés (import autosave, pas de fts) → ts=1, toute édition réelle gagne
let F = device('FFFF'), G = device('GGGG');
F.state.a = [{ id: 'f1', prenom: 'Zoe', notes: 'import autosave' }]; // injecté SANS commit (pas de fts)
const compactedF = engine.compact(F.state, F.meta, 'FFFF');
check('champ sans fts émis à ts=1', compactedF.every(o => o.ts === 1));
G.coll('a').push({ id: 'f1', prenom: 'Zoé-corrigée' });
fakeNow += 1000; G.commit();
G.receive(compactedF);
check('l\'édition réelle de G bat le ts préhistorique', G.find('a', 'f1').prenom === 'Zoé-corrigée');
check('le champ inédit de F arrive quand même chez G', G.find('a', 'f1').notes === 'import autosave');

Date.now = realNow;
console.log('\n══════ RÉSULTAT : ' + pass + ' OK, ' + fail + ' FAIL ══════');
process.exit(fail ? 1 : 0);
