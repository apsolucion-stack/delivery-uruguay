// Helpers compartidos por las funciones serverless de Delivery Uruguay.
// Variables de entorno requeridas: DATABASE_URL, SESSION_SECRET.
// Nunca se devuelve un hash de PIN ni una sal al cliente.
// Zona horaria de toda la lógica de horarios: America/Montevideo.

const { Pool } = require('pg');
const crypto = require('crypto');

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

function hashPin(pin, salt) {
  return crypto.createHash('sha256').update(String(salt) + String(pin)).digest('hex');
}

function newSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// Contraseñas de clientes (scrypt). Formato guardado: "sal_hex:hash_hex".
// (Las cuentas staff usan PIN con SHA-256; los clientes usan esto.)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return salt + ':' + derived;
}

function verifyPassword(password, stored) {
  try {
    if (!stored || stored.indexOf(':') === -1) return false;
    const parts = stored.split(':');
    const derived = crypto.scryptSync(String(password), parts[0], 64);
    const expected = Buffer.from(parts[1], 'hex');
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch (e) {
    return false;
  }
}

// ---- Cédula uruguaya ----
// Normaliza a solo dígitos y completa con ceros a la izquierda hasta 8.
// Valida con pesos [2,9,8,7,6,3,4] sobre los 7 primeros dígitos:
// verificador = (10 - suma % 10) % 10, debe coincidir con el 8º dígito.
function normalizeCI(ci) {
  const digits = String(ci || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length > 8) return digits;
  return digits.padStart(8, '0');
}

function validateCI(ci) {
  const digits = normalizeCI(ci);
  if (!/^\d{8}$/.test(digits)) return false;
  const weights = [2, 9, 8, 7, 6, 3, 4];
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(digits[i]) * weights[i];
  const check = (10 - (sum % 10)) % 10;
  return check === Number(digits[7]);
}

// RUT de monotributo: exactamente 12 dígitos.
function normalizeRUT(rut) {
  return String(rut || '').replace(/\D/g, '');
}

function validateRUT(rut) {
  return /^\d{12}$/.test(normalizeRUT(rut));
}

// Datos de la etapa 2 del delivery que faltan para poder ponerse en línea.
// Devuelve la lista de etiquetas pendientes (vacía = etapa 2 completa).
function deliveryStage2Missing(row) {
  const missing = [];
  if (!row) return ['datos de la empresa'];
  if (!validateRUT(row.monotributo_rut)) missing.push('RUT de monotributo (12 dígitos)');
  if (!row.razon_social || !String(row.razon_social).trim()) missing.push('razón social');
  if (!row.domicilio_fiscal || !String(row.domicilio_fiscal).trim()) missing.push('domicilio fiscal');
  if (!row.actividad || !String(row.actividad).trim()) missing.push('actividad (giro)');
  if (!row.pos_provider || !String(row.pos_provider).trim()) missing.push('proveedor de POS');
  if (!row.pos_terminal || !String(row.pos_terminal).trim()) missing.push('terminal POS');
  return missing;
}

// ---- Geolocalización (Haversine, sin dependencias) ----
// Distancia en km entre dos puntos (lat/lng en grados decimales).
function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => Number(d) * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Coordenadas válidas: números finitos dentro de los rangos terrestres.
// null/undefined/'' NO son válidos (evita que un NULL se convierta en 0 y
// genere distancias falsas desde el ecuador).
function validCoords(lat, lng) {
  if (lat === null || lat === undefined || lat === '' || lng === null || lng === undefined || lng === '') return false;
  const la = Number(lat);
  const ln = Number(lng);
  return Number.isFinite(la) && Number.isFinite(ln) && la >= -90 && la <= 90 && ln >= -180 && ln <= 180;
}

function signToken(payload) {
  const secret = process.env.SESSION_SECRET || '';
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyToken(req) {
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer (.+)$/);
    if (!match) return null;
    const parts = match[1].split('.');
    if (parts.length !== 2) return null;
    const body = parts[0];
    const sig = parts[1];
    const secret = process.env.SESSION_SECRET || '';
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    if (!payload.userId || !payload.role) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// Devuelve el usuario autenticado o responde 401/403 y devuelve null.
// roles: array opcional, por ejemplo ['admin'] o ['delivery'].
async function requireAuth(req, res, roles) {
  const payload = verifyToken(req);
  if (!payload) {
    res.status(401).json({ error: 'No autorizado' });
    return null;
  }
  if (roles && roles.indexOf(payload.role) === -1) {
    res.status(403).json({ error: 'Sin permiso' });
    return null;
  }
  const result = await getPool().query(
    'SELECT id, name, phone, role, vehicle, monotributo_rut, razon_social, nombre_fantasia, domicilio_fiscal, actividad, fecha_inicio_actividades, telefono_empresa, email_empresa, numero_bps, pos_provider, pos_terminal, work_radius_km, online, active FROM users WHERE id = $1',
    [payload.userId]
  );
  const row = result.rows[0];
  if (!row || !row.active) {
    res.status(401).json({ error: 'No autorizado' });
    return null;
  }
  return row;
}

// Auth separada para clientes (tabla customers, no users). No toca requireAuth.
async function requireCustomerAuth(req, res) {
  const payload = verifyToken(req);
  if (!payload) {
    res.status(401).json({ error: 'No autorizado' });
    return null;
  }
  if (payload.role !== 'customer') {
    res.status(403).json({ error: 'Sin permiso' });
    return null;
  }
  const result = await getPool().query(
    'SELECT id, full_name, ci, email, phone, default_address, google_sub, active, created_at FROM customers WHERE id = $1',
    [payload.userId]
  );
  const row = result.rows[0];
  if (!row || !row.active) {
    res.status(401).json({ error: 'No autorizado' });
    return null;
  }
  return row;
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return {};
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function methodNotAllowed(res) {
  res.status(405).json({ error: 'Método no permitido' });
}

// ---- Horarios (America/Montevideo) ----
// Devuelve { weekday (0=domingo..6=sábado), minutes (minutos desde medianoche) }
// en hora de Montevideo, sin depender de la zona del servidor.
function getMontevideoNow(date) {
  const d = date || new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Montevideo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const y = get('year');
  const m = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  const weekday = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
  return { weekday, minutes: hour * 60 + minute };
}

function timeToMinutes(t) {
  if (!t) return null;
  const parts = String(t).split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1] || 0);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function parseClosedWeekdays(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 6);
}

// ¿Está abierto el comercio AHORA (Montevideo)?
// - open_24h: siempre abierto (si está activo).
// - Si close <= open, el horario cruza la medianoche (ej. 20:00-04:00).
// - Si el día de hoy está en closed_weekdays, el horario diurno no aplica,
//   pero SÍ puede aplicar el desborde nocturno del día anterior.
// - Si ayer no estaba cerrado y su horario era nocturno y ahora es antes
//   del cierre, sigue abierto por desborde.
function isStoreOpen(store, now) {
  if (!store || !store.active) return false;
  if (store.open_24h) return true;
  const open = timeToMinutes(store.open_time);
  const close = timeToMinutes(store.close_time);
  if (open === null || close === null) return false;
  if (open === close) return false; // sin 24h y sin rango: se considera cerrado
  const closed = parseClosedWeekdays(store.closed_weekdays);
  const overnight = close <= open;
  // Desborde del día anterior.
  if (overnight) {
    const yesterday = (now.weekday + 6) % 7;
    if (closed.indexOf(yesterday) === -1 && now.minutes < close) return true;
  }
  if (closed.indexOf(now.weekday) !== -1) return false;
  if (overnight) return now.minutes >= open || now.minutes < close;
  return now.minutes >= open && now.minutes < close;
}

// ---- Créditos prepagos ----
// Saldo = SUM(amount) de credit_movements. Cargas positivas (el admin carga
// después de cobrar por fuera); descuentos negativos automáticos al
// completarse una entrega. Un saldo puede quedar en rojo: la próxima carga
// lo cubre primero porque el saldo es la suma total.
async function getBalance(pool, ownerType, ownerId) {
  const r = await pool.query(
    'SELECT COALESCE(SUM(amount), 0) AS bal FROM credit_movements WHERE owner_type = $1 AND owner_id = $2',
    [ownerType, ownerId]
  );
  return Number(r.rows[0].bal);
}

async function getLowThreshold(pool) {
  const r = await pool.query("SELECT value FROM settings WHERE key = 'low_balance_threshold'");
  const n = Number(r.rows[0] ? r.rows[0].value : 200);
  return Number.isFinite(n) ? n : 200;
}

module.exports = {
  getPool,
  hashPin,
  newSalt,
  hashPassword,
  verifyPassword,
  normalizeCI,
  validateCI,
  normalizeRUT,
  validateRUT,
  deliveryStage2Missing,
  signToken,
  verifyToken,
  requireAuth,
  requireCustomerAuth,
  readBody,
  toNumber,
  round2,
  methodNotAllowed,
  haversineKm,
  validCoords,
  getMontevideoNow,
  timeToMinutes,
  parseClosedWeekdays,
  isStoreOpen,
  getBalance,
  getLowThreshold,
};
