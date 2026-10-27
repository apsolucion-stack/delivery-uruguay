-- Delivery Uruguay — esquema inicial (v1).
-- Correr en Neon (base del proyecto) antes del primer uso.
-- Moneda: $U. Zona horaria de la lógica de horarios: America/Montevideo.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('admin', 'comercio', 'delivery')),
  pin_hash TEXT,
  pin_salt TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  vehicle TEXT,
  monotributo_rut TEXT,
  razon_social TEXT,
  nombre_fantasia TEXT,
  domicilio_fiscal TEXT,
  actividad TEXT,
  fecha_inicio_actividades DATE,
  telefono_empresa TEXT,
  email_empresa TEXT,
  numero_bps TEXT,
  pos_provider TEXT,
  pos_terminal TEXT,
  work_radius_km INTEGER NOT NULL DEFAULT 30,
  online BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_role_name_unique
  ON users (role, LOWER(name));

-- Clientes registrados (separados del staff con PIN). Los invitados siguen
-- pidiendo sin cuenta: en ese caso orders.customer_id queda en NULL.
-- ci: solo dígitos, 8 con ceros a la izquierda. email: en minúsculas.
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  ci TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  default_address TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  google_sub TEXT UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stores (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'otro',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  open_time TEXT NOT NULL DEFAULT '09:00',
  close_time TEXT NOT NULL DEFAULT '18:00',
  open_24h BOOLEAN NOT NULL DEFAULT FALSE,
  closed_weekdays TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
  photo TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  out_of_stock BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  customer_id INTEGER REFERENCES customers(id),
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  delivery_address TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '',
  merchandise_value NUMERIC(12, 2) NOT NULL DEFAULT 0,
  delivery_fee NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  confirmed_value NUMERIC(12, 2),
  confirmed_delivery_fee NUMERIC(12, 2),
  confirmed_total NUMERIC(12, 2),
  collected_amount NUMERIC(12, 2),
  store_ready BOOLEAN NOT NULL DEFAULT FALSE,
  cancel_reason TEXT,
  status TEXT NOT NULL DEFAULT 'disponible'
    CHECK (status IN ('disponible', 'aceptado', 'retirado', 'entregado', 'cancelado')),
  driver_id INTEGER REFERENCES users(id),
  driver_earning NUMERIC(12, 2) NOT NULL DEFAULT 0,
  platform_from_driver NUMERIC(12, 2) NOT NULL DEFAULT 0,
  platform_from_store NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  picked_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  name_snapshot TEXT NOT NULL,
  price_snapshot NUMERIC(12, 2) NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  item_status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (item_status IN ('pendiente', 'levantado', 'sin_stock'))
);

CREATE TABLE IF NOT EXISTS ratings (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('store', 'driver')),
  stars INTEGER NOT NULL CHECK (stars >= 1 AND stars <= 5),
  comment TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, target_type)
);

CREATE TABLE IF NOT EXISTS credit_movements (
  id SERIAL PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('driver', 'store')),
  owner_id INTEGER NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  order_id INTEGER REFERENCES orders(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
