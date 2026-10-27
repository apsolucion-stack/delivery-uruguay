// /api/stores — comercios y su catálogo de productos (fusionados).
// GET ?settings=public (público, sin login): devuelve SOLO driver_pct, para
//   que el cliente calcule el envío antes de crear el pedido.
// GET ?open=1 (público): comercios activos y abiertos AHORA (America/Montevideo),
//   con promedio de estrellas. No incluye comercios cerrados.
// GET ?id= (público): un comercio + si está abierto ahora.
// GET ?mine=1 (comercio): el propio comercio.
// POST (comercio): crea su comercio (uno por usuario).
// PUT (comercio): edita su propio comercio.
// GET ?products=1&store_id= (público): catálogo del comercio, SOLO si está
//   abierto ahora. GET ?products=1&mine=1 (comercio): su catálogo completo.
// POST ?products=1 (comercio): agrega un producto a su comercio.
// PUT ?products=1&id= (comercio): edita su propio producto (incluye activar/desactivar).
// Las fotos son data URL JPEG (el cliente las comprime a máx 1200px antes de
// enviar, mismo patrón que las fotos de factura de Mis Taxis: sin servicio
// externo ni costo). Se rechazan fotos de más de 2.000.000 caracteres.

const { getPool, requireAuth, readBody, toNumber, methodNotAllowed, getMontevideoNow, isStoreOpen, timeToMinutes, getBalance } = require('./_db');

function validTime(t) {
  if (typeof t !== 'string') return false;
  const m = t.match(/^(\d{2}):(\d{2})$/);
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

function publicStore(row, now) {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    type: row.type,
    address: row.address,
    phone: row.phone,
    open_time: row.open_time,
    close_time: row.close_time,
    open_24h: row.open_24h,
    closed_weekdays: row.closed_weekdays,
    active: row.active,
    avg_stars: row.avg_stars !== undefined && row.avg_stars !== null ? Number(row.avg_stars) : null,
    ratings_count: row.ratings_count !== undefined && row.ratings_count !== null ? Number(row.ratings_count) : null,
    is_open: now ? isStoreOpen(row, now) : undefined,
  };
}

function publicProduct(row) {
  return {
    id: row.id,
    store_id: row.store_id,
    name: row.name,
    description: row.description,
    price: Number(row.price),
    photo: row.photo,
    active: row.active,
    created_at: row.created_at,
  };
}

async function getDriverPct(pool) {
  const r = await pool.query("SELECT value FROM settings WHERE key = 'driver_pct'");
  const n = Number(r.rows[0] ? r.rows[0].value : 0);
  return Number.isFinite(n) ? n : 0;
}

module.exports = async function handler(req, res) {
  const pool = getPool();

  // % de envío público (para el cálculo del cliente antes de pedir).
  if (req.method === 'GET' && req.query && req.query.settings === 'public') {
    res.status(200).json({ driver_pct: await getDriverPct(pool) });
    return;
  }

  // ---- Productos ----
  if (req.query && req.query.products === '1') {
    if (req.method === 'GET') {
      if (req.query.mine === '1') {
        const user = await requireAuth(req, res, ['comercio']);
        if (!user) return;
        const store = await pool.query('SELECT * FROM stores WHERE user_id = $1', [user.id]);
        if (!store.rows[0]) {
          res.status(404).json({ error: 'Todavía no creaste tu comercio' });
          return;
        }
        const result = await pool.query('SELECT * FROM products WHERE store_id = $1 ORDER BY name', [store.rows[0].id]);
        res.status(200).json(result.rows.map(publicProduct));
        return;
      }
      const storeId = req.query.store_id ? Number(req.query.store_id) : null;
      if (!storeId) {
        res.status(400).json({ error: 'Falta store_id' });
        return;
      }
      const store = await pool.query('SELECT * FROM stores WHERE id = $1', [storeId]);
      if (!store.rows[0]) {
        res.status(404).json({ error: 'Comercio no encontrado' });
        return;
      }
      const owner = await pool.query('SELECT active FROM users WHERE id = $1', [store.rows[0].user_id]);
      if (!owner.rows[0] || !owner.rows[0].active) {
        res.status(400).json({ error: 'El comercio está suspendido' });
        return;
      }
      const now = getMontevideoNow();
      if (!isStoreOpen(store.rows[0], now)) {
        res.status(400).json({ error: 'El comercio está cerrado ahora' });
        return;
      }
      // Sin saldo prepago, el catálogo no se ofrece (no recibe pedidos nuevos).
      const storeBalance = await getBalance(pool, 'store', storeId);
      if (!(storeBalance > 0)) {
        res.status(400).json({ error: 'El comercio no tiene saldo de créditos para recibir pedidos' });
        return;
      }
      const result = await pool.query(
        'SELECT * FROM products WHERE store_id = $1 AND active = TRUE ORDER BY name',
        [storeId]
      );
      res.status(200).json(result.rows.map(publicProduct));
      return;
    }
    if (req.method === 'POST') {
      const user = await requireAuth(req, res, ['comercio']);
      if (!user) return;
      const store = await pool.query('SELECT * FROM stores WHERE user_id = $1', [user.id]);
      if (!store.rows[0]) {
        res.status(404).json({ error: 'Todavía no creaste tu comercio' });
        return;
      }
      const body = readBody(req);
      const name = String(body.name || '').trim();
      const price = toNumber(body.price, null);
      const photo = body.photo !== undefined && body.photo !== null ? String(body.photo) : null;
      if (!name || price === null || price < 0) {
        res.status(400).json({ error: 'Faltan nombre o precio válido' });
        return;
      }
      if (photo && photo.length > 2000000) {
        res.status(400).json({ error: 'La foto es demasiado grande' });
        return;
      }
      const result = await pool.query(
        'INSERT INTO products (store_id, name, description, price, photo, active) VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING *',
        [store.rows[0].id, name, String(body.description || ''), price, photo]
      );
      res.status(201).json(publicProduct(result.rows[0]));
      return;
    }
    if (req.method === 'PUT') {
      const user = await requireAuth(req, res, ['comercio']);
      if (!user) return;
      const id = req.query.id ? Number(req.query.id) : null;
      if (!id) {
        res.status(400).json({ error: 'Falta id' });
        return;
      }
      const store = await pool.query('SELECT * FROM stores WHERE user_id = $1', [user.id]);
      if (!store.rows[0]) {
        res.status(404).json({ error: 'Todavía no creaste tu comercio' });
        return;
      }
      const current = await pool.query('SELECT * FROM products WHERE id = $1 AND store_id = $2', [id, store.rows[0].id]);
      if (!current.rows[0]) {
        res.status(404).json({ error: 'Producto no encontrado' });
        return;
      }
      const body = readBody(req);
      const price = body.price !== undefined ? toNumber(body.price, null) : Number(current.rows[0].price);
      if (price === null || price < 0) {
        res.status(400).json({ error: 'Precio inválido' });
        return;
      }
      const photo = body.photo !== undefined ? (body.photo ? String(body.photo) : null) : current.rows[0].photo;
      if (photo && photo.length > 2000000) {
        res.status(400).json({ error: 'La foto es demasiado grande' });
        return;
      }
      const result = await pool.query(
        'UPDATE products SET name = $1, description = $2, price = $3, photo = $4, active = $5 WHERE id = $6 RETURNING *',
        [
          String(body.name !== undefined ? body.name : current.rows[0].name).trim() || current.rows[0].name,
          String(body.description !== undefined ? body.description : current.rows[0].description),
          price,
          photo,
          body.active !== undefined ? body.active !== false : current.rows[0].active,
          id,
        ]
      );
      res.status(200).json(publicProduct(result.rows[0]));
      return;
    }
    return methodNotAllowed(res);
  }

  // ---- Comercios ----
  if (req.method === 'GET') {
    const now = getMontevideoNow();
    if (req.query && req.query.open === '1') {
      const result = await pool.query(
        `SELECT s.*, COALESCE(AVG(r.stars), 0) AS avg_stars, COUNT(r.id) AS ratings_count,
         COALESCE(MAX(cb.bal), 0) AS balance
         FROM stores s
         LEFT JOIN orders o ON o.store_id = s.id
         LEFT JOIN ratings r ON r.order_id = o.id AND r.target_type = 'store'
         LEFT JOIN (SELECT owner_id, SUM(amount) AS bal FROM credit_movements WHERE owner_type = 'store' GROUP BY owner_id) cb ON cb.owner_id = s.id
         JOIN users u ON u.id = s.user_id AND u.active = TRUE
         WHERE s.active = TRUE
         GROUP BY s.id ORDER BY s.name`
      );
      // Abierto ahora Y con saldo prepago > 0: sin saldo no recibe pedidos.
      const open = result.rows.filter((row) => isStoreOpen(row, now) && Number(row.balance) > 0);
      res.status(200).json(open.map((row) => publicStore(row, now)));
      return;
    }
    if (req.query && req.query.mine === '1') {
      const user = await requireAuth(req, res, ['comercio']);
      if (!user) return;
      const result = await pool.query('SELECT * FROM stores WHERE user_id = $1', [user.id]);
      if (!result.rows[0]) {
        res.status(404).json({ error: 'Todavía no creaste tu comercio' });
        return;
      }
      res.status(200).json(publicStore(result.rows[0], now));
      return;
    }
    if (req.query && req.query.id) {
      const result = await pool.query('SELECT * FROM stores WHERE id = $1', [Number(req.query.id)]);
      if (!result.rows[0]) {
        res.status(404).json({ error: 'Comercio no encontrado' });
        return;
      }
      res.status(200).json(publicStore(result.rows[0], now));
      return;
    }
    // Lista completa (admin).
    const admin = await requireAuth(req, res, ['admin']);
    if (!admin) return;
    const result = await pool.query('SELECT * FROM stores ORDER BY name');
    res.status(200).json(result.rows.map((row) => publicStore(row, now)));
    return;
  }

  if (req.method === 'POST') {
    const user = await requireAuth(req, res, ['comercio']);
    if (!user) return;
    const existing = await pool.query('SELECT id FROM stores WHERE user_id = $1', [user.id]);
    if (existing.rows[0]) {
      res.status(409).json({ error: 'Ya tenés un comercio creado' });
      return;
    }
    const body = readBody(req);
    const name = String(body.name || '').trim();
    const open24h = body.open_24h === true;
    const openTime = String(body.open_time || '09:00');
    const closeTime = String(body.close_time || '18:00');
    if (!name || !String(body.address || '').trim()) {
      res.status(400).json({ error: 'Faltan nombre o dirección' });
      return;
    }
    if (!open24h && (!validTime(openTime) || !validTime(closeTime))) {
      res.status(400).json({ error: 'Horario inválido (formato HH:MM)' });
      return;
    }
    const result = await pool.query(
      `INSERT INTO stores (user_id, name, type, address, phone, open_time, close_time, open_24h, closed_weekdays, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE) RETURNING *`,
      [user.id, name, String(body.type || 'otro'), String(body.address || ''), String(body.phone || user.phone || ''), openTime, closeTime, open24h, String(body.closed_weekdays || '')]
    );
    res.status(201).json(publicStore(result.rows[0], getMontevideoNow()));
    return;
  }

  if (req.method === 'PUT') {
    const user = await requireAuth(req, res, ['comercio']);
    if (!user) return;
    const current = await pool.query('SELECT * FROM stores WHERE user_id = $1', [user.id]);
    if (!current.rows[0]) {
      res.status(404).json({ error: 'Todavía no creaste tu comercio' });
      return;
    }
    const body = readBody(req);
    const open24h = body.open_24h !== undefined ? body.open_24h === true : current.rows[0].open_24h;
    const openTime = body.open_time !== undefined ? String(body.open_time) : current.rows[0].open_time;
    const closeTime = body.close_time !== undefined ? String(body.close_time) : current.rows[0].close_time;
    if (!open24h && (!validTime(openTime) || !validTime(closeTime))) {
      res.status(400).json({ error: 'Horario inválido (formato HH:MM)' });
      return;
    }
    const result = await pool.query(
      `UPDATE stores SET name = $1, type = $2, address = $3, phone = $4, open_time = $5,
       close_time = $6, open_24h = $7, closed_weekdays = $8, active = $9 WHERE id = $10 RETURNING *`,
      [
        String(body.name !== undefined ? body.name : current.rows[0].name).trim() || current.rows[0].name,
        String(body.type !== undefined ? body.type : current.rows[0].type),
        String(body.address !== undefined ? body.address : current.rows[0].address),
        String(body.phone !== undefined ? body.phone : current.rows[0].phone),
        openTime,
        closeTime,
        open24h,
        String(body.closed_weekdays !== undefined ? body.closed_weekdays : current.rows[0].closed_weekdays),
        body.active !== undefined ? body.active !== false : current.rows[0].active,
        current.rows[0].id,
      ]
    );
    res.status(200).json(publicStore(result.rows[0], getMontevideoNow()));
    return;
  }

  return methodNotAllowed(res);
};
