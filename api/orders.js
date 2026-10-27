// /api/orders — pedidos, seguimiento público y calificaciones (fusionados).
// POST (público): crea un pedido en un comercio ABIERTO ahora.
//   Body: { store_id, customer_name, customer_phone, delivery_address,
//     lines: [{ product_id, qty }], otros_text, otros_value }.
//   Si viene token de cliente, prellena nombre/teléfono/dirección y vincula
//   customer_id (el cliente debe tener el perfil completo); sin token el
//   pedido es de invitado (customer_id NULL).
//   merchandise_value = suma de líneas del catálogo (precios congelados desde
//     la DB) + valor estimado de "otros" (0 si no viene).
//   delivery_fee = driver_pct% × merchandise_value (snapshot con el % vigente).
//   total = merchandise_value + delivery_fee. El pedido nace 'disponible'.
// GET ?track=1&id= (público, sin login): seguimiento + líneas (con item_status)
//   + totales (si hay confirmado, muestra el total actualizado) + teléfonos de
//   las partes tras la aceptación + si ya se calificó cada destino.
// GET (con Bearer): admin ve todos; comercio ve los de su comercio; delivery
//   ve los suyos + con ?available=1 los 'disponible' (solo si está en línea);
//   cliente ve solo los suyos (por customer_id).
// PUT ?id= (con Bearer): acciones { action }:
//   accept (delivery en línea): atómico — si 0 filas, ya lo tomó otro.
//   pickup (delivery dueño, desde 'aceptado'): el confirmed_value se calcula
//     SOLO con las líneas 'levantado' del checklist (price_snapshot × qty);
//     todas las líneas deben estar resueltas (levantado o sin_stock) y al menos
//     una levantada. De ahí confirmed_delivery_fee, confirmed_total, ganancia
//     y cortes. "Cobrar al cliente" = confirmado + ganancia.
//   deliver (delivery dueño, desde 'retirado'): { collected_amount? }.
//   cancel (admin cualquiera salvo entregado; comercio propio en
//     disponible/aceptado; delivery propio solo en aceptado; motivo opcional
//     en cancel_reason, ej. "todo sin stock").
// PUT ?item=1&id= (delivery dueño, pedido 'aceptado'): marca una línea del
//   checklist { item_id, status: pendiente|levantado|sin_stock }. Marcar
//   sin_stock pone el producto en out_of_stock (el comercio lo reactiva).
// PUT ?ready=1&id= (comercio dueño, pedido 'aceptado'): { store_ready } —
//   "Pedido armado y listo", NO cambia el estado del pedido.
// POST ?rate=1 (público): califica un pedido 'entregado' con 1-5 estrellas
//   al comercio y/o al delivery, una vez por destino por pedido.
// Los saldos de plataforma se cuentan solo sobre pedidos 'entregado'.

const { getPool, requireAuth, verifyToken, readBody, toNumber, round2, methodNotAllowed, getMontevideoNow, isStoreOpen, getBalance, haversineKm, validCoords } = require('./_db');

async function getSettings(pool) {
  const r = await pool.query('SELECT key, value FROM settings');
  const out = { driver_pct: 0, platform_driver_pct: 0, store_pct: 0 };
  for (const row of r.rows) {
    const n = Number(row.value);
    if (Number.isFinite(n) && out[row.key] !== undefined) out[row.key] = n;
  }
  return out;
}

function publicOrder(row) {
  return {
    id: row.id,
    store_id: row.store_id,
    store_name: row.store_name || null,
    customer_id: row.customer_id || null,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    delivery_address: row.delivery_address,
    items: row.items,
    merchandise_value: Number(row.merchandise_value),
    delivery_fee: Number(row.delivery_fee),
    total: Number(row.total),
    confirmed_value: row.confirmed_value !== null && row.confirmed_value !== undefined ? Number(row.confirmed_value) : null,
    confirmed_delivery_fee: row.confirmed_delivery_fee !== null && row.confirmed_delivery_fee !== undefined ? Number(row.confirmed_delivery_fee) : null,
    confirmed_total: row.confirmed_total !== null && row.confirmed_total !== undefined ? Number(row.confirmed_total) : null,
    collected_amount: row.collected_amount !== null && row.collected_amount !== undefined ? Number(row.collected_amount) : null,
    status: row.status,
    driver_id: row.driver_id,
    driver_name: row.driver_name || null,
    driver_phone: row.driver_phone || null,
    store_phone: row.store_phone || null,
    distance_km: row.distance_km !== undefined && row.distance_km !== null ? Number(row.distance_km) : null,
    store_ready: !!row.store_ready,
    cancel_reason: row.cancel_reason || null,
    driver_earning: Number(row.driver_earning),
    platform_from_driver: Number(row.platform_from_driver),
    platform_from_store: Number(row.platform_from_store),
    created_at: row.created_at,
    accepted_at: row.accepted_at,
    picked_at: row.picked_at,
    delivered_at: row.delivered_at,
  };
}

const ORDER_SELECT = `
  SELECT o.*, s.name AS store_name, s.phone AS store_phone, s.lat AS store_lat, s.lng AS store_lng,
         d.name AS driver_name, d.phone AS driver_phone
  FROM orders o
  JOIN stores s ON s.id = o.store_id
  LEFT JOIN users d ON d.id = o.driver_id
`;

module.exports = async function handler(req, res) {
  const pool = getPool();

  // ---- Calificar (público, sin login, desde el seguimiento) ----
  if (req.method === 'POST' && req.query && req.query.rate === '1') {
    const body = readBody(req);
    const orderId = Number(body.order_id);
    if (!orderId) {
      res.status(400).json({ error: 'Falta order_id' });
      return;
    }
    const order = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (!order.rows[0]) {
      res.status(404).json({ error: 'Pedido no encontrado' });
      return;
    }
    if (order.rows[0].status !== 'entregado') {
      res.status(400).json({ error: 'Solo se puede calificar un pedido entregado' });
      return;
    }
    const out = { rated_store: false, rated_driver: false };
    const jobs = [];
    const storeStars = toNumber(body.store_stars, null);
    const driverStars = toNumber(body.driver_stars, null);
    const comment = String(body.comment || '');
    if (storeStars !== null && storeStars >= 1 && storeStars <= 5) {
      jobs.push(pool.query(
        'INSERT INTO ratings (order_id, target_type, stars, comment) VALUES ($1, \'store\', $2, $3) ON CONFLICT (order_id, target_type) DO NOTHING',
        [orderId, Math.round(storeStars), comment]
      ).then(() => { out.rated_store = true; }));
    }
    if (driverStars !== null && driverStars >= 1 && driverStars <= 5) {
      jobs.push(pool.query(
        'INSERT INTO ratings (order_id, target_type, stars, comment) VALUES ($1, \'driver\', $2, $3) ON CONFLICT (order_id, target_type) DO NOTHING',
        [orderId, Math.round(driverStars), comment]
      ).then(() => { out.rated_driver = true; }));
    }
    if (!jobs.length) {
      res.status(400).json({ error: 'Faltan estrellas (1 a 5)' });
      return;
    }
    await Promise.all(jobs);
    res.status(200).json(out);
    return;
  }

  // ---- Crear pedido (público) ----
  if (req.method === 'POST') {
    const body = readBody(req);
    const storeId = Number(body.store_id);
    // Cliente logueado (opcional): prellena y vincula customer_id. Sin token
    // el pedido es de invitado. Con perfil incompleto no puede pedir.
    let customerId = null;
    let customerProfile = null;
    const payload = verifyToken(req);
    if (payload && payload.role === 'customer') {
      const c = await pool.query('SELECT * FROM customers WHERE id = $1', [payload.userId]);
      if (c.rows[0] && c.rows[0].active) {
        customerProfile = c.rows[0];
        customerId = c.rows[0].id;
        if (!(customerProfile.ci && String(customerProfile.phone || '').trim() && String(customerProfile.default_address || '').trim())) {
          res.status(400).json({ error: 'Completá tus datos de cliente (cédula, teléfono y dirección) en Mi cuenta antes de pedir.' });
          return;
        }
      }
    }
    let customerName = String(body.customer_name || '').trim();
    let customerPhone = String(body.customer_phone || '').trim();
    let deliveryAddress = String(body.delivery_address || '').trim();
    if (customerProfile) {
      if (!customerName) customerName = customerProfile.full_name;
      if (!customerPhone) customerPhone = customerProfile.phone;
      if (!deliveryAddress) deliveryAddress = customerProfile.default_address;
    }
    const otrosText = String(body.otros_text || body.otros || '').trim();
    const otrosValue = Math.max(0, toNumber(body.otros_value, 0) || 0);
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (!storeId || !customerName || !customerPhone || !deliveryAddress) {
      res.status(400).json({ error: 'Faltan comercio, nombre, teléfono o dirección de entrega' });
      return;
    }
    const store = await pool.query('SELECT * FROM stores WHERE id = $1', [storeId]);
    if (!store.rows[0] || !store.rows[0].active) {
      res.status(404).json({ error: 'Comercio no encontrado' });
      return;
    }
    const owner = await pool.query('SELECT active FROM users WHERE id = $1', [store.rows[0].user_id]);
    if (!owner.rows[0] || !owner.rows[0].active) {
      res.status(400).json({ error: 'El comercio está suspendido' });
      return;
    }
    if (!isStoreOpen(store.rows[0], getMontevideoNow())) {
      res.status(400).json({ error: 'El comercio está cerrado ahora' });
      return;
    }
    if (store.rows[0].paused) {
      res.status(400).json({ error: 'El comercio está pausado temporalmente' });
      return;
    }
    // Sin saldo prepago, el comercio no recibe pedidos nuevos.
    const storeBalance = await getBalance(pool, 'store', storeId);
    if (!(storeBalance > 0)) {
      res.status(400).json({ error: 'El comercio no tiene saldo de créditos para recibir pedidos' });
      return;
    }
    // Líneas del catálogo con precios congelados desde la DB.
    let subtotal = 0;
    const itemsRows = [];
    const itemsTextParts = [];
    for (const line of lines) {
      const productId = Number(line.product_id);
      const qty = Math.floor(toNumber(line.qty, 0) || 0);
      if (!productId || qty <= 0) continue;
      const prod = await pool.query('SELECT * FROM products WHERE id = $1 AND store_id = $2 AND active = TRUE', [productId, storeId]);
      if (!prod.rows[0]) {
        res.status(400).json({ error: 'Un producto del pedido no existe o no está activo' });
        return;
      }
      const price = Number(prod.rows[0].price);
      subtotal = round2(subtotal + price * qty);
      itemsRows.push({ product_id: productId, name_snapshot: prod.rows[0].name, price_snapshot: price, qty });
      itemsTextParts.push(qty + 'x ' + prod.rows[0].name + ' ($U ' + price.toFixed(2) + ')');
    }
    if (otrosText) {
      itemsRows.push({ product_id: null, name_snapshot: 'Otros: ' + otrosText, price_snapshot: round2(otrosValue), qty: 1 });
      itemsTextParts.push('Otros: ' + otrosText + (otrosValue > 0 ? ' ($U ' + otrosValue.toFixed(2) + ' estimado)' : ''));
    }
    if (!itemsRows.length) {
      res.status(400).json({ error: 'El pedido está vacío: elegí productos o escribí en "otros"' });
      return;
    }
    subtotal = round2(subtotal + otrosValue);
    const settings = await getSettings(pool);
    const deliveryFee = round2((settings.driver_pct / 100) * subtotal);
    const total = round2(subtotal + deliveryFee);
    const itemsText = itemsTextParts.join('; ');
    const created = await pool.query(
      `INSERT INTO orders (store_id, customer_id, customer_name, customer_phone, delivery_address, items,
       merchandise_value, delivery_fee, total, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'disponible') RETURNING *`,
      [storeId, customerId, customerName, customerPhone, deliveryAddress, itemsText, subtotal, deliveryFee, total]
    );
    for (const row of itemsRows) {
      await pool.query(
        'INSERT INTO order_items (order_id, product_id, name_snapshot, price_snapshot, qty) VALUES ($1, $2, $3, $4, $5)',
        [created.rows[0].id, row.product_id, row.name_snapshot, row.price_snapshot, row.qty]
      );
    }
    const full = await pool.query(ORDER_SELECT + ' WHERE o.id = $1', [created.rows[0].id]);
    res.status(201).json(publicOrder(full.rows[0]));
    return;
  }

  // ---- Seguimiento público ----
  if (req.method === 'GET' && req.query && req.query.track === '1') {
    const id = Number(req.query.id);
    if (!id) {
      res.status(400).json({ error: 'Falta id' });
      return;
    }
    const result = await pool.query(ORDER_SELECT + ' WHERE o.id = $1', [id]);
    if (!result.rows[0]) {
      res.status(404).json({ error: 'Pedido no encontrado' });
      return;
    }
    const items = await pool.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [id]);
    const rated = await pool.query('SELECT target_type FROM ratings WHERE order_id = $1', [id]);
    const order = publicOrder(result.rows[0]);
    // Teléfonos solo tras la aceptación (para coordinar por WhatsApp).
    // El teléfono del cliente NUNCA se expone en el seguimiento público.
    order.customer_phone = null;
    if (order.status === 'disponible') {
      order.driver_phone = null;
    }
    order.lines = items.rows.map((r) => ({
      id: r.id,
      product_id: r.product_id,
      name: r.name_snapshot,
      price: Number(r.price_snapshot),
      qty: r.qty,
      item_status: r.item_status || 'pendiente',
    }));
    order.rated_store = rated.rows.some((r) => r.target_type === 'store');
    order.rated_driver = rated.rows.some((r) => r.target_type === 'driver');
    // Total vigente: si hay confirmado, ese es el que paga el cliente.
    order.total_vigente = order.confirmed_total !== null ? order.confirmed_total : order.total;
    order.merchandise_vigente = order.confirmed_value !== null ? order.confirmed_value : order.merchandise_value;
    order.delivery_fee_vigente = order.confirmed_delivery_fee !== null ? order.confirmed_delivery_fee : order.delivery_fee;
    res.status(200).json(order);
    return;
  }

  // ---- Lista con Bearer ----
  if (req.method === 'GET') {
    // Cliente: solo sus propios pedidos (por customer_id).
    const customerPayload = verifyToken(req);
    if (customerPayload && customerPayload.role === 'customer') {
      const c = await pool.query('SELECT * FROM customers WHERE id = $1', [customerPayload.userId]);
      if (!c.rows[0] || !c.rows[0].active) {
        res.status(401).json({ error: 'No autorizado' });
        return;
      }
      if (req.query && req.query.id) {
        const one = await pool.query(ORDER_SELECT + ' WHERE o.id = $1 AND o.customer_id = $2', [Number(req.query.id), c.rows[0].id]);
        if (!one.rows[0]) {
          res.status(404).json({ error: 'Pedido no encontrado' });
          return;
        }
        res.status(200).json(publicOrder(one.rows[0]));
        return;
      }
      const mine = await pool.query(ORDER_SELECT + ' WHERE o.customer_id = $1 ORDER BY o.created_at DESC', [c.rows[0].id]);
      res.status(200).json(mine.rows.map(publicOrder));
      return;
    }
    const user = await requireAuth(req, res, null);
    if (!user) return;
    if (req.query && req.query.id) {
      const result = await pool.query(ORDER_SELECT + ' WHERE o.id = $1', [Number(req.query.id)]);
      if (!result.rows[0]) {
        res.status(404).json({ error: 'Pedido no encontrado' });
        return;
      }
      const row = result.rows[0];
      if (user.role === 'comercio') {
        const store = await pool.query('SELECT id FROM stores WHERE user_id = $1', [user.id]);
        if (!store.rows[0] || store.rows[0].id !== row.store_id) {
          res.status(403).json({ error: 'Sin permiso' });
          return;
        }
      }
      if (user.role === 'delivery' && row.driver_id !== user.id && row.status !== 'disponible') {
        res.status(403).json({ error: 'Sin permiso' });
        return;
      }
      const out = publicOrder(row);
      const lines = await pool.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [row.id]);
      out.lines = lines.rows.map((r) => ({
        id: r.id,
        product_id: r.product_id,
        name: r.name_snapshot,
        price: Number(r.price_snapshot),
        qty: r.qty,
        item_status: r.item_status || 'pendiente',
      }));
      res.status(200).json(out);
      return;
    }
    if (user.role === 'admin') {
      const result = await pool.query(ORDER_SELECT + ' ORDER BY o.created_at DESC LIMIT 500');
      res.status(200).json(result.rows.map(publicOrder));
      return;
    }
    if (user.role === 'comercio') {
      const store = await pool.query('SELECT id FROM stores WHERE user_id = $1', [user.id]);
      if (!store.rows[0]) {
        res.status(200).json([]);
        return;
      }
      const result = await pool.query(ORDER_SELECT + ' WHERE o.store_id = $1 ORDER BY o.created_at DESC', [store.rows[0].id]);
      res.status(200).json(result.rows.map(publicOrder));
      return;
    }
    if (user.role === 'delivery') {
      if (req.query && req.query.available === '1') {
        if (!user.online) {
          res.status(200).json([]);
          return;
        }
        const result = await pool.query(ORDER_SELECT + " WHERE o.status = 'disponible' ORDER BY o.created_at DESC");
        // Filtro por radio del delivery (?lat=&lng= con su ubicación actual):
        // solo pedidos de comercios dentro de su work_radius_km. Sin ubicación
        // del delivery o sin coordenadas del comercio, el pedido se incluye
        // igual: nunca se oculta lo que no se puede medir.
        const dLat = toNumber(req.query.lat, null);
        const dLng = toNumber(req.query.lng, null);
        const hasDriverLoc = validCoords(dLat, dLng);
        const radiusRaw = Number(user.work_radius_km);
        const radius = Number.isFinite(radiusRaw) && radiusRaw > 0 ? radiusRaw : 30;
        const rows = result.rows.filter((row) => {
          if (!hasDriverLoc) return true;
          if (!validCoords(row.store_lat, row.store_lng)) return true;
          const km = haversineKm(dLat, dLng, Number(row.store_lat), Number(row.store_lng));
          row.distance_km = round2(km);
          return km <= radius;
        });
        if (hasDriverLoc) {
          rows.sort((a, b) => {
            const da = a.distance_km !== undefined ? a.distance_km : Infinity;
            const db = b.distance_km !== undefined ? b.distance_km : Infinity;
            return da - db;
          });
        }
        res.status(200).json(rows.map(publicOrder));
        return;
      }
      const result = await pool.query(ORDER_SELECT + ' WHERE o.driver_id = $1 ORDER BY o.created_at DESC', [user.id]);
      res.status(200).json(result.rows.map(publicOrder));
      return;
    }
    return methodNotAllowed(res);
  }

  // ---- Acciones sobre un pedido ----
  if (req.method === 'PUT') {
    const user = await requireAuth(req, res, null);
    if (!user) return;
    const id = Number(req.query.id);
    if (!id) {
      res.status(400).json({ error: 'Falta id' });
      return;
    }
    const body = readBody(req);
    const action = String(body.action || '');
    const current = await pool.query(ORDER_SELECT + ' WHERE o.id = $1', [id]);
    if (!current.rows[0]) {
      res.status(404).json({ error: 'Pedido no encontrado' });
      return;
    }
    const order = current.rows[0];

    // Marcar una línea del checklist (delivery dueño, pedido 'aceptado').
    if (req.query.item === '1') {
      if (user.role !== 'delivery' || order.driver_id !== user.id || order.status !== 'aceptado') {
        res.status(403).json({ error: 'Sin permiso o estado incorrecto' });
        return;
      }
      const itemId = Number(body.item_id);
      const status = String(body.status || '');
      if (!itemId || ['pendiente', 'levantado', 'sin_stock'].indexOf(status) === -1) {
        res.status(400).json({ error: 'Ítem o estado inválido' });
        return;
      }
      const line = await pool.query('SELECT * FROM order_items WHERE id = $1 AND order_id = $2', [itemId, id]);
      if (!line.rows[0]) {
        res.status(404).json({ error: 'Ítem no encontrado en este pedido' });
        return;
      }
      const updated = await pool.query(
        'UPDATE order_items SET item_status = $1 WHERE id = $2 RETURNING *',
        [status, itemId]
      );
      // Sin stock: el producto queda flagged hasta que el comercio lo reactive.
      if (status === 'sin_stock' && line.rows[0].product_id) {
        await pool.query('UPDATE products SET out_of_stock = TRUE WHERE id = $1', [line.rows[0].product_id]);
      }
      res.status(200).json({
        id: updated.rows[0].id,
        product_id: updated.rows[0].product_id,
        name: updated.rows[0].name_snapshot,
        price: Number(updated.rows[0].price_snapshot),
        qty: updated.rows[0].qty,
        item_status: updated.rows[0].item_status,
      });
      return;
    }

    // "Pedido armado y listo" (comercio dueño, pedido 'aceptado').
    if (req.query.ready === '1') {
      if (user.role !== 'comercio') {
        res.status(403).json({ error: 'Sin permiso' });
        return;
      }
      const store = await pool.query('SELECT id FROM stores WHERE user_id = $1', [user.id]);
      if (!store.rows[0] || store.rows[0].id !== order.store_id || order.status !== 'aceptado') {
        res.status(403).json({ error: 'Sin permiso o estado incorrecto' });
        return;
      }
      const full = await pool.query(
        'UPDATE orders SET store_ready = $1 WHERE id = $2 RETURNING *',
        [body.store_ready === true, id]
      );
      const out = await pool.query(ORDER_SELECT + ' WHERE o.id = $1', [id]);
      void full;
      res.status(200).json(publicOrder(out.rows[0]));
      return;
    }

    if (action === 'accept') {
      if (user.role !== 'delivery') {
        res.status(403).json({ error: 'Sin permiso' });
        return;
      }
      if (!user.online) {
        res.status(400).json({ error: 'Ponete en línea para aceptar pedidos' });
        return;
      }
      // Sin saldo prepago no se puede aceptar: hay que recargar primero.
      const driverBalance = await getBalance(pool, 'driver', user.id);
      if (!(driverBalance > 0)) {
        res.status(400).json({ error: 'No tenés saldo de créditos. Recargá para seguir trabajando.' });
        return;
      }
      // Atómico: solo si sigue disponible.
      const updated = await pool.query(
        "UPDATE orders SET driver_id = $1, status = 'aceptado', accepted_at = NOW() WHERE id = $2 AND status = 'disponible' RETURNING *",
        [user.id, id]
      );
      if (!updated.rows[0]) {
        res.status(409).json({ error: 'Ya lo tomó otro delivery' });
        return;
      }
      const full = await pool.query(ORDER_SELECT + ' WHERE o.id = $1', [id]);
      res.status(200).json(publicOrder(full.rows[0]));
      return;
    }

    if (action === 'pickup') {
      if (user.role !== 'delivery' || order.driver_id !== user.id || order.status !== 'aceptado') {
        res.status(403).json({ error: 'Sin permiso o estado incorrecto' });
        return;
      }
      // El confirmado se calcula SOLO con las líneas 'levantado' del checklist.
      // Todas las líneas deben estar resueltas y al menos una levantada.
      const lines = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [id]);
      if (lines.rows.some((l) => (l.item_status || 'pendiente') === 'pendiente')) {
        res.status(400).json({ error: 'Marcá todos los ítems como levantados o sin stock antes de confirmar el retiro' });
        return;
      }
      const lifted = lines.rows.filter((l) => l.item_status === 'levantado');
      if (!lifted.length) {
        res.status(400).json({ error: 'No hay ítems levantados: marcá al menos uno o cancelá el pedido si todo está sin stock' });
        return;
      }
      // Precio real de "otros": el delivery indica cuánto pagó por cada línea
      // "otros" levantada (sin producto). Sin un precio mayor que 0 no se puede
      // confirmar, para no confirmar $0 por un "otros" sin valor estimado.
      const itemPrices = body.item_prices && typeof body.item_prices === 'object' ? body.item_prices : {};
      for (const l of lifted) {
        if (l.product_id === null || l.product_id === undefined) {
          const raw = itemPrices[String(l.id)];
          const price = raw !== undefined && raw !== null && raw !== '' ? toNumber(raw, null) : null;
          const effective = price !== null ? price : Number(l.price_snapshot);
          if (!(effective > 0)) {
            res.status(400).json({ error: 'Indicá cuánto pagaste por "' + l.name_snapshot + '" antes de confirmar el retiro' });
            return;
          }
          if (price !== null && round2(price) !== Number(l.price_snapshot)) {
            await pool.query('UPDATE order_items SET price_snapshot = $1 WHERE id = $2 AND order_id = $3 AND product_id IS NULL', [round2(price), l.id, id]);
          }
        }
      }
      const lines2 = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [id]);
      const lifted2 = lines2.rows.filter((l) => l.item_status === 'levantado');
      const confirmed = round2(lifted2.reduce((sum, l) => sum + Number(l.price_snapshot) * l.qty, 0));
      const settings = await getSettings(pool);
      const confirmedFee = round2((settings.driver_pct / 100) * confirmed);
      const confirmedTotal = round2(confirmed + confirmedFee);
      const platformFromDriver = round2((settings.platform_driver_pct / 100) * confirmedFee);
      const platformFromStore = round2((settings.store_pct / 100) * confirmed);
      await pool.query(
        `UPDATE orders SET status = 'retirado', picked_at = NOW(), confirmed_value = $1,
         confirmed_delivery_fee = $2, confirmed_total = $3, driver_earning = $2,
         platform_from_driver = $4, platform_from_store = $5 WHERE id = $6`,
        [confirmed, confirmedFee, confirmedTotal, platformFromDriver, platformFromStore, id]
      );
      const full = await pool.query(ORDER_SELECT + ' WHERE o.id = $1', [id]);
      res.status(200).json(publicOrder(full.rows[0]));
      return;
    }

    if (action === 'deliver') {
      if (user.role !== 'delivery' || order.driver_id !== user.id || order.status !== 'retirado') {
        res.status(403).json({ error: 'Sin permiso o estado incorrecto' });
        return;
      }
      const collected = body.collected_amount !== undefined && body.collected_amount !== null
        ? toNumber(body.collected_amount, null)
        : null;
      // Transacción: marcar entregado + descontar los dos cortes de plataforma
      // de los saldos prepagos (pueden quedar en rojo; la próxima carga cubre
      // primero el rojo porque el saldo es la suma total).
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          "UPDATE orders SET status = 'entregado', delivered_at = NOW(), collected_amount = $1 WHERE id = $2",
          [collected, id]
        );
        if (Number(order.platform_from_driver) > 0) {
          await client.query(
            'INSERT INTO credit_movements (owner_type, owner_id, amount, reason, order_id) VALUES ($1, $2, $3, $4, $5)',
            ['driver', order.driver_id, -Number(order.platform_from_driver), 'Comisión plataforma pedido #' + id, id]
          );
        }
        if (Number(order.platform_from_store) > 0) {
          await client.query(
            'INSERT INTO credit_movements (owner_type, owner_id, amount, reason, order_id) VALUES ($1, $2, $3, $4, $5)',
            ['store', order.store_id, -Number(order.platform_from_store), 'Comisión plataforma pedido #' + id, id]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      const full = await pool.query(ORDER_SELECT + ' WHERE o.id = $1', [id]);
      res.status(200).json(publicOrder(full.rows[0]));
      return;
    }

    if (action === 'cancel') {
      let allowed = false;
      if (user.role === 'admin' && order.status !== 'entregado') allowed = true;
      if (user.role === 'comercio' && (order.status === 'disponible' || order.status === 'aceptado')) {
        const store = await pool.query('SELECT id FROM stores WHERE user_id = $1', [user.id]);
        if (store.rows[0] && store.rows[0].id === order.store_id) allowed = true;
      }
      if (user.role === 'delivery' && order.driver_id === user.id && order.status === 'aceptado') allowed = true;
      if (!allowed) {
        res.status(403).json({ error: 'No se puede cancelar este pedido en su estado actual' });
        return;
      }
      const reason = String(body.reason || body.cancel_reason || '').trim();
      await pool.query('UPDATE orders SET status = $1, cancel_reason = $2 WHERE id = $3', ['cancelado', reason === '' ? null : reason, id]);
      const full = await pool.query(ORDER_SELECT + ' WHERE o.id = $1', [id]);
      res.status(200).json(publicOrder(full.rows[0]));
      return;
    }

    res.status(400).json({ error: 'Acción desconocida' });
    return;
  }

  return methodNotAllowed(res);
};
