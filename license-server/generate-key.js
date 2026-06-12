// Génère une nouvelle clé de licence TRI-ANGLE dans Upstash Redis.
// Usage : node generate-key.js "Nom du client" trial|paid [mois]
//         node generate-key.js "Nom Adjointe" adjointe CLE-DU-COURTIER   (Étape 34 — clé LIÉE)
// Exemples :
//   node generate-key.js "Sophie Tremblay" trial         → trial 3 mois
//   node generate-key.js "Marc Dupont" paid 12           → paid 12 mois
//   node generate-key.js "Julie Roy" adjointe KC9K-NM5C-GMQZ-CAPM
//     → clé adjointe liée : expire/renouvelle/révoque AVEC la clé du courtier,
//       et force le profil Adjoint(e) dans l'app.

const crypto = require('crypto');
const { setKey, getKey, keyExists } = require('./lib/kv');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('❌ Usage : node generate-key.js "Nom du client" trial|paid [mois]');
  console.error('          node generate-key.js "Nom Adjointe" adjointe CLE-DU-COURTIER');
  process.exit(1);
}

const clientName = args[0];
const plan = args[1].toLowerCase();
const isAdjointe = (plan === 'adjointe');
const parentKeyArg = isAdjointe ? (args[2] || '').toUpperCase().trim() : null;
const months = (!isAdjointe && args[2]) ? parseInt(args[2]) : (plan === 'trial' ? 3 : 1);

if (isAdjointe) {
  if (!parentKeyArg) {
    console.error('❌ Mode adjointe : il faut la clé du courtier. Usage : node generate-key.js "Nom" adjointe CLE-DU-COURTIER');
    process.exit(1);
  }
} else if (plan !== 'trial' && plan !== 'paid' && plan !== 'free_trial') {
  console.error('❌ Plan invalide. Utiliser "trial", "paid" ou "adjointe CLE-PARENT".');
  process.exit(1);
}
const planNormalized = (plan === 'trial' ? 'free_trial' : plan);

if (!isAdjointe && (isNaN(months) || months < 1 || months > 120)) {
  console.error('❌ Nombre de mois invalide (1-120).');
  process.exit(1);
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genGroup() {
  let s = '';
  const bytes = crypto.randomBytes(4);
  for (let i = 0; i < 4; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

async function generateUniqueKey() {
  // Boucle de sécurité (probabilité de collision ≈ 0 mais on vérifie quand même)
  for (let attempt = 0; attempt < 10; attempt++) {
    const k = `${genGroup()}-${genGroup()}-${genGroup()}-${genGroup()}`;
    if (!(await keyExists(k))) return k;
  }
  throw new Error('Impossible de générer une clé unique après 10 tentatives');
}

async function main() {
  let entry, expiresStr, parentInfo = '';

  if (isAdjointe) {
    // Étape 34 — clé liée : valider le parent, hériter de son état (résolu LIVE par validate)
    const parent = await getKey(parentKeyArg);
    if (!parent) {
      console.error('❌ Clé parent introuvable : ' + parentKeyArg);
      process.exit(1);
    }
    if (parent.linkedTo) {
      console.error('❌ La clé parent est elle-même une clé liée (' + parent.linkedTo + ') — lie l\'adjointe à la clé du COURTIER.');
      process.exit(1);
    }
    expiresStr = parent.expires; // informatif (le validate résout toujours le parent en direct)
    entry = {
      expires: expiresStr,
      plan: 'linked',
      role: 'adjointe',
      linkedTo: parentKeyArg,
      name: clientName,
      createdAt: new Date().toISOString().substring(0, 10)
    };
    parentInfo = '  Liée à :  ' + parentKeyArg + ' (' + (parent.name || '?') + ')';
  } else {
    const exp = new Date();
    exp.setMonth(exp.getMonth() + months);
    expiresStr = exp.toISOString().substring(0, 10);
    entry = {
      expires: expiresStr,
      plan: planNormalized,
      name: clientName,
      createdAt: new Date().toISOString().substring(0, 10)
    };
  }

  const newKey = await generateUniqueKey();
  await setKey(newKey, entry);

  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log(isAdjointe ? ' 🎫 CLÉ ADJOINTE LIÉE GÉNÉRÉE' : ' 🎫 NOUVELLE CLÉ GÉNÉRÉE');
  console.log('═══════════════════════════════════════════');
  console.log('');
  console.log('  Client :  ' + clientName);
  console.log('  Plan :    ' + (isAdjointe ? 'linked (suit le parent)' : planNormalized));
  if (parentInfo) console.log(parentInfo);
  if (!isAdjointe) console.log('  Durée :   ' + months + ' mois');
  console.log('  Expire :  ' + expiresStr + (isAdjointe ? ' (suivra les renouvellements du courtier)' : ''));
  console.log('');
  console.log('  ┌────────────────────────────┐');
  console.log('  │  ' + newKey + '   │');
  console.log('  └────────────────────────────┘');
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('');
  console.log('✅ Clé écrite en KV — prend effet immédiatement (pas besoin de deploy).');
  if (isAdjointe) console.log('   L\'app validée avec cette clé forcera le profil Adjoint(e).');
  console.log('');
}

main().catch(err => {
  console.error('❌ Erreur :', err.message);
  process.exit(1);
});
