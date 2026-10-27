// /api/users — registro público, perfil propio, disponibilidad y admin.
// POST (público): registra un comercio o un delivery.
//   Comercio: { role:'comercio', name, phone, pin }.
//   Delivery: { role:'delivery', name, phone, pin, vehicle, monotributo_rut,
//     pos_provider, pos_terminal }.
//   REGLA: el delivery DEBE tener POS (proveedor + terminal); sin esos datos
//   el registro se rechaza. No se puede registrar un admin por esta vía.
// GET ?me=1 (con Bearer): perfil propio + promedios + saldo pendiente.
// GET (admin): lista de usuarios (sin hashes ni sales), filtro ?role=.
// PUT ?online=1 (delivery): pone en línea / fuera de línea al propio delivery.
//   Ponerse en línea exige tener POS registrado.
// PUT ?id= (admin): suspender/reactivar { active: true|false }.
// Nunca se devuelve pin_hash ni pin_salt.

const { getPool, requireAuth, readBody, hashPin, newSalt, methodNotAllowed, getBalance, getLowThreshold } = require('./_db');

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    role: row.role,
    vehicle: row.vehicle,
    monotributo_rut: row.monotributo_rut,
    pos_provider: row.pos_provider,
    pos_terminal: row.pos_terminal,
    online: row.online,
    active: row.active,
    created_at: row.created_at,
  };
}

module.exports = async function handler(req, res) {
  const pool = getPool();

  if (req.method === 'POST') {
    const body = readBody(req);
    const role = String(body.role || '');
    const name = String(body.name || '').trim();
    const phone = String(body.phone || '').trim();
    const pin = String(body.pin || '');
    if (role !== 'comercio' && role !== 'delivery') {
      res.status(400).json({ error: 'El rol debe ser comercio o delivery' });
      return;
    }
    if (!name || !phone || pin.length < 4) {
      res.status(400).json({ error: 'Faltan nombre, teléfono o un PIN de al menos 4 caracteres' });
      return;
    }
    let vehicle = null;
    let rut = null;
    let posProvider = null;
    let posTerminal = null;
    if (role === 'delivery') {
      vehicle = String(body.vehicle || '').trim();
      rut = String(body.monotributo_rut || '').trim();
      posProvider = String(body.pos_provider || '').trim();
      posTerminal = String(body.pos_terminal || '').trim();
      if (!vehicle || !rut) {
        res.status(400).json({ error: 'Faltan vehículo o RUT de monotributo' });
        return;
      }
      if (!posProvider || !posTerminal) {
        res.status(400).json({ error: 'Para trabajar como delivery tenés que tener POS: faltan proveedor o terminal' });
        return;
      }
    }
    const salt = newSalt();
    try {
      const result = await pool.query(
        `INSERT INTO users (name, phone, role, pin_hash, pin_salt, vehicle, monotributo_rut, pos_provider, pos_terminal, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE) RETURNING *`,
        [name, phone, role, hashPin(pin, salt), salt, vehicle, rut, posProvider, posTerminal]
      );
      res.status(201).json(publicUser(result.rows[0]));
    } catch (e) {
      if (e && e.code === '23505') {
        res.status(409).json({ error: 'Ya existe un usuario con ese nombre para ese rol' });
        return;
      }
      throw e;
    }
    return;
  }

  if (req.method === 'GET') {
    // Movimientos de créditos propios (sin pasar por el admin).
    if (req.query && req.query.movements === '1') {
      const me = await requireAuth(req, res, null);
      if (!me) return;
      let ownerType = null;
      let ownerId = null;
      if (me.role === 'delivery') {
        ownerType = 'driver';
        ownerId = me.id;
      } else if (me.role === 'comercio') {
        const store = await pool.query('SELECT id FROM stores WHERE user_id = $1', [me.id]);
        if (!store.rows[0]) {
          res.status(200).json([]);
          return;
        }
        ownerType = 'store';
        ownerId = store.rows[0].id;
      } else {
        res.status(403).json({ error: 'Sin permiso' });
        return;
      }
      const result = await pool.query(
        'SELECT * FROM credit_movements WHERE owner_type = $1 AND owner_id = $2 ORDER BY created_at DESC LIMIT 200',
        [ownerType, ownerId]
      );
      res.status(200).json(result.rows);
      return;
    }
    if (req.query && req.query.me === '1') {
      const user = await requireAuth(req, res, null);
      if (!user) return;
      const out = publicUser(user);
      if (user.role === 'delivery') {
        const avg = await pool.query(
          `SELECT COALESCE(AVG(r.stars), 0) AS avg, COUNT(*) AS n FROM ratings r
           JOIN orders o ON o.id = r.order_id
           WHERE r.target_type = 'driver' AND o.driver_id = $1`,
          [user.id]
        );
        const bal = await getBalance(pool, 'driver', user.id);
        const threshold = await getLowThreshold(pool);
        out.avg_stars = Number(avg.rows[0].avg);
        out.ratings_count = Number(avg.rows[0].n);
        out.balance = bal;
        out.low_balance = bal < threshold;
        out.low_threshold = threshold;
      }
      if (user.role === 'comercio') {
        const store = await pool.query('SELECT * FROM stores WHERE user_id = $1', [user.id]);
        out.store = store.rows[0] || null;
        if (out.store) {
          const avg = await pool.query(
            `SELECT COALESCE(AVG(r.stars), 0) AS avg, COUNT(*) AS n FROM ratings r
             JOIN orders o ON o.id = r.order_id
             WHERE r.target_type = 'store' AND o.store_id = $1`,
            [out.store.id]
          );
          const bal = await getBalance(pool, 'store', out.store.id);
          const threshold = await getLowThreshold(pool);
          out.avg_stars = Number(avg.rows[0].avg);
          out.ratings_count = Number(avg.rows[0].n);
          out.balance = bal;
          out.low_balance = bal < threshold;
          out.low_threshold = threshold;
        }
      }
      res.status(200).json(out);
      return;
    }
    const admin = await requireAuth(req, res, ['admin']);
    if (!admin) return;
    const roleFilter = req.query && req.query.role ? String(req.query.role) : null;
    const result = roleFilter
      ? await pool.query('SELECT * FROM users WHERE role = $1 ORDER BY name', [roleFilter])
      : await pool.query('SELECT * FROM users ORDER BY role, name');
    res.status(200).json(result.rows.map(publicUser));
    return;
  }

  if (req.method === 'PUT') {
    // Disponibilidad del propio delivery.
    if (req.query && req.query.online === '1') {
      const user = await requireAuth(req, res, ['delivery']);
      if (!user) return;
      const body = readBody(req);
      const online = body.online === true;
      if (online && (!user.pos_provider || !user.pos_terminal)) {
        res.status(400).json({ error: 'Para ponerte en línea tenés que tener POS registrado' });
        return;
      }
      const result = await pool.query(
        'UPDATE users SET online = $1 WHERE id = $2 RETURNING *',
        [online, user.id]
      );
      res.status(200).json(publicUser(result.rows[0]));
      return;
    }
    // Suspender / reactivar (admin).
    const admin = await requireAuth(req, res, ['admin']);
    if (!admin) return;
    const id = req.query && req.query.id ? Number(req.query.id) : null;
    if (!id) {
      res.status(400).json({ error: 'Falta id' });
      return;
    }
    const body = readBody(req);
    const result = await pool.query(
      'UPDATE users SET active = $1 WHERE id = $2 RETURNING *',
      [body.active !== false, id]
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }
    res.status(200).json(publicUser(result.rows[0]));
    return;
  }

  return methodNotAllowed(res);
};
