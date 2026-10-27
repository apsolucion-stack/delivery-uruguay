// /api/admin — solo admin (dueño de la plataforma).
// Modelo de cobro PREPAGO con créditos (reemplaza cualquier saldo a liquidar):
// el admin carga créditos a deliveries y comercios después de cobrar por fuera
// (transferencia o efectivo); cada entrega completada descuenta automáticamente
// los dos cortes de plataforma de esos saldos.
// GET ?settings=1: ajustes actuales + advertencia si algún % está en 0.
// PUT ?settings=1: { driver_pct, platform_driver_pct, store_pct } (0 a 100)
//   y { low_balance_threshold } ($U, >= 0, por defecto 200).
//   driver_pct: % de la mercadería que gana el delivery (= precio del envío).
//   platform_driver_pct: % de la ganancia del delivery para la plataforma.
//   store_pct: % de la venta del comercio para la plataforma.
//   Nacen en 0 (umbral en 200) y el admin DEBE configurar los % antes de operar.
// GET ?balances=1: saldo prepago por delivery y por comercio
//   (SUM de credit_movements), con aviso si está por debajo del umbral.
// GET ?movements=1&owner_type=&owner_id=: movimientos de un sujeto.
// POST ?credit=1: { owner_type: 'driver'|'store', owner_id, amount (>0), note }
//   carga créditos (el admin ya cobró por fuera).

const { getPool, requireAuth, readBody, toNumber, methodNotAllowed, getBalance, getLowThreshold } = require('./_db');

const PCT_KEYS = ['driver_pct', 'platform_driver_pct', 'store_pct'];

module.exports = async function handler(req, res) {
  const pool = getPool();
  const admin = await requireAuth(req, res, ['admin']);
  if (!admin) return;

  if (req.query && req.query.settings === '1') {
    if (req.method === 'GET') {
      const result = await pool.query('SELECT key, value FROM settings ORDER BY key');
      const out = {};
      for (const row of result.rows) {
        // google_client_id es texto (un ID tipo xxx.apps.googleusercontent.com),
        // no un número: no pasarlo por Number().
        out[row.key] = row.key === 'google_client_id' ? String(row.value || '') : Number(row.value);
      }
      for (const k of PCT_KEYS) if (out[k] === undefined) out[k] = 0;
      if (out.low_balance_threshold === undefined) out.low_balance_threshold = 200;
      if (out.google_client_id === undefined) out.google_client_id = '';
      out.warning_zero = PCT_KEYS.some((k) => !(out[k] > 0));
      res.status(200).json(out);
      return;
    }
    if (req.method === 'PUT') {
      const body = readBody(req);
      for (const k of PCT_KEYS) {
        if (body[k] === undefined) continue;
        const n = toNumber(body[k], null);
        if (n === null || n < 0 || n > 100) {
          res.status(400).json({ error: 'Porcentaje inválido para ' + k + ' (0 a 100)' });
          return;
        }
        await pool.query(
          'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
          [k, String(n)]
        );
      }
      if (body.low_balance_threshold !== undefined) {
        const n = toNumber(body.low_balance_threshold, null);
        if (n === null || n < 0) {
          res.status(400).json({ error: 'Umbral de poco saldo inválido' });
          return;
        }
        await pool.query(
          "INSERT INTO settings (key, value) VALUES ('low_balance_threshold', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
          [String(n)]
        );
      }
      if (body.google_client_id !== undefined) {
        await pool.query(
          "INSERT INTO settings (key, value) VALUES ('google_client_id', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
          [String(body.google_client_id || '').trim()]
        );
      }
      const result = await pool.query('SELECT key, value FROM settings ORDER BY key');
      const out = {};
      for (const row of result.rows) out[row.key] = Number(row.value);
      res.status(200).json(out);
      return;
    }
    return methodNotAllowed(res);
  }

  if (req.query && req.query.balances === '1') {
    if (req.method !== 'GET') return methodNotAllowed(res);
    const threshold = await getLowThreshold(pool);
    const drivers = await pool.query(
      `SELECT u.id, u.name, u.phone, COALESCE(SUM(c.amount), 0) AS balance
       FROM users u LEFT JOIN credit_movements c ON c.owner_type = 'driver' AND c.owner_id = u.id
       WHERE u.role = 'delivery' GROUP BY u.id ORDER BY u.name`
    );
    const stores = await pool.query(
      `SELECT s.id, s.name, s.phone, COALESCE(SUM(c.amount), 0) AS balance
       FROM stores s LEFT JOIN credit_movements c ON c.owner_type = 'store' AND c.owner_id = s.id
       GROUP BY s.id ORDER BY s.name`
    );
    const map = (rows) => rows.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      balance: Number(r.balance),
      low: Number(r.balance) < threshold,
    }));
    res.status(200).json({ threshold, drivers: map(drivers.rows), stores: map(stores.rows) });
    return;
  }

  if (req.query && req.query.movements === '1') {
    if (req.method !== 'GET') return methodNotAllowed(res);
    const ownerType = String(req.query.owner_type || '');
    const ownerId = Number(req.query.owner_id);
    if ((ownerType !== 'driver' && ownerType !== 'store') || !ownerId) {
      res.status(400).json({ error: 'Faltan owner_type u owner_id' });
      return;
    }
    const result = await pool.query(
      'SELECT * FROM credit_movements WHERE owner_type = $1 AND owner_id = $2 ORDER BY created_at DESC LIMIT 200',
      [ownerType, ownerId]
    );
    res.status(200).json(result.rows);
    return;
  }

  if (req.query && req.query.credit === '1') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    const body = readBody(req);
    const ownerType = String(body.owner_type || '');
    const ownerId = Number(body.owner_id);
    const amount = toNumber(body.amount, null);
    if ((ownerType !== 'driver' && ownerType !== 'store') || !ownerId || amount === null || amount <= 0) {
      res.status(400).json({ error: 'Faltan tipo, sujeto o monto válido mayor a 0' });
      return;
    }
    if (ownerType === 'driver') {
      const u = await pool.query("SELECT id FROM users WHERE id = $1 AND role = 'delivery'", [ownerId]);
      if (!u.rows[0]) {
        res.status(404).json({ error: 'Delivery no encontrado' });
        return;
      }
    } else {
      const s = await pool.query('SELECT id FROM stores WHERE id = $1', [ownerId]);
      if (!s.rows[0]) {
        res.status(404).json({ error: 'Comercio no encontrado' });
        return;
      }
    }
    const result = await pool.query(
      'INSERT INTO credit_movements (owner_type, owner_id, amount, reason, order_id) VALUES ($1, $2, $3, $4, NULL) RETURNING *',
      [ownerType, ownerId, amount, 'Carga de créditos — ' + String(body.note || 'cobro por fuera')]
    );
    res.status(201).json(result.rows[0]);
    return;
  }

  // ---- Clientes (admin): lista + activar/desactivar ----
  if (req.query && req.query.customers === '1') {
    if (req.method === 'GET') {
      const result = await pool.query(
        `SELECT id, full_name, ci, email, phone, default_address, active, created_at,
         (google_sub IS NOT NULL) AS google_linked FROM customers ORDER BY full_name`
      );
      res.status(200).json(result.rows.map((r) => ({
        id: r.id,
        full_name: r.full_name,
        ci: r.ci,
        email: r.email,
        phone: r.phone,
        default_address: r.default_address,
        active: r.active,
        created_at: r.created_at,
        google_linked: r.google_linked,
      })));
      return;
    }
    if (req.method === 'PUT') {
      const id = Number(req.query.id);
      if (!id) {
        res.status(400).json({ error: 'Falta id' });
        return;
      }
      const body = readBody(req);
      const result = await pool.query(
        'UPDATE customers SET active = $1 WHERE id = $2 RETURNING id, full_name, ci, email, phone, active',
        [body.active !== false, id]
      );
      if (!result.rows[0]) {
        res.status(404).json({ error: 'Cliente no encontrado' });
        return;
      }
      res.status(200).json(result.rows[0]);
      return;
    }
    return methodNotAllowed(res);
  }

  // ---- Reportes (admin): sin cambios de schema ----
  if (req.query && req.query.reports === '1') {
    if (req.method !== 'GET') return methodNotAllowed(res);
    const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    const toDefault = new Date(Date.now() - 0);
    const fromDefault = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const to = isDate(req.query.to) ? String(req.query.to) : toDefault.toISOString().slice(0, 10);
    const from = isDate(req.query.from) ? String(req.query.from) : fromDefault;
    const toPlus1 = new Date(new Date(to + 'T00:00:00Z').getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const storeId = req.query.store_id ? Number(req.query.store_id) : null;
    const driverId = req.query.driver_id ? Number(req.query.driver_id) : null;
    // Filtros de pedidos (por comercio y/o delivery).
    const orderWhere = ['o.delivered_at >= $1', 'o.delivered_at < $2'];
    const orderParams = [from + 'T00:00:00Z', toPlus1 + 'T00:00:00Z'];
    if (storeId) { orderParams.push(storeId); orderWhere.push('o.store_id = $' + orderParams.length); }
    if (driverId) { orderParams.push(driverId); orderWhere.push('o.driver_id = $' + orderParams.length); }
    const deliveredWhere = "o.status = 'entregado' AND " + orderWhere.join(' AND ');
    const totals = await pool.query(
      `SELECT COUNT(*) AS delivered_count,
       COALESCE(SUM(COALESCE(o.confirmed_value, o.merchandise_value)), 0) AS merchandise,
       COALESCE(SUM(COALESCE(o.confirmed_delivery_fee, o.delivery_fee)), 0) AS delivery_fees,
       COALESCE(SUM(o.driver_earning), 0) AS driver_earnings,
       COALESCE(SUM(o.platform_from_driver), 0) AS platform_from_driver,
       COALESCE(SUM(o.platform_from_store), 0) AS platform_from_store
       FROM orders o WHERE ${deliveredWhere}`,
      orderParams
    );
    // Créditos del período (cargados y descontados). Si hay filtro de comercio
    // y/o delivery, se limita a esos sujetos; si no, es el total general.
    const creditWhere = ['c.created_at >= $1', 'c.created_at < $2'];
    const creditParams = [from + 'T00:00:00Z', toPlus1 + 'T00:00:00Z'];
    const subjectClauses = [];
    if (storeId) { creditParams.push(storeId); subjectClauses.push("(c.owner_type = 'store' AND c.owner_id = $" + creditParams.length + ')'); }
    if (driverId) { creditParams.push(driverId); subjectClauses.push("(c.owner_type = 'driver' AND c.owner_id = $" + creditParams.length + ')'); }
    if (subjectClauses.length) creditWhere.push('(' + subjectClauses.join(' OR ') + ')');
    const credits = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN c.amount > 0 THEN c.amount ELSE 0 END), 0) AS loaded,
       COALESCE(SUM(CASE WHEN c.amount < 0 THEN -c.amount ELSE 0 END), 0) AS deducted
       FROM credit_movements c WHERE ${creditWhere.join(' AND ')}`,
      creditParams
    );
    const byStore = await pool.query(
      `SELECT s.id, s.name, COUNT(*) AS orders,
       COALESCE(SUM(COALESCE(o.confirmed_value, o.merchandise_value)), 0) AS merchandise,
       COALESCE(SUM(o.platform_from_store), 0) AS platform_cut
       FROM orders o JOIN stores s ON s.id = o.store_id
       WHERE ${deliveredWhere} GROUP BY s.id, s.name ORDER BY s.name`,
      orderParams
    );
    const byDriver = await pool.query(
      `SELECT d.id, d.name, COUNT(*) AS orders,
       COALESCE(SUM(COALESCE(o.confirmed_value, o.merchandise_value)), 0) AS merchandise,
       COALESCE(SUM(o.driver_earning), 0) AS earnings,
       COALESCE(SUM(o.platform_from_driver), 0) AS platform_cut
       FROM orders o JOIN users d ON d.id = o.driver_id
       WHERE ${deliveredWhere} AND o.driver_id IS NOT NULL GROUP BY d.id, d.name ORDER BY d.name`,
      orderParams
    );
    // Tabla de pedidos del período (por fecha de creación, con estado).
    const tableWhere = ['o.created_at >= $1', 'o.created_at < $2'];
    const tableParams = [from + 'T00:00:00Z', toPlus1 + 'T00:00:00Z'];
    if (storeId) { tableParams.push(storeId); tableWhere.push('o.store_id = $' + tableParams.length); }
    if (driverId) { tableParams.push(driverId); tableWhere.push('o.driver_id = $' + tableParams.length); }
    const table = await pool.query(
      `SELECT o.id, o.store_id, s.name AS store_name, o.customer_name, o.status,
       COALESCE(o.confirmed_total, o.total) AS total, o.created_at, o.delivered_at
       FROM orders o JOIN stores s ON s.id = o.store_id
       WHERE ${tableWhere.join(' AND ')} ORDER BY o.created_at DESC LIMIT 500`,
      tableParams
    );
    const t = totals.rows[0];
    const c = credits.rows[0];
    res.status(200).json({
      from,
      to,
      totals: {
        delivered_count: Number(t.delivered_count),
        merchandise: Number(t.merchandise),
        delivery_fees: Number(t.delivery_fees),
        driver_earnings: Number(t.driver_earnings),
        platform_from_driver: Number(t.platform_from_driver),
        platform_from_store: Number(t.platform_from_store),
        credits_loaded: Number(c.loaded),
        credits_deducted: Number(c.deducted),
      },
      by_store: byStore.rows.map((r) => ({
        id: r.id, name: r.name, orders: Number(r.orders),
        merchandise: Number(r.merchandise), platform_cut: Number(r.platform_cut),
      })),
      by_driver: byDriver.rows.map((r) => ({
        id: r.id, name: r.name, orders: Number(r.orders),
        merchandise: Number(r.merchandise), earnings: Number(r.earnings),
        platform_cut: Number(r.platform_cut),
      })),
      orders: table.rows.map((r) => ({
        id: r.id, store_id: r.store_id, store_name: r.store_name,
        customer_name: r.customer_name, status: r.status,
        total: Number(r.total), created_at: r.created_at, delivered_at: r.delivered_at,
      })),
    });
    return;
  }

  return methodNotAllowed(res);
};
