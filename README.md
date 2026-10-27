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
- **Delivery con POS obligatorio para trabajar:** el registro es en dos
  etapas. Etapa 1 (cuenta): nombre, teléfono, PIN y vehículo, todos
  obligatorios. Etapa 2 (desde su perfil): datos de la empresa unipersonal
  (RUT de 12 dígitos, razón social, nombre de fantasía, domicilio fiscal,
  actividad/giro, fecha de inicio, teléfono/email de empresa, Nº BPS) +
  POS (proveedor y terminal). Solo con la etapa 2 completa (RUT, razón
  social, domicilio fiscal, actividad y POS) el delivery puede ponerse en
  línea y recibir pedidos; si intenta ponerse en línea incompleto, la app
  le muestra qué falta y lo lleva a completarlo. En su perfil y en
  "Cómo empezar" hay tarjetas de ayuda breves (monotributo en DGI/BPS,
  conseguir el POS) con el aviso de verificar costos y requisitos en
  dgi.gub.uy / bps.gub.uy o con un contador — sin montos ni trámites
  inventados.
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
  posteriores del comercio NO alteran pedidos viejos. Al retirar, el
  delivery usa el **checklist de retiro** (ver abajo) y la matemática usa
  el total confirmado con lo levantado.
- **Checklist de retiro y sin stock:** en un pedido aceptado, el delivery
  ve sus ítems como checklist persistente (pendiente / levantado /
  sin_stock). Al confirmar el retiro ("Ya tengo la orden"), el
  `confirmed_value` se calcula SOLO con las líneas levantadas
  (precio congelado × cantidad); de ahí salen envío confirmado, total,
  ganancia y cortes. El seguimiento del cliente muestra el pedido
  actualizado con los ítems faltantes y el nuevo total. Al marcar un ítem
  sin stock, el producto queda flagged `out_of_stock`: el catálogo del
  cliente lo oculta y el comercio lo ve flagged con "Volver a poner en
  stock". Si TODOS los ítems quedan sin stock, el delivery puede cancelar
  el pedido con motivo "Todo sin stock" y el cliente lo ve cancelado con
  ese motivo.
- **Aviso al comercio:** cuando un pedido pasa a aceptado, la vista del
  comercio muestra la sección destacada "Órdenes en camino — armalas
  ahora" (ítems y cantidades, cliente, dirección, delivery asignado con
  teléfono y hora de aceptación). El comercio puede marcar "Pedido armado
  y listo" (`orders.store_ready`); el delivery lo ve en su checklist. No
  cambia el flujo de estados disponible → aceptado → retirado → entregado.
- **Total visible:** al armar el pedido se muestra siempre subtotal de
  mercadería + envío (`driver_pct` % del subtotal) + TOTAL a pagar al delivery.
  El % de envío es público (sin login) para que el cálculo funcione antes de
  pedir. El seguimiento muestra el total actualizado si el delivery confirmó
  otro total al retirar.

## Archivos

- `index.html`, `app.js`, `styles.css` — app de una sola página, mobile-first.
- `package.json` (dependencia `pg`), `vercel.json`.
- `schema.sql` — tablas: users, stores, products, orders, order_items,
  ratings, credit_movements, settings, **customers** (nueva).
- `migration-customers.sql` — SOLO el delta para bases ya existentes:
  tabla `customers`, `orders.customer_id`, columnas de la unipersonal en
  `users`, `order_items.item_status`, `products.out_of_stock`,
  `orders.store_ready`, `orders.cancel_reason`. Idempotente (IF NOT EXISTS).
- `seed.sql` — admin inicial + ajustes en 0 + umbral 200.
- `api/` — **6 archivos** (el plan gratis de Vercel permite 12 como máximo):
  - `_db.js` — pool, hash PIN, hash de contraseñas (scrypt), token, auth
    de staff y de clientes, validación de CI y RUT, horarios Montevideo,
    saldos.
  - `auth.js` — ingreso con PIN (staff, sin admin) + acceso dueño
    (solo admin) + cambio de PIN propio + registro/login de clientes
    (email+contraseña y Google).
  - `users.js` — registro en etapas, perfil, disponibilidad con traba de
    etapa 2, movimientos propios, admin, perfil y pedidos del cliente.
  - `stores.js` — comercios + catálogo + % de envío y `google_client_id`
    públicos.
  - `orders.js` — pedidos, seguimiento público, checklist de retiro,
    sin stock, aviso al comercio, acciones, calificaciones.
  - `admin.js` — ajustes (incl. `google_client_id`), saldos, movimientos,
    carga de créditos, lista de clientes, reportes.

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

## Registro de clientes (Google solamente; Apple queda para después)

Tabla `customers`, SEPARADA de `users` (que es solo staff con PIN):
`id`, `full_name`, `ci` (solo dígitos, UNIQUE), `email` (minúsculas,
UNIQUE), `phone`, `default_address`, `password_hash` (nullable: los que
entran con Google no tienen contraseña), `google_sub` (UNIQUE, nullable),
`active`, `created_at`. `orders.customer_id` referencia a `customers(id)`
y es nullable: los pedidos de invitados siguen con NULL, sin cambios.

- **Todos los campos son obligatorios** en el registro (nombre completo,
  cédula, email, teléfono, dirección de entrega, contraseña) en frontend
  y backend: el backend rechaza si falta cualquiera.
- **Cédula uruguaya validada igual en frontend y backend:** solo dígitos,
  8 dígitos (base de 7 + dígito verificador, con ceros a la izquierda si
  hace falta), pesos `[2,9,8,7,6,3,4]` sobre los 7 primeros, verificador =
  `(10 − suma % 10) % 10`. Si no coincide, se rechaza.
- **Contraseña:** mínimo 6 caracteres, guardada con scrypt
  (`sal_hex:hash_hex`) en `_db.js` (`hashPassword`/`verifyPassword`).
  La cédula solo la ven el propio cliente y el dueño, nunca es pública.
- **Google:** el botón "Continuar con Google" (Google Identity Services)
  aparece SOLO si el dueño configuró `google_client_id` en Ajustes
  (el endpoint público `GET /api/stores?settings=public` lo devuelve; el
  client ID es público por diseño). El backend verifica el ID token SIN
  librerías nuevas: descarga el JWKS de
  `https://www.googleapis.com/oauth2/v3/certs`, verifica la firma RS256
  con la clave pública (Node acepta formato JWK) y controla `iss`
  (accounts.google.com o https://accounts.google.com), `aud` =
  `google_client_id` configurado y `exp` vigente. Busca al cliente por
  `google_sub`, si no por email (y vincula `google_sub` si está vacío);
  si no existe, lo crea con nombre/email del token y perfil incompleto:
  el frontend muestra entonces "Completá tus datos" (CI, teléfono y
  dirección, obligatorios) antes de permitir pedir. Un cliente con perfil
  incompleto NO puede crear pedidos (el backend lo rechaza).
- **Auth separada:** `requireCustomerAuth` carga de `customers` (no toca
  `requireAuth` de staff). El token usa el mismo `signToken` con rol
  `'customer'`.
- **Vistas:** "Registrarme como cliente" e "Ingresar como cliente"
  (email+contraseña + Google); "Mi cuenta" (datos, editar dirección/
  teléfono, cambiar contraseña, completar CI si vino de Google) y
  "Mis pedidos" (historial con comercio, total y estado). El checkout
  prellena nombre/teléfono/dirección si el cliente está logueado.
- **Admin:** lista "Clientes" (nombre, CI, email, teléfono, activo) con
  activar/desactivar. Un cliente suspendido no puede ingresar ni pedir.
- **Endpoints nuevos (fusionados en los archivos existentes, sin pasar
  de 12 archivos en `api/`):**
  - `POST /api/auth?customer=register` `{full_name, ci, email, phone,
    default_address, password}` → `{ok, id}`.
  - `POST /api/auth?customer=login` `{email, password}` →
    `{token, customer}`.
  - `POST /api/auth?customer=google` `{id_token}` →
    `{token, customer}` (con `profile_complete`).
  - `GET /api/users?customer=me` → perfil + `orders` propios.
  - `PUT /api/users?customer=me` `{full_name?, phone?, default_address?,
    ci? (solo si está vacío), password?}` → perfil actualizado.
  - `GET /api/stores?settings=public` ahora devuelve también
    `google_client_id`.

### Cómo crear el cliente OAuth en Google Cloud Console (gratis)

1. Ir a https://console.cloud.google.com/ y crear un proyecto nuevo
   (o usar uno existente).
2. En "APIs y servicios → Pantalla de consentimiento de OAuth",
   configurarla (tipo Externo, nombre de la app, email de soporte) y
   publicarla o dejarla en modo de prueba con los usuarios que van a
   probar.
3. En "APIs y servicios → Credenciales → Crear credenciales → ID de
   cliente de OAuth", elegir tipo **Aplicación web**.
4. En **Orígenes de JavaScript autorizados** agregar exactamente:
   `https://delivery-uruguay.vercel.app`
   (sin barra final; si se prueba en local, agregar también el origen
   local que se use).
5. Copiar el **ID de cliente** (termina en `.apps.googleusercontent.com`)
   y pegarlo en la app: entrar como dueño → **Ajustes** → campo
   "ID de cliente de Google" → Guardar. Sin ese ID, el botón de Google
   no aparece y el registro/login de clientes funciona solo con
   email y contraseña.
6. No hace falta crear secreto de cliente para este flujo: el backend
   verifica el ID token contra el JWKS público de Google, no usa
   client secret.

## Acceso dueño y reportes

- **Acceso dueño separado:** en la pantalla de ingreso hay un acceso
  diferenciado "Acceso dueño" y también `?dueno=1` que lo abre directo.
  Es un formulario SOLO con nombre + PIN, sin selector de rol, que SOLO
  acepta usuarios con rol `admin` (`POST /api/auth?owner=1`); cualquier
  otro rol recibe "Acceso solo para el dueño de la plataforma".
- **El ingreso normal NO ofrece cuentas admin:** el login de
  comercio/delivery rechaza cuentas rol `admin` y remite al acceso dueño.
- **El dueño ve todo lo de gestión:** Comercios, Deliveries, Clientes,
  Pedidos, Ajustes (%), Saldos y créditos, Mi PIN y la sección
  **Reportes** (`GET /api/admin?reports=1&from=&to=&store_id=&driver_id=`):
  rango de fechas (por defecto últimos 30 días), filtros por comercio y
  delivery; totales del período (pedidos entregados, mercadería total,
  envíos totales, ganancia total de deliveries, corte plataforma desde
  deliveries, corte plataforma desde comercios, créditos cargados y
  créditos descontados); desgloses por comercio y por delivery; tabla de
  pedidos del período con estado. Los demás roles no ven ninguna de
  esas secciones.

## Página principal y rediseño visual

- **Hero final (copy definitivo, no borrador):** "Delivery Uruguay /
  Supermercados, almacenes y mercadería a tu puerta, a cualquier hora /
  Pedís desde la app, un delivery lo retira en el comercio y te lo cobra
  al llegar." Acciones como tarjetas claras: "Pedir en comercios
  abiertos" (CTA primario), "Seguir mi pedido", "Ingresar", "Crear
  cuenta"; accesos secundarios: ingresar como cliente, registrarse
  (comercio/delivery), acceso dueño. Franja de beneficios con solo
  afirmaciones reales de la app: "Comercios abiertos ahora · Pagás
  cuando lo recibís · Seguimiento de tu pedido". Un solo emoji de marca
  en el encabezado, sin saturar.
- **Rediseño aplicado a todas las vistas:** mobile-first, fondo claro,
  texto oscuro de alto contraste, UN acento fuerte (naranja delivery)
  en botones primarios, precios destacados y enlaces; colores de estado
  consistentes (disponible gris/azul, aceptado naranja, retirado
  violeta, entregado verde, cancelado/sin stock rojo); tarjetas con
  bordes redondeados (12–16px) y sombra suave; títulos grandes, precios
  y TOTAL en caja resaltada; botones primarios de ancho completo con
  alto táctil mínimo 44px; badges de estado; fotos de producto cuando
  existen. Sin modo oscuro, sin animaciones pesadas, sin navegación
  nueva: los mismos flujos, solo más lindos y legibles.

## Primer ingreso (¡hacer en este orden!)

1. Abrir la app con **?dueno=1** (o tocar "Acceso dueño") y entrar como
   **nombre `Admin`, PIN `1234`**.
   (Es un PIN provisorio sembrado solo para el primer ingreso. El
   ingreso normal de comercio/delivery NO acepta cuentas admin.)
2. Ir a **Mi PIN** y cambiarlo de inmediato por uno propio y secreto.
3. Ir a **Ajustes** y configurar los valores antes de operar (nacen en 0
   y la app lo advierte mientras sigan en 0):
   - `% que gana el delivery sobre la mercadería` (= precio del envío).
   - `% de la ganancia del delivery para la plataforma`.
   - `% de la venta del comercio para la plataforma`.
   - `Umbral de poco saldo` ($U, por defecto 200).
   - `ID de cliente de Google` (opcional; vacío = sin botón de Google).
4. Registrar comercios y deliveries (o dejar que se registren solos) y
   **cargarles créditos** desde **Saldos y créditos** (monto + nota) después
   de cobrarles por fuera. Sin créditos no operan.
5. Cada comercio carga su horario y su catálogo; cada delivery completa
   su etapa 2 desde su perfil, se pone en línea cuando quiere trabajar
   y fuera de línea cuando termina.

## Seguimiento de pedidos sin login

Un cliente sigue su pedido abriendo la app con `?pedido=NUMERO` o desde
"Seguir mi pedido". Tras la aceptación ve los teléfonos de las partes para
coordinar por WhatsApp, y tras la entrega puede calificar.

## Decisiones y huecos conocidos (v1)

- Los porcentajes nacen en 0 a propósito: NO se inventó ninguna tarifa
  recomendada; el dueño los define en Ajustes.
- El monto cobrado al cliente se guarda (`collected_amount`) pero no se
  valida contra el total: el cobro es directo entre cliente y delivery.
- El cliente YA tiene cuenta (ver "Registro de clientes"): pide con
  email+contraseña o Google, ve su historial y repite datos; pedir sin
  cuenta (invitado) sigue funcionando igual. Las calificaciones se hacen
  desde el seguimiento o desde su historial.
- No hay notificaciones push ni SMS en v1: los cambios de estado se ven al
  instante en la app (el cliente/comercio ven el seguimiento; el delivery ve
  sus entregas). Los teléfonos expuestos tras la aceptación permiten
  coordinar por WhatsApp.
- No hay mapa en vivo en v1 (el seguimiento es por estados), pero sí hay
  geolocalización por cercanía: ver "Geolocalización y productividad".
- La cancelación no está permitida después de "retirado": un pedido retirado
  solo puede completarse como entregado.
- Un comercio suspendido por el admin (usuario inactivo) deja de aparecer
  en comercios abiertos y no puede recibir pedidos nuevos.
- Las fotos de productos se guardan como data URL en la base (sin costo ni
  servicio externo); se rechazan fotos de más de ~2MB de texto.

## Geolocalización y productividad

- **Ubicación del comercio**: desde "Mi comercio", botón "Usar mi ubicación
  actual" (geolocalización del navegador, con permiso). Queda guardada en
  `stores.lat/lng` y se muestra "ubicación guardada". Sin coordenadas, el
  comercio se lista igual que siempre, sin distancia.
- **Radio del delivery**: en "Mi perfil", "Radio de trabajo (km)" (default
  30, editable 1–200, `users.work_radius_km`). En "Disponibles", con el botón
  "Usar mi ubicación", solo se muestran pedidos de comercios dentro de ese
  radio, ordenados del más cercano, con la distancia en cada tarjeta. Sin
  ubicación del delivery o sin coordenadas del comercio, el pedido se muestra
  igual (nunca se oculta lo que no se puede medir). La ubicación del delivery
  es transitoria por consulta: nunca se guarda en la base.
- **Cercanía para el cliente**: en "Ver comercios", "Usar mi ubicación para
  ver cercanía" ordena del más cercano y muestra "a X km" por tarjeta. Sin
  ubicación, el listado es el de siempre (abiertos + saldo).
- **WhatsApp con un toque**: donde ya se mostraba un teléfono tras la
  aceptación (delivery↔cliente, delivery↔comercio, cliente→delivery), ahora es
  link a WhatsApp (wa.me) + llamada (tel:), con normalización uruguaya
  (0 inicial afuera, prefijo 598). El teléfono del cliente sigue oculto en el
  seguimiento público, y el delivery no ve el teléfono del cliente en pedidos
  disponibles antes de aceptar.
- **Ganancia antes de aceptar**: cada tarjeta de "Disponibles" muestra
  "Tu ganancia" (el envío) + "Total a cobrar al cliente" antes de aceptar.
- **Pausar tienda**: en "Mi comercio", "Pausar tienda temporalmente"
  (`stores.paused`, distinto de `active` del admin). Pausada no aparece en
  comercios abiertos ni en catálogo ni recibe pedidos nuevos, hasta reanudar.
  No cambia horarios ni 24h.
- **Confirmar antes de cancelar**: toda cancelación de pedido pide
  confirmación (incluida "todo sin stock").
- Negar el permiso de ubicación nunca bloquea ningún flujo: todo sigue
  mostrando la lista completa, sin filtrar.
