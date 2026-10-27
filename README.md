# Delivery Uruguay — MVP

Marketplace de entregas para supermercados, almacenes y mercadería en
general (NO comida pronta), en Uruguay. Los comercios publican su catálogo,
los clientes piden desde la app, y los delivery registrados con su empresa
monotributo aceptan las entregas estilo Uber.

## Modelo en pocas palabras

- **El delivery paga en el comercio** cuando retira (adelanta el costo) y
  **el cliente le paga directo al delivery** al recibir (mercadería + envío).
  La plata NO pasa por la plataforma.
- **Ganancia del delivery:** `driver_pct` % de la mercadería (= precio del
  envío, visible para el cliente antes de pedir).
- **La plataforma gana de los dos lados:** `platform_driver_pct` % de la
  ganancia del delivery y `store_pct` % de la venta del comercio.
- **Cobro prepago con créditos (NO hay saldos a liquidar):** el admin carga
  créditos a cada delivery y comercio después de cobrar por fuera
  (transferencia o efectivo). Cada entrega completada descuenta
  automáticamente los dos cortes de esos saldos. Sin saldo no hay pedidos
  nuevos: el delivery no puede aceptar y el comercio no aparece en la lista
  de abiertos. Si un descuento deja el saldo en rojo, queda en rojo hasta
  que la próxima carga lo cubra. Por debajo del umbral (`low_balance_threshold`,
  por defecto $U 200) se muestra el aviso "Te queda poco saldo, recargá para
  seguir trabajando".
- **Delivery con POS obligatorio:** para registrarse y para ponerse en línea
  hay que tener proveedor y terminal de POS (los pagos con tarjeta van a la
  cuenta propia del delivery a través de su POS, vinculado a su monotributo).
- **Solo lo abierto y lo activo:** la lista de comercios muestra solo los
  abiertos AHORA (hora America/Montevideo, con horarios nocturnos que cruzan
  la medianoche y desborde del día anterior) y con saldo > 0. Solo los
  delivery en línea ven y aceptan pedidos disponibles.
- **Calificaciones:** tras cada entrega, el cliente califica con 1-5
  estrellas al comercio y al delivery (una vez por destino por pedido).
- **Catálogo por comercio:** cada comercio agrega/edita/activa productos
  con foto (comprimida en el celular a JPEG máx 1200px, guardada en la base,
  sin servicio externo). El cliente arma el pedido desde el catálogo más un
  campo "otros". Los precios quedan congelados en la línea del pedido: cambios
  posteriores del comercio NO alteran pedidos viejos. Al retirar, el delivery
  confirma el total real pagado y la matemática usa ese total.
- **Total visible:** al armar el pedido se muestra siempre subtotal de
  mercadería + envío (`driver_pct` % del subtotal) + TOTAL a pagar al delivery.
  El % de envío es público (sin login) para que el cálculo funcione antes de
  pedir. El seguimiento muestra el total actualizado si el delivery confirmó
  otro total al retirar.

## Archivos

- `index.html`, `app.js`, `styles.css` — app de una sola página, mobile-first.
- `package.json` (dependencia `pg`), `vercel.json`.
- `schema.sql` — tablas: users, stores, products, orders, order_items,
  ratings, credit_movements, settings.
- `seed.sql` — admin inicial + ajustes en 0 + umbral 200.
- `api/` — **6 archivos** (el plan gratis de Vercel permite 12 como máximo):
  - `_db.js` — pool, hash PIN, token, auth, horarios Montevideo, saldos.
  - `auth.js` — ingreso con PIN + cambio de PIN propio.
  - `users.js` — registro, perfil, disponibilidad, movimientos propios, admin.
  - `stores.js` — comercios + catálogo + % de envío público.
  - `orders.js` — pedidos, seguimiento público, acciones, calificaciones.
  - `admin.js` — ajustes, saldos, movimientos, carga de créditos.

## Cómo desplegar (recursos TOTALMENTE SEPARADOS de Mis Taxis)

No reutilizar jamás el repo, el proyecto de Vercel ni la base de Neon de
Mis Taxis. Todo nuevo:

1. **GitHub:** crear un repositorio NUEVO (público o privado) y subir todo el
   contenido de esta carpeta a la rama `main`.
2. **Vercel:** importar el repositorio como un proyecto NUEVO (no el proyecto
   `mis-taxis`). Vercel redespliega solo con cada push a `main`.
3. **Neon:** crear un proyecto NUEVO (no la base de Mis Taxis). En su editor
   SQL, correr primero `schema.sql` completo y después `seed.sql` completo.
4. **Variables de entorno en Vercel (Production):**
   - `DATABASE_URL`: la URL pooled de la base NUEVA de Neon, con
     `sslmode=require`.
   - `SESSION_SECRET`: cualquier texto largo aleatorio.
5. Redesplegar en Vercel y verificar que la app abre.

## Primer ingreso (¡hacer en este orden!)

1. Abrir la app y entrar como **rol Admin, nombre `Admin`, PIN `1234`**.
   (Es un PIN provisorio sembrado solo para el primer ingreso.)
2. Ir a **Mi PIN** y cambiarlo de inmediato por uno propio y secreto.
3. Ir a **Ajustes** y configurar los 4 valores antes de operar (nacen en 0
   y la app lo advierte mientras sigan en 0):
   - `% que gana el delivery sobre la mercadería` (= precio del envío).
   - `% de la ganancia del delivery para la plataforma`.
   - `% de la venta del comercio para la plataforma`.
   - `Umbral de poco saldo` ($U, por defecto 200).
4. Registrar comercios y deliveries (o dejar que se registren solos) y
   **cargarles créditos** desde **Saldos y créditos** (monto + nota) después
   de cobrarles por fuera. Sin créditos no operan.
5. Cada comercio carga su horario y su catálogo; cada delivery se pone en
   línea cuando quiere trabajar y fuera de línea cuando termina.

## Seguimiento de pedidos sin login

Un cliente sigue su pedido abriendo la app con `?pedido=NUMERO` o desde
"Seguir mi pedido". Tras la aceptación ve los teléfonos de las partes para
coordinar por WhatsApp, y tras la entrega puede calificar.

## Decisiones y huecos conocidos (v1)

- Los porcentajes nacen en 0 a propósito: NO se inventó ninguna tarifa
  recomendada; el dueño los define en Ajustes.
- El monto cobrado al cliente se guarda (`collected_amount`) pero no se
  valida contra el total: el cobro es directo entre cliente y delivery.
- El cliente no tiene cuenta: pide con nombre/teléfono/dirección y sigue su
  pedido por número. Las calificaciones se hacen desde ese seguimiento.
- No hay notificaciones push ni SMS en v1: los cambios de estado se ven al
  instante en la app (el cliente/comercio ven el seguimiento; el delivery ve
  sus entregas). Los teléfonos expuestos tras la aceptación permiten
  coordinar por WhatsApp.
- No hay mapa en vivo ni GPS en v1 (el seguimiento es por estados).
- La cancelación no está permitida después de "retirado": un pedido retirado
  solo puede completarse como entregado.
- Un comercio suspendido por el admin (usuario inactivo) deja de aparecer
  en comercios abiertos y no puede recibir pedidos nuevos.
- Las fotos de productos se guardan como data URL en la base (sin costo ni
  servicio externo); se rechazan fotos de más de ~2MB de texto.
