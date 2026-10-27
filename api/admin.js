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
      for (const row of result.rows) out[row.key] = Number(row.value);
      for (const k of PCT_KEYS) if (out[k] === undefined) out[k] = 0;
      if (out.low_balance_threshold === undefined) out.low_balance_threshold = 200;
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

  return methodNotAllowed(res);
};
