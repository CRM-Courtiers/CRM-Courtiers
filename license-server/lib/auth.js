// Basic Auth pour les endpoints admin.
// Username fixe : "admin"
// Password : variable d'env ADMIN_PASSWORD (à définir dans Vercel)

function checkAuth(req) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false; // safer to deny if not configured
  const auth = req.headers.authorization || req.headers.Authorization;
  if (!auth || typeof auth !== 'string' || !auth.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  } catch { return false; }
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  return user === 'admin' && pass === expected;
}

function requireAuth(req, res) {
  if (checkAuth(req)) return true;
  res.setHeader('WWW-Authenticate', 'Basic realm="TRI-ANGLE Admin", charset="UTF-8"');
  res.status(401).json({ error: 'Authentification requise' });
  return false;
}

module.exports = { checkAuth, requireAuth };
