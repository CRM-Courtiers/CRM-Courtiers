// Génère une nouvelle clé de licence TRI-ANGLE dans Upstash Redis.
// Usage : node generate-key.js "Nom du client" trial|paid [mois]
// Exemples :
//   node generate-key.js "Sophie Tremblay" trial         → trial 3 mois
//   node generate-key.js "Marc Dupont" paid              → paid 1 mois
//   node generate-key.js "Karine Lebel" paid 12          → paid 12 mois

const crypto = require('crypto');
const { setKey, keyExists } = require('./lib/kv');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('❌ Usage : node generate-key.js "Nom du client" trial|paid [mois]');
  console.error('   Exemple : node generate-key.js "Sophie Tremblay" trial');
  console.error('   Exemple : node generate-key.js "Marc Dupont" paid 12');
  process.exit(1);
}

const clientName = args[0];
const plan = args[1].toLowerCase();
const months = args[2] ? parseInt(args[2]) : (plan === 'trial' ? 3 : 1);

if (plan !== 'trial' && plan !== 'paid' && plan !== 'free_trial') {
  console.error('❌ Plan invalide. Utiliser "trial" ou "paid".');
  process.exit(1);
}
const planNormalized = (plan === 'trial' ? 'free_trial' : plan);

if (isNaN(months) || months < 1 || months > 120) {
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
  const exp = new Date();
  exp.setMonth(exp.getMonth() + months);
  const expiresStr = exp.toISOString().substring(0, 10);

  const newKey = await generateUniqueKey();
  const entry = {
    expires: expiresStr,
    plan: planNormalized,
    name: clientName,
    createdAt: new Date().toISOString().substring(0, 10)
  };

  await setKey(newKey, entry);

  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log(' 🎫 NOUVELLE CLÉ GÉNÉRÉE');
  console.log('═══════════════════════════════════════════');
  console.log('');
  console.log('  Client :  ' + clientName);
  console.log('  Plan :    ' + planNormalized);
  console.log('  Durée :   ' + months + ' mois');
  console.log('  Expire :  ' + expiresStr);
  console.log('');
  console.log('  ┌────────────────────────────┐');
  console.log('  │  ' + newKey + '   │');
  console.log('  └────────────────────────────┘');
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('');
  console.log('✅ Clé écrite en KV — prend effet immédiatement (pas besoin de deploy).');
  console.log('');
}

main().catch(err => {
  console.error('❌ Erreur :', err.message);
  process.exit(1);
});
