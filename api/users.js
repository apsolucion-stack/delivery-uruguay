// /api/users — registro público, perfil propio, disponibilidad y admin.
// POST (público): registra un comercio o un delivery.
//   ETAPA 1 (crear la cuenta): nombre, teléfono, PIN y vehículo (todos
//   obligatorios). NO se exigen datos de la empresa ni POS en el registro.
//   ETAPA 2 (después, desde el perfil del delivery): datos de la unipersonal
//   (RUT 12 dígitos, razón social, nombre de fantasía, domicilio fiscal,
//   actividad, fecha de inicio, teléfono/email empresa, Nº BPS) + POS.
//   Solo con la etapa 2 completa se puede poner en línea.
// GET ?customer=me (con Bearer de cliente): perfil + sus pedidos.
// PUT ?customer=me (cliente): edita teléfono, dirección, cédula (solo si está
//   vacía) y contraseña.
// GET ?me=1 (con Bearer staff): perfil propio + promedios + saldo pendiente.
// GET (admin): lista de usuarios (sin hashes ni sales), filtro ?role=.
// PUT ?online=1 (delivery): pone en línea / fuera de línea al propio delivery.
//   Ponerse en línea exige la etapa 2 completa (empresa + POS).
// PUT ?me=1 (staff): edita el propio perfil (delivery: empresa + POS).
// PUT ?id= (admin): suspender/reactivar { active: true|false }.
// Nunca se devuelve pin_hash ni pin_salt.

const { getPool, requireAuth, requireCustomerAuth, readBody, hashPin, newSalt, methodNotAllowed, getBalance, getLowThreshold, normalizeRUT, validateRUT, deliveryStage2Missing, toNumber } = require('./_db');

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    role: row.role,
    vehicle: row.vehicle,
    monotributo_rut: row.monotributo_rut,
    razon_social: row.razon_social,
    nombre_fantasia: row.nombre_fantasia,
    domicilio_fiscal: row.domicilio_fiscal,
    actividad: row.actividad,
    fecha_inicio_actividades: row.fecha_inicio_actividades,
    telefono_empresa: row.telefono_empresa,
    email_empresa: row.email_empresa,
    numero_bps: row.numero_bps,
    pos_provider: row.pos_provider,
    pos_terminal: row.pos_terminal,
    work_radius_km: row.work_radius_km !== undefined && row.work_radius_km !== null ? Number(row.work_radius_km) : 30,
    online: row.online,
    active: row.active,
    created_at: row.created_at,
  };
}

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
  };
}

function validEmail(email) {
  return /^\S+@\S+\.\S+$/.test(email);
}

function validDateOrEmpty(s) {
  if (s === '' || s === null || s === undefined) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const d = new Date(String(s) + 'T00:00:00Z');
  return !Number.isNaN(d.getTime());
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
    // ETAPA 1: todos obligatorios (nombre, teléfono, PIN y vehículo).
    // Empresa y POS van en la etapa 2, desde el perfil.
    const vehicle = role === 'delivery' ? String(body.vehicle || '').trim() : null;
    if (role === 'delivery' && !vehicle) {
      res.status(400).json({ error: 'Falta el vehículo' });
      return;
    }
    const salt = newSalt();
    try {
      const result = await pool.query(
        `INSERT INTO users (name, phone, role, pin_hash, pin_salt, vehicle, active)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING *`,
        [name, phone, role, hashPin(pin, salt), salt, vehicle]
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
    // Perfil propio del cliente + su historial de pedidos.
    if (req.query && req.query.customer === 'me') {
      const me = await requireCustomerAuth(req, res);
      if (!me) return;
      const orders = await pool.query(
        `SELECT o.*, s.name AS store_name FROM orders o
         JOIN stores s ON s.id = o.store_id
         WHERE o.customer_id = $1 ORDER BY o.created_at DESC`,
        [me.id]
      );
      const out = publicCustomer(me);
      out.profile_complete = !!(me.ci && String(me.phone || '').trim() && String(me.default_address || '').trim());
      out.orders = orders.rows.map((o) => ({
        id: o.id,
        store_id: o.store_id,
        store_name: o.store_name,
        status: o.status,
        items: o.items,
        merchandise_value: Number(o.merchandise_value),
        delivery_fee: Number(o.delivery_fee),
        total: Number(o.total),
        confirmed_total: o.confirmed_total !== null ? Number(o.confirmed_total) : null,
        created_at: o.created_at,
      }));
      res.status(200).json(out);
      return;
    }
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
        const missing = deliveryStage2Missing(user);
        out.stage2_missing = missing;
        out.stage2_complete = missing.length === 0;
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
    // Editar perfil propio del cliente (teléfono, dirección, cédula solo si
    // está vacía, y contraseña).
    if (req.query && req.query.customer === 'me') {
      const me = await requireCustomerAuth(req, res);
      if (!me) return;
      const body = readBody(req);
      const sets = [];
      const params = [];
      const push = (col, val) => { params.push(val); sets.push(col + ' = $' + params.length); };
      if (body.phone !== undefined) {
        const phone = String(body.phone || '').trim();
        if (!phone) { res.status(400).json({ error: 'El teléfono no puede quedar vacío' }); return; }
        push('phone', phone);
      }
      if (body.default_address !== undefined) push('default_address', String(body.default_address || '').trim());
      if (body.full_name !== undefined) {
        const fn = String(body.full_name || '').trim();
        if (fn) push('full_name', fn);
      }
      if (body.ci !== undefined) {
        const { normalizeCI: normCI, validateCI: validCI } = require('./_db');
        const ci = normCI(body.ci);
        if (me.ci) {
          if (ci !== me.ci) { res.status(400).json({ error: 'La cédula ya está registrada y no se puede cambiar' }); return; }
        } else {
          if (!validCI(ci)) { res.status(400).json({ error: 'La cédula no es válida (8 dígitos con dígito verificador)' }); return; }
          push('ci', ci);
        }
      }
      if (body.password !== undefined && body.password !== null && String(body.password) !== '') {
        if (String(body.password).length < 6) { res.status(400).json({ error: 'La contraseña nueva debe tener al menos 6 caracteres' }); return; }
        const { hashPassword: hp } = require('./_db');
        push('password_hash', hp(body.password));
      }
      if (!sets.length) {
        res.status(400).json({ error: 'Nada para actualizar' });
        return;
      }
      try {
        params.push(me.id);
        const result = await pool.query(
          'UPDATE customers SET ' + sets.join(', ') + ' WHERE id = $' + params.length + ' RETURNING *',
          params
        );
        const out = publicCustomer(result.rows[0]);
        out.profile_complete = !!(result.rows[0].ci && String(result.rows[0].phone || '').trim() && String(result.rows[0].default_address || '').trim());
        res.status(200).json(out);
      } catch (e) {
        if (e && e.code === '23505') { res.status(409).json({ error: 'Ya existe un cliente con esa cédula' }); return; }
        throw e;
      }
      return;
    }
    // Disponibilidad del propio delivery.
    if (req.query && req.query.online === '1') {
      const user = await requireAuth(req, res, ['delivery']);
      if (!user) return;
      const body = readBody(req);
      const online = body.online === true;
      if (online) {
        const missing = deliveryStage2Missing(user);
        if (missing.length) {
          res.status(400).json({ error: 'Para ponerte en línea completá los datos de tu empresa: faltan ' + missing.join(', ') });
          return;
        }
      }
      const result = await pool.query(
        'UPDATE users SET online = $1 WHERE id = $2 RETURNING *',
        [online, user.id]
      );
      res.status(200).json(publicUser(result.rows[0]));
      return;
    }
    // Editar el propio perfil staff (delivery: empresa + POS; todos: teléfono).
    if (req.query && req.query.me === '1') {
      const user = await requireAuth(req, res, null);
      if (!user) return;
      const body = readBody(req);
      const sets = [];
      const params = [];
      const push = (col, val) => { params.push(val); sets.push(col + ' = $' + params.length); };
      const optText = (v) => {
        const s = String(v === undefined || v === null ? '' : v).trim();
        return s === '' ? null : s;
      };
      if (body.phone !== undefined) {
        const phone = String(body.phone || '').trim();
        if (!phone) { res.status(400).json({ error: 'El teléfono no puede quedar vacío' }); return; }
        push('phone', phone);
      }
      if (user.role === 'delivery') {
        if (body.vehicle !== undefined) push('vehicle', optText(body.vehicle));
        if (body.monotributo_rut !== undefined) {
          const rut = normalizeRUT(body.monotributo_rut);
          if (rut !== '' && !validateRUT(rut)) { res.status(400).json({ error: 'El RUT debe tener exactamente 12 dígitos' }); return; }
          push('monotributo_rut', rut === '' ? null : rut);
        }
        if (body.razon_social !== undefined) push('razon_social', optText(body.razon_social));
        if (body.nombre_fantasia !== undefined) push('nombre_fantasia', optText(body.nombre_fantasia));
        if (body.domicilio_fiscal !== undefined) push('domicilio_fiscal', optText(body.domicilio_fiscal));
        if (body.actividad !== undefined) push('actividad', optText(body.actividad));
        if (body.fecha_inicio_actividades !== undefined) {
          if (!validDateOrEmpty(body.fecha_inicio_actividades)) { res.status(400).json({ error: 'La fecha de inicio debe ser AAAA-MM-DD' }); return; }
          push('fecha_inicio_actividades', body.fecha_inicio_actividades === '' ? null : String(body.fecha_inicio_actividades));
        }
        if (body.telefono_empresa !== undefined) push('telefono_empresa', optText(body.telefono_empresa));
        if (body.email_empresa !== undefined) {
          const em = optText(body.email_empresa);
          if (em && !validEmail(em)) { res.status(400).json({ error: 'El email de la empresa no es válido' }); return; }
          push('email_empresa', em);
        }
        if (body.numero_bps !== undefined) push('numero_bps', optText(body.numero_bps));
        if (body.pos_provider !== undefined) push('pos_provider', optText(body.pos_provider));
        if (body.pos_terminal !== undefined) push('pos_terminal', optText(body.pos_terminal));
        if (body.work_radius_km !== undefined) {
          const r = Math.floor(toNumber(body.work_radius_km, NaN));
          if (!Number.isFinite(r) || r < 1 || r > 200) { res.status(400).json({ error: 'El radio de trabajo debe ser entre 1 y 200 km' }); return; }
          push('work_radius_km', r);
        }
      }
      if (!sets.length) {
        res.status(400).json({ error: 'Nada para actualizar' });
        return;
      }
      params.push(user.id);
      const result = await pool.query(
        'UPDATE users SET ' + sets.join(', ') + ' WHERE id = $' + params.length + ' RETURNING *',
        params
      );
      const out = publicUser(result.rows[0]);
      if (result.rows[0].role === 'delivery') {
        const missing = deliveryStage2Missing(result.rows[0]);
        out.stage2_missing = missing;
        out.stage2_complete = missing.length === 0;
      }
      res.status(200).json(out);
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
