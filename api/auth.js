// POST /api/auth — ingreso solo con PIN (sin email).
// Body { role, name, pin }. Roles: admin, comercio, delivery.
// Respuesta: { token, user } sin hashes ni sales.
// POST /api/auth?action=change-pin (con Bearer) — cambiar el propio PIN.

const crypto = require('crypto');
const { getPool, hashPin, newSalt, signToken, requireAuth, methodNotAllowed } = require('./_db');

const ROLES = ['admin', 'comercio', 'delivery'];

module.exports = async function handler(req, res) {
  if (req.method === 'POST' && req.query && req.query.action === 'change-pin') {
    const user = await requireAuth(req, res, null);
    if (!user) return;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const newPin = String(body.new_pin || body.pin || '');
    if (newPin.length < 4) {
      res.status(400).json({ error: 'El PIN nuevo debe tener al menos 4 caracteres' });
      return;
    }
    const salt = newSalt();
    await getPool().query('UPDATE users SET pin_hash = $1, pin_salt = $2 WHERE id = $3', [hashPin(newPin, salt), salt, user.id]);
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method !== 'POST') return methodNotAllowed(res);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const role = String(body.role || '');
  const name = String(body.name || '').trim();
  const pin = String(body.pin || '');
  if (ROLES.indexOf(role) === -1 || !name || !pin) {
    res.status(400).json({ error: 'Faltan rol, nombre o PIN' });
    return;
  }
  const result = await getPool().query(
    'SELECT id, name, phone, role, vehicle, monotributo_rut, pos_provider, pos_terminal, online, active, pin_hash, pin_salt FROM users WHERE role = $1 AND LOWER(name) = LOWER($2)',
    [role, name]
  );
  const row = result.rows[0];
  if (!row || !row.active || !row.pin_hash || !row.pin_salt) {
    res.status(401).json({ error: 'Nombre o PIN incorrectos' });
    return;
  }
  const digest = hashPin(pin, row.pin_salt);
  const a = Buffer.from(digest);
  const b = Buffer.from(row.pin_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'Nombre o PIN incorrectos' });
    return;
  }
  const token = signToken({
    userId: row.id,
    role: row.role,
    name: row.name,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
  res.status(200).json({
    token,
    user: {
      id: row.id,
      name: row.name,
      phone: row.phone,
      role: row.role,
      vehicle: row.vehicle,
      monotributo_rut: row.monotributo_rut,
      pos_provider: row.pos_provider,
      pos_terminal: row.pos_terminal,
      online: row.online,
    },
  });
};
