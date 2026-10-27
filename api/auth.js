// POST /api/auth — ingreso staff solo con PIN (sin email).
// Body { role, name, pin }. Roles: comercio, delivery.
// El rol admin NO entra por acá: usa POST /api/auth?owner=1 (Acceso dueño).
// POST /api/auth?action=change-pin (con Bearer staff) — cambiar el propio PIN.
//
// Clientes (tabla customers, auth separada del staff):
// POST /api/auth?customer=register { full_name, ci, email, phone, default_address, password }
// POST /api/auth?customer=login { email, password }
// POST /api/auth?customer=google { id_token } (Google Identity Services)
// Respuesta cliente: { token, customer } sin password_hash. El token usa el
// mismo signToken con role 'customer'.
// POST /api/auth?owner=1 — Acceso dueño: SOLO { name, pin } y SOLO rol admin.
// Cualquier otro rol recibe "Acceso solo para el dueño de la plataforma".

const crypto = require('crypto');
const {
  getPool, hashPin, newSalt, hashPassword, verifyPassword,
  normalizeCI, validateCI, signToken, requireAuth, methodNotAllowed,
} = require('./_db');

const STAFF_ROLES = ['comercio', 'delivery'];

function publicCustomer(row) {
  return {
    id: row.id,
    full_name: row.full_name,
    ci: row.ci,
    email: row.email,
    phone: row.phone,
    default_address: row.default_address,
    active: row.active,
    created_at: row.created_at,
    google_linked: !!row.google_sub,
    profile_complete: validateCI(row.ci) && !!String(row.phone || '').trim() && !!String(row.default_address || '').trim(),
  };
}

function customerToken(row) {
  return signToken({
    userId: row.id,
    role: 'customer',
    name: row.full_name,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
}

function validEmail(email) {
  return /^\S+@\S+\.\S+$/.test(email);
}

function b64urlDecode(s) {
  return Buffer.from(String(s), 'base64url');
}

// Verifica un ID token de Google sin librerías nuevas: JWKS público de Google,
// firma RS256, iss, aud (el client ID configurado) y expiración.
async function verifyGoogleIdToken(idToken, clientId) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Token de Google inválido');
  let header;
  let payload;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch (e) {
    throw new Error('Token de Google inválido');
  }
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Token de Google inválido');
  const jwksRes = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!jwksRes.ok) throw new Error('No se pudo verificar con Google');
  const jwks = await jwksRes.json();
  const key = (jwks.keys || []).find((k) => k.kid === header.kid);
  if (!key) throw new Error('Token de Google inválido');
  const publicKey = crypto.createPublicKey({ key, format: 'jwk' });
  const ok = crypto.verify(
    'sha256',
    Buffer.from(parts[0] + '.' + parts[1], 'utf8'),
    publicKey,
    b64urlDecode(parts[2])
  );
  if (!ok) throw new Error('Token de Google inválido');
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
    throw new Error('Token de Google inválido');
  }
  if (payload.aud !== clientId) throw new Error('Token de Google inválido');
  if (!payload.exp || payload.exp * 1000 <= Date.now()) throw new Error('Token de Google vencido');
  if (!payload.sub || !payload.email) throw new Error('Token de Google inválido');
  if (payload.email_verified === false || payload.email_verified === 'false') {
    throw new Error('El email de Google no está verificado');
  }
  return payload;
}

module.exports = async function handler(req, res) {
  const pool = getPool();

  // ---- Cambio de PIN propio (staff) ----
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
    await pool.query('UPDATE users SET pin_hash = $1, pin_salt = $2 WHERE id = $3', [hashPin(newPin, salt), salt, user.id]);
    res.status(200).json({ ok: true });
    return;
  }

  // ---- Acceso dueño (solo admin, solo nombre + PIN) ----
  if (req.method === 'POST' && req.query && req.query.owner === '1') {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const name = String(body.name || '').trim();
    const pin = String(body.pin || '');
    if (!name || !pin) {
      res.status(400).json({ error: 'Faltan nombre o PIN' });
      return;
    }
    const adminRow = await pool.query(
      "SELECT * FROM users WHERE role = 'admin' AND LOWER(name) = LOWER($1)",
      [name]
    );
    if (adminRow.rows[0]) {
      const row = adminRow.rows[0];
      if (!row.active || !row.pin_hash || !row.pin_salt) {
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
      return;
    }
    // Existe con otro rol: no entra por acá.
    const other = await pool.query('SELECT id FROM users WHERE LOWER(name) = LOWER($1) LIMIT 1', [name]);
    if (other.rows[0]) {
      res.status(403).json({ error: 'Acceso solo para el dueño de la plataforma' });
      return;
    }
    res.status(401).json({ error: 'Nombre o PIN incorrectos' });
    return;
  }

  // ---- Clientes ----
  if (req.method === 'POST' && req.query && req.query.customer) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    if (req.query.customer === 'register') {
      const fullName = String(body.full_name || '').trim();
      const ci = normalizeCI(body.ci);
      const email = String(body.email || '').trim().toLowerCase();
      const phone = String(body.phone || '').trim();
      const address = String(body.default_address || '').trim();
      const password = String(body.password || '');
      if (!fullName || !phone || password.length < 6) {
        res.status(400).json({ error: 'Faltan nombre completo, teléfono o una contraseña de al menos 6 caracteres' });
        return;
      }
      if (!validateCI(ci)) {
        res.status(400).json({ error: 'La cédula no es válida (8 dígitos con dígito verificador)' });
        return;
      }
      if (!validEmail(email)) {
        res.status(400).json({ error: 'El email no es válido' });
        return;
      }
      if (!address) {
        res.status(400).json({ error: 'Falta la dirección de entrega' });
        return;
      }
      try {
        const result = await pool.query(
          `INSERT INTO customers (full_name, ci, email, phone, default_address, password_hash, active)
           VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING *`,
          [fullName, ci, email, phone, address, hashPassword(password)]
        );
        res.status(201).json({ customer: publicCustomer(result.rows[0]) });
      } catch (e) {
        if (e && e.code === '23505') {
          res.status(409).json({ error: 'Ya existe un cliente con esa cédula o ese email' });
          return;
        }
        throw e;
      }
      return;
    }

    if (req.query.customer === 'login') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!email || !password) {
        res.status(400).json({ error: 'Faltan email o contraseña' });
        return;
      }
      const result = await pool.query('SELECT * FROM customers WHERE LOWER(email) = LOWER($1)', [email]);
      const row = result.rows[0];
      if (!row || !row.active) {
        res.status(401).json({ error: 'Email o contraseña incorrectos' });
        return;
      }
      if (!row.password_hash) {
        res.status(401).json({ error: 'Esta cuenta se creó con Google: ingresá con Google' });
        return;
      }
      if (!verifyPassword(password, row.password_hash)) {
        res.status(401).json({ error: 'Email o contraseña incorrectos' });
        return;
      }
      res.status(200).json({ token: customerToken(row), customer: publicCustomer(row) });
      return;
    }

    if (req.query.customer === 'google') {
      const idToken = String(body.id_token || body.credential || '');
      if (!idToken) {
        res.status(400).json({ error: 'Falta el token de Google' });
        return;
      }
      const setting = await pool.query("SELECT value FROM settings WHERE key = 'google_client_id'");
      const clientId = setting.rows[0] ? String(setting.rows[0].value || '').trim() : '';
      if (!clientId) {
        res.status(400).json({ error: 'Google todavía no está configurado en la plataforma' });
        return;
      }
      let payload;
      try {
        payload = await verifyGoogleIdToken(idToken, clientId);
      } catch (e) {
        res.status(401).json({ error: e.message || 'No se pudo verificar con Google' });
        return;
      }
      const email = String(payload.email).toLowerCase();
      let row = (await pool.query('SELECT * FROM customers WHERE google_sub = $1', [payload.sub])).rows[0];
      if (!row) {
        row = (await pool.query('SELECT * FROM customers WHERE LOWER(email) = LOWER($1)', [email])).rows[0];
        if (row) {
          if (!row.active) {
            res.status(401).json({ error: 'Cuenta suspendida' });
            return;
          }
          if (row.google_sub && row.google_sub !== payload.sub) {
            res.status(409).json({ error: 'Ese email ya está vinculado a otra cuenta de Google' });
            return;
          }
          if (!row.google_sub) {
            row = (await pool.query(
              'UPDATE customers SET google_sub = $1 WHERE id = $2 RETURNING *',
              [payload.sub, row.id]
            )).rows[0];
          }
        }
      }
      if (!row) {
        // Perfil incompleto: el frontend pide CI, teléfono y dirección.
        const created = await pool.query(
          `INSERT INTO customers (full_name, ci, email, phone, default_address, password_hash, google_sub, active)
           VALUES ($1, $2, $3, $4, $5, NULL, $6, TRUE) RETURNING *`,
          [String(payload.name || '').trim() || email, '', email, '', '', payload.sub]
        );
        row = created.rows[0];
      }
      if (!row.active) {
        res.status(401).json({ error: 'Cuenta suspendida' });
        return;
      }
      res.status(200).json({ token: customerToken(row), customer: publicCustomer(row) });
      return;
    }

    return methodNotAllowed(res);
  }

  // ---- Ingreso staff (comercio / delivery). Admin va por Acceso dueño. ----
  if (req.method !== 'POST') return methodNotAllowed(res);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const role = String(body.role || '');
  const name = String(body.name || '').trim();
  const pin = String(body.pin || '');
  if (role === 'admin') {
    res.status(403).json({ error: 'Usá el Acceso dueño para entrar como dueño de la plataforma' });
    return;
  }
  if (STAFF_ROLES.indexOf(role) === -1 || !name || !pin) {
    res.status(400).json({ error: 'Faltan rol, nombre o PIN' });
    return;
  }
  const result = await pool.query(
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
