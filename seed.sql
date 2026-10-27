-- Delivery Uruguay — datos iniciales.
-- Correr DESPUÉS de schema.sql.
-- IMPORTANTE: el admin 'Admin' nace con el PIN provisorio 1234.
-- Entrar con ese PIN y cambiarlo de inmediato desde "Mi PIN".
-- Los porcentajes nacen en 0: el admin DEBE configurarlos en "Ajustes"
-- antes de operar (la app lo advierte mientras sigan en 0).

INSERT INTO users (name, phone, role, pin_hash, pin_salt, active)
VALUES (
  'Admin',
  '',
  'admin',
  'c6216d67e367eaa6cca1271063f9823d4ff93c71d170c6d075d5bc3cb1b2d564',
  'd561b56c971590bb7de8cce00a5a0ea3',
  TRUE
)
ON CONFLICT (role, LOWER(name)) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('driver_pct', '0'),
  ('platform_driver_pct', '0'),
  ('store_pct', '0'),
  ('low_balance_threshold', '200')
ON CONFLICT (key) DO NOTHING;
