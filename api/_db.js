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
    'SELECT id, name, phone, role, vehicle, monotributo_rut, pos_provider, pos_terminal, online, active FROM users WHERE id = $1',
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
  signToken,
  verifyToken,
  requireAuth,
  readBody,
  toNumber,
  round2,
  methodNotAllowed,
  getMontevideoNow,
  timeToMinutes,
  parseClosedWeekdays,
  isStoreOpen,
  getBalance,
  getLowThreshold,
};
