-- Delivery Uruguay — migración para la entrega "Registro de clientes +
-- datos de unipersonal en etapas + acceso dueño + reportes".
-- Correr UNA SOLA VEZ en la base ya existente (después del schema inicial).
-- Es idempotente (IF NOT EXISTS): se puede correr de nuevo sin duplicar nada.
-- NO cambia % ni lógica de créditos ni pedidos existentes. Los pedidos de
-- invitados siguen con customer_id en NULL.

-- 1) Nuevos campos de la empresa unipersonal en users (todos nullable).
ALTER TABLE users ADD COLUMN IF NOT EXISTS razon_social TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS nombre_fantasia TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS domicilio_fiscal TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS actividad TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS fecha_inicio_actividades DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telefono_empresa TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_empresa TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS numero_bps TEXT;

-- 2) Tabla de clientes registrados (separada del staff con PIN).
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

-- 3) Vincular pedidos con el cliente registrado (nullable: invitados = NULL).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id);
CREATE INDEX IF NOT EXISTS orders_customer_id_idx ON orders (customer_id);

-- 4) Checklist de retiro, sin stock y aviso al comercio.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS item_status TEXT NOT NULL DEFAULT 'pendiente'
  CHECK (item_status IN ('pendiente', 'levantado', 'sin_stock'));
ALTER TABLE products ADD COLUMN IF NOT EXISTS out_of_stock BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS store_ready BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

-- 5) Geolocalización y pausa de tienda.
-- stores.lat/lng: ubicación del negocio (la guarda el comercio desde su
-- perfil con el botón de geolocalización; NULL = sin ubicación, y en ese
-- caso el comercio/pedido nunca se oculta por distancia).
-- stores.paused: pausa propia del comercio (distinta de active, que es del
-- admin): pausada no aparece en comercios abiertos ni recibe pedidos nuevos.
-- users.work_radius_km: radio de trabajo del delivery (default 30, 1–200).
ALTER TABLE stores ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS paused BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS work_radius_km INTEGER NOT NULL DEFAULT 30;
