// Delivery Uruguay — app de una sola página (JavaScript sin compilación).
// Roles: admin, comercio, delivery (ingreso con PIN). Los clientes piden sin login.
// Moneda: $U. Horarios: America/Montevideo (el filtro de abiertos lo hace la API).

(function () {
'use strict';

var token = localStorage.getItem('du_token') || '';
var user = null;
try { user = JSON.parse(localStorage.getItem('du_user') || 'null'); } catch (e) { user = null; }

var loginView = document.getElementById('login-view');
var registerView = document.getElementById('register-view');
var homeView = document.getElementById('home-view');
var storesView = document.getElementById('stores-view');
var catalogView = document.getElementById('catalog-view');
var trackView = document.getElementById('track-view');
var appView = document.getElementById('app-view');
var tabsEl = document.getElementById('tabs');
var contentEl = document.getElementById('content');
var messageEl = document.getElementById('message');
var userNameEl = document.getElementById('user-name');
var userBar = document.getElementById('user-bar');

var currentTab = null;
var currentStore = null;
var currentCatalog = [];
var cart = {};
var driverPct = 0;

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(n) {
  return new Intl.NumberFormat('es-UY', { style: 'currency', currency: 'UYU', maximumFractionDigits: 2 }).format(Number(n || 0));
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function showMessage(text, kind) {
  messageEl.textContent = text || '';
  messageEl.className = kind || '';
  if (text) {
    setTimeout(function () { messageEl.textContent = ''; messageEl.className = ''; }, 6000);
  }
}

async function api(path, method, body) {
  var headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  var options = { method: method || 'GET', headers: headers };
  if (body !== undefined) options.body = JSON.stringify(body);
  var res = await fetch(path, options);
  var data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    var msg = (data && data.error) ? data.error : 'Error ' + res.status;
    if (res.status === 401) { logout(); }
    throw new Error(msg);
  }
  return data;
}

function statusLabel(status) {
  var map = {
    disponible: 'Disponible',
    aceptado: 'Aceptado',
    retirado: 'Retirado — el delivery ya tiene tu orden',
    entregado: 'Entregado',
    cancelado: 'Cancelado',
  };
  return map[status] || status;
}

function starsText(avg, count) {
  if (avg === null || avg === undefined || !count) return 'Sin calificaciones todavía';
  var full = Math.round(Number(avg));
  var s = '';
  for (var i = 0; i < 5; i++) s += i < full ? '★' : '☆';
  return s + ' (' + Number(avg).toFixed(1) + ' · ' + count + ')';
}

function hideAllViews() {
  homeView.classList.add('hidden');
  storesView.classList.add('hidden');
  catalogView.classList.add('hidden');
  trackView.classList.add('hidden');
  loginView.classList.add('hidden');
  registerView.classList.add('hidden');
  appView.classList.add('hidden');
}

function showView(name) {
  hideAllViews();
  if (name === 'home') homeView.classList.remove('hidden');
  if (name === 'stores') { storesView.classList.remove('hidden'); loadOpenStores(); }
  if (name === 'catalog') catalogView.classList.remove('hidden');
  if (name === 'track') trackView.classList.remove('hidden');
  if (name === 'login') loginView.classList.remove('hidden');
  if (name === 'register') registerView.classList.remove('hidden');
  if (name === 'app') { appView.classList.remove('hidden'); }
  window.scrollTo(0, 0);
}

function showLogin() {
  userBar.classList.add('hidden');
  showView('login');
}

function showApp() {
  userBar.classList.remove('hidden');
  userNameEl.textContent = user.name + ' (' + user.role + ')';
  showView('app');
  if (!currentTab) {
    currentTab = user.role === 'admin' ? 'admin-stores' :
      user.role === 'comercio' ? 'store' : 'availability';
  }
  buildTabs();
}

function logout() {
  token = '';
  user = null;
  localStorage.removeItem('du_token');
  localStorage.removeItem('du_user');
  currentTab = null;
  showView('home');
  userBar.classList.add('hidden');
}

// Foto de producto: comprimir en el cliente a JPEG máx 1200px.
function compressPhoto(file) {
  return new Promise(function (resolve) {
    if (!file) { resolve(null); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 1200;
        var w = img.width;
        var h = img.height;
        if (Math.max(w, h) > max) {
          var scale = max / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = function () { resolve(null); };
      img.src = reader.result;
    };
    reader.onerror = function () { resolve(null); };
    reader.readAsDataURL(file);
  });
}

function montevideoTimeText() {
  try {
    return new Intl.DateTimeFormat('es-UY', {
      timeZone: 'America/Montevideo',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date());
  } catch (e) {
    return '';
  }
}

// ---- Vistas públicas ----
async function loadOpenStores() {
  var listEl = document.getElementById('stores-list');
  var metaEl = document.getElementById('stores-meta');
  listEl.innerHTML = 'Cargando…';
  try {
    var settings = await api('/api/stores?settings=public');
    driverPct = Number(settings.driver_pct || 0);
    var stores = await api('/api/stores?open=1');
    metaEl.innerHTML = 'Hora en Montevideo: <strong>' + esc(montevideoTimeText()) + '</strong> · Envío: <strong>' + driverPct + '%</strong> de la mercadería (se cobra al recibir). Solo se muestran comercios abiertos ahora.';
    if (!stores.length) {
      listEl.innerHTML = '<p>No hay comercios abiertos en este momento. Probá más tarde.</p>';
      return;
    }
    listEl.innerHTML = stores.map(function (s) {
      return '<div class="card">' +
        '<h3>' + esc(s.name) + '</h3>' +
        '<p>' + esc(s.type) + ' · ' + esc(s.address) + '</p>' +
        '<p>' + starsText(s.avg_stars, s.ratings_count) + '</p>' +
        '<p>Horario: ' + (s.open_24h ? 'Abierto 24 horas' : esc(s.open_time) + ' – ' + esc(s.close_time)) + '</p>' +
        '<button type="button" onclick="openCatalog(' + s.id + ')">Ver catálogo y pedir</button>' +
        '</div>';
    }).join('');
  } catch (e) {
    listEl.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
  }
}

async function openCatalog(storeId) {
  try {
    var store = await api('/api/stores?id=' + encodeURIComponent(storeId));
    if (!store.is_open) {
      showMessage('Ese comercio está cerrado ahora.', 'error');
      return;
    }
    var settings = await api('/api/stores?settings=public');
    driverPct = Number(settings.driver_pct || 0);
    var products = await api('/api/stores?products=1&store_id=' + encodeURIComponent(storeId));
    var openStores = await api('/api/stores?open=1');
    var storeWithRating = openStores.find(function (s) { return s.id === store.id; });
    currentStore = store;
    currentCatalog = products;
    cart = {};
    document.getElementById('catalog-header').innerHTML =
      '<h2>' + esc(store.name) + '</h2>' +
      '<p>' + esc(store.type) + ' · ' + esc(store.address) + ' · ' + esc(store.phone) + '</p>' +
      '<p>' + starsText(storeWithRating ? storeWithRating.avg_stars : null, storeWithRating ? storeWithRating.ratings_count : 0) + '</p>';
    renderCatalog();
    showView('catalog');
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

function cartLines() {
  var lines = [];
  var subtotal = 0;
  currentCatalog.forEach(function (p) {
    var qty = cart[p.id] || 0;
    if (qty > 0) {
      lines.push({ product_id: p.id, qty: qty });
      subtotal = round2(subtotal + Number(p.price) * qty);
    }
  });
  return { lines: lines, subtotal: subtotal };
}

function renderCatalog() {
  var listEl = document.getElementById('catalog-list');
  if (!currentCatalog.length) {
    listEl.innerHTML = '<p>Este comercio todavía no cargó productos en su catálogo. Podés pedir escribiendo en "otros" abajo.</p>';
  } else {
    listEl.innerHTML = currentCatalog.map(function (p) {
      var qty = cart[p.id] || 0;
      return '<div class="card">' +
        (p.photo ? '<img class="product-photo" src="' + p.photo + '" alt="">' : '') +
        '<h3>' + esc(p.name) + ' — ' + money(p.price) + '</h3>' +
        '<p>' + esc(p.description || '') + '</p>' +
        '<div class="qty">' +
        '<button type="button" onclick="changeQty(' + p.id + ', -1)">−</button>' +
        '<span>' + qty + '</span>' +
        '<button type="button" onclick="changeQty(' + p.id + ', 1)">+</button>' +
        '</div>' +
        '</div>';
    }).join('');
  }
  renderBreakdown();
}

function renderBreakdown() {
  var box = document.getElementById('cart-box');
  var otrosValue = Number(document.getElementById('otros-value').value || 0) || 0;
  var calc = cartLines();
  var subtotal = round2(calc.subtotal + otrosValue);
  var fee = round2((driverPct / 100) * subtotal);
  var total = round2(subtotal + fee);
  var parts = calc.lines.map(function (l) {
    var p = currentCatalog.find(function (x) { return x.id === l.product_id; });
    return l.qty + 'x ' + (p ? p.name : '') + ' (' + money(Number(p.price) * l.qty) + ')';
  });
  box.innerHTML = parts.length ? '<p>' + esc(parts.join('; ')) + '</p>' : '<p>Sin productos elegidos todavía.</p>';
  document.getElementById('order-breakdown').innerHTML =
    '<div class="card">' +
    '<p>Subtotal mercadería: <strong>' + money(subtotal) + '</strong></p>' +
    '<p>Envío (' + driverPct + '% de la mercadería): <strong>' + money(fee) + '</strong></p>' +
    '<p>TOTAL a pagar al delivery al recibir: <strong>' + money(total) + '</strong></p>' +
    (driverPct === 0 ? '<p class="warning">El comercio todavía no configuró el % de envío; el total se actualizará cuando lo configure.</p>' : '') +
    '</div>';
}

function changeQty(productId, delta) {
  var next = (cart[productId] || 0) + delta;
  if (next < 0) next = 0;
  cart[productId] = next;
  renderCatalog();
}

async function createOrder() {
  var calc = cartLines();
  var otrosText = document.getElementById('otros-text').value.trim();
  var otrosValue = Number(document.getElementById('otros-value').value || 0) || 0;
  var name = document.getElementById('cust-name').value.trim();
  var phone = document.getElementById('cust-phone').value.trim();
  var address = document.getElementById('cust-address').value.trim();
  if (!calc.lines.length && !otrosText) {
    showMessage('Elegí productos del catálogo o escribí en "otros".', 'error');
    return;
  }
  if (!name || !phone || !address) {
    showMessage('Completá nombre, teléfono y dirección de entrega.', 'error');
    return;
  }
  try {
    var order = await api('/api/orders', 'POST', {
      store_id: currentStore.id,
      customer_name: name,
      customer_phone: phone,
      delivery_address: address,
      lines: calc.lines,
      otros_text: otrosText,
      otros_value: otrosValue,
    });
    document.getElementById('order-created').innerHTML =
      '<p class="ok">¡Pedido creado! Tu número de pedido es <strong>#' + order.id + '</strong>.</p>' +
      '<p>Total a pagar al delivery al recibir: <strong>' + money(order.total) + '</strong> ' +
      '(mercadería ' + money(order.merchandise_value) + ' + envío ' + money(order.delivery_fee) + ').</p>' +
      '<button type="button" onclick="loadTrack(' + order.id + ')">Ver seguimiento</button>';
    showMessage('Pedido #' + order.id + ' creado. Guardá el número para seguirlo y calificarlo.', 'ok');
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

async function loadTrack(orderId) {
  var id = orderId || Number(document.getElementById('track-id').value);
  if (!id) {
    showMessage('Escribí el número de pedido.', 'error');
    return;
  }
  var resultEl = document.getElementById('track-result');
  resultEl.innerHTML = 'Buscando…';
  showView('track');
  try {
    var order = await api('/api/orders?track=1&id=' + encodeURIComponent(id));
    var html = '<div class="card">' +
      '<h3>Pedido #' + order.id + ' — ' + esc(order.store_name) + '</h3>' +
      '<p><span class="status ' + esc(order.status) + '">' + esc(statusLabel(order.status)) + '</span></p>' +
      '<p>' + esc(order.items) + '</p>' +
      '<p>Entrega en: ' + esc(order.delivery_address) + '</p>' +
      '<p>Subtotal mercadería: <strong>' + money(order.merchandise_vigente) + '</strong></p>' +
      '<p>Envío: <strong>' + money(order.delivery_fee_vigente) + '</strong></p>' +
      '<p>TOTAL a pagar al delivery: <strong>' + money(order.total_vigente) + '</strong>' +
      (order.confirmed_total !== null ? ' (actualizado al confirmar el delivery)' : '') + '</p>';
    if (order.status !== 'disponible') {
      html += '<p>Delivery: ' + esc(order.driver_name || '') + (order.driver_phone ? ' · <a href="https://wa.me/' + esc(order.driver_phone.replace(/[^0-9]/g, '')) + '">WhatsApp</a>' : '') + '</p>';
      html += '<p>Comercio: ' + esc(order.store_phone || '') + '</p>';
    }
    html += '</div>';
    if (order.status === 'entregado' && (!order.rated_store || !order.rated_driver)) {
      html += '<div class="card"><h3>Calificá tu experiencia</h3>' +
        '<p>Comercio (1 a 5 estrellas):</p><div class="stars" id="rate-store-stars">' +
        [1, 2, 3, 4, 5].map(function (n) { return '<button type="button" onclick="setRateStar(\'store\',' + n + ')">☆</button>'; }).join('') + '</div>' +
        '<p>Delivery (1 a 5 estrellas):</p><div class="stars" id="rate-driver-stars">' +
        [1, 2, 3, 4, 5].map(function (n) { return '<button type="button" onclick="setRateStar(\'driver\',' + n + ')">☆</button>'; }).join('') + '</div>' +
        '<label>Comentario (opcional) <input id="rate-comment" type="text"></label>' +
        '<button type="button" onclick="submitRating(' + order.id + ')">Enviar calificación</button>' +
        '<p id="rate-msg"></p></div>';
    } else if (order.status === 'entregado') {
      html += '<p class="ok">Gracias, ya calificaste este pedido.</p>';
    }
    resultEl.innerHTML = html;
  } catch (e) {
    resultEl.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
  }
}

var rateSelection = { store: 0, driver: 0 };

function setRateStar(kind, n) {
  rateSelection[kind] = n;
  var el = document.getElementById(kind === 'store' ? 'rate-store-stars' : 'rate-driver-stars');
  if (!el) return;
  var btns = el.querySelectorAll('button');
  btns.forEach(function (b, i) { b.textContent = i < n ? '★' : '☆'; });
}

async function submitRating(orderId) {
  var msgEl = document.getElementById('rate-msg');
  try {
    await api('/api/orders?rate=1', 'POST', {
      order_id: orderId,
      store_stars: rateSelection.store || null,
      driver_stars: rateSelection.driver || null,
      comment: document.getElementById('rate-comment').value,
    });
    if (msgEl) msgEl.innerHTML = '<span class="ok">¡Gracias por calificar!</span>';
    setTimeout(function () { loadTrack(orderId); }, 800);
  } catch (e) {
    if (msgEl) msgEl.innerHTML = '<span class="error">' + esc(e.message) + '</span>';
  }
}

// Exponer funciones usadas por onclick en el HTML generado.
window.openCatalog = openCatalog;
window.changeQty = changeQty;
window.loadTrack = loadTrack;
window.setRateStar = setRateStar;
window.submitRating = submitRating;

// ---- App con login: pestañas ----
function adminTabs() {
  return [
    { id: 'admin-stores', label: 'Comercios' },
    { id: 'admin-drivers', label: 'Deliveries' },
    { id: 'admin-orders', label: 'Pedidos' },
    { id: 'admin-settings', label: 'Ajustes' },
    { id: 'admin-balances', label: 'Saldos y créditos' },
    { id: 'pin', label: 'Mi PIN' },
  ];
}

function comercioTabs() {
  return [
    { id: 'store', label: 'Mi comercio' },
    { id: 'catalog-mine', label: 'Catálogo' },
    { id: 'my-orders', label: 'Mis pedidos' },
    { id: 'my-balance', label: 'Mi saldo' },
    { id: 'pin', label: 'Mi PIN' },
  ];
}

function driverTabs() {
  return [
    { id: 'availability', label: 'Disponibilidad' },
    { id: 'available', label: 'Disponibles' },
    { id: 'my-deliveries', label: 'Mis entregas' },
    { id: 'profile', label: 'Mi perfil' },
    { id: 'pin', label: 'Mi PIN' },
  ];
}

function buildTabs() {
  var tabs = user.role === 'admin' ? adminTabs() : user.role === 'comercio' ? comercioTabs() : driverTabs();
  tabsEl.innerHTML = tabs.map(function (t) {
    return '<button type="button" class="' + (t.id === currentTab ? 'active' : '') + '" onclick="switchTab(\'' + t.id + '\')">' + esc(t.label) + '</button>';
  }).join('');
  renderTab();
}

function switchTab(tabId) {
  currentTab = tabId;
  buildTabs();
}

function orderCard(o, actions) {
  var html = '<div class="card" data-order-id="' + o.id + '">' +
    '<h3>Pedido #' + o.id + ' — ' + esc(o.store_name || '') + '</h3>' +
    '<p><span class="status ' + esc(o.status) + '">' + esc(statusLabel(o.status)) + '</span></p>' +
    '<p>' + esc(o.items) + '</p>' +
    '<p>Cliente: ' + esc(o.customer_name) + ' · ' + esc(o.customer_phone) + '</p>' +
    '<p>Entrega en: ' + esc(o.delivery_address) + '</p>' +
    '<p>Mercadería: ' + money(o.confirmed_value !== null ? o.confirmed_value : o.merchandise_value) +
    ' · Envío: ' + money(o.confirmed_delivery_fee !== null ? o.confirmed_delivery_fee : o.delivery_fee) +
    ' · Total: <strong>' + money(o.confirmed_total !== null ? o.confirmed_total : o.total) + '</strong></p>';
  if (o.driver_name) html += '<p>Delivery: ' + esc(o.driver_name) + '</p>';
  if (o.status === 'aceptado' && user.role === 'delivery') {
    html += '<p><strong>Pagar en comercio: ' + money(o.merchandise_value) + ' (estimado)</strong></p>' +
      '<label>Monto real pagado en el comercio ($U) <input data-field="confirmed" type="number" min="0" step="0.01"></label>' +
      '<button type="button" onclick="doPickup(' + o.id + ', this)">Ya tengo la orden</button>';
  }
  if (o.status === 'retirado' && user.role === 'delivery') {
    html += '<p><strong>Cobrar al cliente: ' + money(o.confirmed_total) + '</strong> (mercadería ' + money(o.confirmed_value) + ' + envío ' + money(o.confirmed_delivery_fee) + ')</p>' +
      '<label>Monto cobrado al cliente ($U, opcional) <input data-field="collected" type="number" min="0" step="0.01"></label>' +
      '<button type="button" onclick="doDeliver(' + o.id + ', this)">Entregado</button>';
  }
  if (actions) html += actions(o);
  html += '</div>';
  return html;
}

function renderTab() {
  contentEl.innerHTML = 'Cargando…';
  var fn = {
    'admin-stores': renderAdminStores,
    'admin-drivers': renderAdminDrivers,
    'admin-orders': renderAdminOrders,
    'admin-settings': renderAdminSettings,
    'admin-balances': renderAdminBalances,
    'store': renderStoreForm,
    'catalog-mine': renderCatalogMine,
    'my-orders': renderMyOrders,
    'my-balance': renderMyBalance,
    'availability': renderAvailability,
    'available': renderAvailable,
    'my-deliveries': renderMyDeliveries,
    'profile': renderProfile,
    'pin': renderPin,
  }[currentTab];
  if (fn) fn().catch(function (err) { contentEl.innerHTML = '<p class="error">' + esc(err.message) + '</p>'; });
}

function lowBalanceWarning(balance, threshold) {
  if (balance === undefined || balance === null) return '';
  if (balance < threshold) {
    return '<p class="warning"><strong>Te queda poco saldo (' + money(balance) + '). Recargá para seguir trabajando.</strong> Sin saldo no podés aceptar pedidos (delivery) o no aparecés en comercios abiertos (comercio).</p>';
  }
  return '<p>Saldo de créditos: <strong>' + money(balance) + '</strong></p>';
}

// ---- Admin ----
async function renderAdminStores() {
  var stores = await api('/api/stores');
  if (!stores.length) { contentEl.innerHTML = '<p>No hay comercios todavía.</p>'; return; }
  contentEl.innerHTML = stores.map(function (s) {
    return '<div class="card"><h3>' + esc(s.name) + '</h3>' +
      '<p>' + esc(s.type) + ' · ' + esc(s.address) + ' · ' + esc(s.phone) + '</p>' +
      '<p>Horario: ' + (s.open_24h ? '24 horas' : esc(s.open_time) + ' – ' + esc(s.close_time)) + ' · Días cerrados: ' + esc(s.closed_weekdays || 'ninguno') + '</p>' +
      '<p>Abierto ahora: ' + (s.is_open ? 'Sí' : 'No') + '</p>' +
      '<button type="button" onclick="toggleUserActive(' + s.user_id + ', true)">Reactivar comercio</button>' +
      '<button type="button" onclick="toggleUserActive(' + s.user_id + ', false)">Suspender comercio</button></div>';
  }).join('');
}

async function renderAdminDrivers() {
  var drivers = await api('/api/users?role=delivery');
  if (!drivers.length) { contentEl.innerHTML = '<p>No hay deliveries todavía.</p>'; return; }
  contentEl.innerHTML = drivers.map(function (d) {
    return '<div class="card"><h3>' + esc(d.name) + '</h3>' +
      '<p>Tel: ' + esc(d.phone) + ' · Vehículo: ' + esc(d.vehicle || '') + ' · RUT: ' + esc(d.monotributo_rut || '') + '</p>' +
      '<p>POS: ' + esc(d.pos_provider || '') + ' · ' + esc(d.pos_terminal || '') + '</p>' +
      '<p>En línea: ' + (d.online ? 'Sí' : 'No') + ' · Activo: ' + (d.active ? 'Sí' : 'No') + '</p>' +
      '<button type="button" onclick="toggleUserActive(' + d.id + ', true)">Reactivar</button>' +
      '<button type="button" onclick="toggleUserActive(' + d.id + ', false)">Suspender</button></div>';
  }).join('');
}

async function toggleUserActive(userId, active) {
  try {
    await api('/api/users?id=' + encodeURIComponent(userId), 'PUT', { active: active });
    showMessage(active ? 'Usuario reactivado.' : 'Usuario suspendido.', 'ok');
    renderTab();
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

async function renderAdminOrders() {
  var orders = await api('/api/orders');
  if (!orders.length) { contentEl.innerHTML = '<p>No hay pedidos todavía.</p>'; return; }
  contentEl.innerHTML = orders.map(function (o) { return orderCard(o, null); }).join('');
}

async function renderAdminSettings() {
  var s = await api('/api/admin?settings=1');
  contentEl.innerHTML =
    (s.warning_zero ? '<p class="warning"><strong>Atención:</strong> algún porcentaje está en 0. Configuralos antes de operar: con % en 0 el envío y las comisiones salen $0.</p>' : '') +
    '<div class="card"><h3>Porcentajes y umbral</h3>' +
    '<label>% que gana el delivery sobre la mercadería (= precio del envío) <input id="set-driver-pct" type="number" min="0" max="100" step="0.1" value="' + s.driver_pct + '"></label>' +
    '<label>% de la ganancia del delivery para la plataforma <input id="set-platform-driver-pct" type="number" min="0" max="100" step="0.1" value="' + s.platform_driver_pct + '"></label>' +
    '<label>% de la venta del comercio para la plataforma <input id="set-store-pct" type="number" min="0" max="100" step="0.1" value="' + s.store_pct + '"></label>' +
    '<label>Umbral de poco saldo ($U) <input id="set-threshold" type="number" min="0" step="1" value="' + s.low_balance_threshold + '"></label>' +
    '<button type="button" onclick="saveSettings()">Guardar ajustes</button></div>';
}

async function saveSettings() {
  try {
    await api('/api/admin?settings=1', 'PUT', {
      driver_pct: Number(document.getElementById('set-driver-pct').value),
      platform_driver_pct: Number(document.getElementById('set-platform-driver-pct').value),
      store_pct: Number(document.getElementById('set-store-pct').value),
      low_balance_threshold: Number(document.getElementById('set-threshold').value),
    });
    showMessage('Ajustes guardados.', 'ok');
    renderTab();
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

async function renderAdminBalances() {
  var data = await api('/api/admin?balances=1');
  var html = '<p>Umbral de poco saldo: <strong>' + money(data.threshold) + '</strong> (se configura en Ajustes).</p>';
  html += '<div class="card"><h3>Cargar créditos</h3>' +
    '<p class="hint">Primero cobrá por fuera (transferencia o efectivo) y después cargá acá el monto con una nota. La carga cubre primero cualquier saldo en rojo.</p>' +
    '<label>Tipo <select id="credit-type"><option value="driver">Delivery</option><option value="store">Comercio</option></select></label>' +
    '<label>Delivery <select id="credit-driver">' + data.drivers.map(function (d) { return '<option value="' + d.id + '">' + esc(d.name) + ' (saldo ' + money(d.balance) + ')</option>'; }).join('') + '</select></label>' +
    '<label>Comercio <select id="credit-store">' + data.stores.map(function (s) { return '<option value="' + s.id + '">' + esc(s.name) + ' (saldo ' + money(s.balance) + ')</option>'; }).join('') + '</select></label>' +
    '<label>Monto ($U) <input id="credit-amount" type="number" min="0" step="0.01"></label>' +
    '<label>Nota <input id="credit-note" type="text" placeholder="Ej.: transferencia 27/10"></label>' +
    '<button type="button" onclick="loadCredit()">Cargar créditos</button></div>';
  html += '<h3>Deliveries</h3>' + (data.drivers.length ? data.drivers.map(function (d) {
    return '<div class="card"><p><strong>' + esc(d.name) + '</strong> — saldo: ' + money(d.balance) + (d.low ? ' <span class="warning">¡POCO SALDO!</span>' : '') + '</p>' +
      '<button type="button" onclick="showMovements(\'driver\',' + d.id + ')">Ver movimientos</button></div>';
  }).join('') : '<p>Ninguno.</p>');
  html += '<h3>Comercios</h3>' + (data.stores.length ? data.stores.map(function (s) {
    return '<div class="card"><p><strong>' + esc(s.name) + '</strong> — saldo: ' + money(s.balance) + (s.low ? ' <span class="warning">¡POCO SALDO!</span>' : '') + '</p>' +
      '<button type="button" onclick="showMovements(\'store\',' + s.id + ')">Ver movimientos</button></div>';
  }).join('') : '<p>Ninguno.</p>');
  html += '<div id="movements-box"></div>';
  contentEl.innerHTML = html;
}

async function loadCredit() {
  var type = document.getElementById('credit-type').value;
  var subjectId = Number(type === 'driver' ? document.getElementById('credit-driver').value : document.getElementById('credit-store').value);
  var amount = Number(document.getElementById('credit-amount').value);
  var note = document.getElementById('credit-note').value;
  try {
    await api('/api/admin?credit=1', 'POST', { owner_type: type, owner_id: subjectId, amount: amount, note: note });
    showMessage('Créditos cargados.', 'ok');
    renderTab();
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

async function showMovements(ownerType, ownerId) {
  var box = document.getElementById('movements-box');
  if (!box) return;
  box.innerHTML = 'Cargando movimientos…';
  try {
    var rows = await api('/api/admin?movements=1&owner_type=' + encodeURIComponent(ownerType) + '&owner_id=' + encodeURIComponent(ownerId));
    if (!rows.length) { box.innerHTML = '<p>Sin movimientos.</p>'; return; }
    box.innerHTML = '<h3>Movimientos</h3>' + rows.map(function (r) {
      return '<div class="card"><p>' + esc(new Date(r.created_at).toLocaleString('es-UY')) + ' — <strong>' + money(r.amount) + '</strong> · ' + esc(r.reason || '') + (r.order_id ? ' (pedido #' + r.order_id + ')' : '') + '</p></div>';
    }).join('');
  } catch (e) {
    box.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
  }
}

// ---- Comercio ----
async function renderStoreForm() {
  var me;
  try { me = await api('/api/users?me=1'); } catch (e) { me = null; }
  var store = null;
  try { store = await api('/api/stores?mine=1'); } catch (e) { store = null; }
  var days = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  var closed = store ? String(store.closed_weekdays || '').split(',').filter(function (x) { return x !== ''; }) : [];
  var html = '';
  if (me && me.balance !== undefined) html += lowBalanceWarning(me.balance, me.low_threshold);
  html += '<div class="card"><h3>' + (store ? 'Editar mi comercio' : 'Crear mi comercio') + '</h3>' +
    '<label>Nombre <input id="store-name" type="text" value="' + esc(store ? store.name : '') + '"></label>' +
    '<label>Tipo <select id="store-type">' +
    ['supermercado', 'almacén', 'kiosco', '24h', 'otro'].map(function (t) { return '<option value="' + t + '"' + (store && store.type === t ? ' selected' : '') + '>' + t + '</option>'; }).join('') +
    '</select></label>' +
    '<label>Dirección <input id="store-address" type="text" value="' + esc(store ? store.address : '') + '"></label>' +
    '<label>Teléfono <input id="store-phone" type="text" value="' + esc(store ? store.phone : '') + '"></label>' +
    '<label><input id="store-24h" type="checkbox"' + (store && store.open_24h ? ' checked' : '') + '> Abierto 24 horas</label>' +
    '<label>Abre <input id="store-open" type="time" value="' + esc(store ? store.open_time : '09:00') + '"></label>' +
    '<label>Cierra <input id="store-close" type="time" value="' + esc(store ? store.close_time : '18:00') + '"></label>' +
    '<p>Si cierra antes de abrir (ej. abre 20:00 y cierra 04:00), el horario cruza la medianoche y el comercio aparece abierto de madrugada.</p>' +
    '<p>Días cerrados:</p>' + days.map(function (d, i) {
      return '<label><input type="checkbox" class="closed-day" value="' + i + '"' + (closed.indexOf(String(i)) !== -1 ? ' checked' : '') + '> ' + d + '</label>';
    }).join('') +
    '<p><button type="button" onclick="saveStore(' + (store ? 'true' : 'false') + ')">' + (store ? 'Guardar cambios' : 'Crear comercio') + '</button></p></div>';
  contentEl.innerHTML = html;
}

async function saveStore(isEdit) {
  var closed = [];
  document.querySelectorAll('.closed-day:checked').forEach(function (c) { closed.push(c.value); });
  var body = {
    name: document.getElementById('store-name').value.trim(),
    type: document.getElementById('store-type').value,
    address: document.getElementById('store-address').value.trim(),
    phone: document.getElementById('store-phone').value.trim(),
    open_24h: document.getElementById('store-24h').checked,
    open_time: document.getElementById('store-open').value,
    close_time: document.getElementById('store-close').value,
    closed_weekdays: closed.join(','),
  };
  try {
    if (isEdit) await api('/api/stores', 'PUT', body);
    else await api('/api/stores', 'POST', body);
    showMessage('Comercio guardado.', 'ok');
    renderTab();
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

var editingProductId = null;

async function renderCatalogMine() {
  var products = await api('/api/stores?products=1&mine=1').catch(function (e) { return null; });
  if (products === null) {
    contentEl.innerHTML = '<p>Primero creá tu comercio en "Mi comercio".</p>';
    return;
  }
  var html = '<div class="card"><h3>' + (editingProductId ? 'Editar producto' : 'Agregar producto') + '</h3>' +
    '<label>Nombre <input id="prod-name" type="text"></label>' +
    '<label>Descripción <input id="prod-desc" type="text"></label>' +
    '<label>Precio ($U) <input id="prod-price" type="number" min="0" step="0.01"></label>' +
    '<label>Foto <input id="prod-photo" type="file" accept="image/*"></label>' +
    '<p class="hint">La foto se comprime en tu celular a JPEG de máx 1200px y queda guardada en la base, sin servicio externo.</p>' +
    '<button type="button" onclick="saveProduct()">Guardar producto</button>' +
    (editingProductId ? '<button type="button" class="secondary" onclick="cancelProductEdit()">Cancelar edición</button>' : '') +
    '</div>';
  html += products.length ? products.map(function (p) {
    return '<div class="card">' +
      (p.photo ? '<img class="product-photo" src="' + p.photo + '" alt="">' : '') +
      '<h3>' + esc(p.name) + ' — ' + money(p.price) + (p.active ? '' : ' (inactivo)') + '</h3>' +
      '<p>' + esc(p.description || '') + '</p>' +
      '<button type="button" onclick="editProduct(' + p.id + ')">Editar</button>' +
      '<button type="button" onclick="toggleProduct(' + p.id + ',' + (p.active ? 'false' : 'true') + ')">' + (p.active ? 'Desactivar' : 'Activar') + '</button></div>';
  }).join('') : '<p>Todavía no tenés productos. Agregá el primero arriba.</p>';
  contentEl.innerHTML = html;
}

async function editProduct(productId) {
  var products = await api('/api/stores?products=1&mine=1');
  var p = products.find(function (x) { return x.id === productId; });
  if (!p) return;
  editingProductId = productId;
  await renderCatalogMine();
  document.getElementById('prod-name').value = p.name;
  document.getElementById('prod-desc').value = p.description || '';
  document.getElementById('prod-price').value = p.price;
}

function cancelProductEdit() {
  editingProductId = null;
  renderTab();
}

async function saveProduct() {
  var file = document.getElementById('prod-photo').files[0];
  var photo = null;
  var keepPhoto = editingProductId !== null && !file;
  try {
    if (file) photo = await compressPhoto(file);
    var body = {
      name: document.getElementById('prod-name').value.trim(),
      description: document.getElementById('prod-desc').value,
      price: Number(document.getElementById('prod-price').value),
    };
    if (!keepPhoto) body.photo = photo;
    if (editingProductId) await api('/api/stores?products=1&id=' + editingProductId, 'PUT', body);
    else await api('/api/stores?products=1', 'POST', body);
    editingProductId = null;
    showMessage('Producto guardado.', 'ok');
    renderTab();
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

async function toggleProduct(productId, active) {
  try {
    await api('/api/stores?products=1&id=' + productId, 'PUT', { active: active });
    renderTab();
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

async function renderMyOrders() {
  var orders = await api('/api/orders');
  if (!orders.length) { contentEl.innerHTML = '<p>No tenés pedidos todavía.</p>'; return; }
  contentEl.innerHTML = orders.map(function (o) {
    return orderCard(o, function (x) {
      if (x.status === 'disponible' || x.status === 'aceptado') {
        return '<button type="button" onclick="cancelOrder(' + x.id + ')">Cancelar pedido</button>';
      }
      return '';
    });
  }).join('');
}

async function renderMyBalance() {
  var me = await api('/api/users?me=1');
  var rows = await api('/api/users?movements=1');
  var html = '';
  if (me.balance !== undefined) html += lowBalanceWarning(me.balance, me.low_threshold);
  html += '<p>Tu saldo prepago es lo que te permite recibir pedidos. Cuando se termina, dejás de aparecer en comercios abiertos hasta recargar. La recarga la hace el admin después de que le pagues por fuera.</p>';
  html += '<h3>Movimientos</h3>' + (rows.length ? rows.map(function (r) {
    return '<div class="card"><p>' + esc(new Date(r.created_at).toLocaleString('es-UY')) + ' — <strong>' + money(r.amount) + '</strong> · ' + esc(r.reason || '') + (r.order_id ? ' (pedido #' + r.order_id + ')' : '') + '</p></div>';
  }).join('') : '<p>Sin movimientos.</p>');
  contentEl.innerHTML = html;
}

async function cancelOrder(orderId) {
  try {
    await api('/api/orders?id=' + encodeURIComponent(orderId), 'PUT', { action: 'cancel' });
    showMessage('Pedido cancelado.', 'ok');
    renderTab();
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

window.switchTab = switchTab;
window.toggleUserActive = toggleUserActive;
window.saveSettings = saveSettings;
window.loadCredit = loadCredit;
window.showMovements = showMovements;
window.saveStore = saveStore;
window.editProduct = editProduct;
window.cancelProductEdit = cancelProductEdit;
window.saveProduct = saveProduct;
window.toggleProduct = toggleProduct;
window.cancelOrder = cancelOrder;

// ---- Delivery ----
async function renderAvailability() {
  var me = await api('/api/users?me=1');
  user.online = me.online;
  localStorage.setItem('du_user', JSON.stringify(user));
  var html = '';
  if (me.balance !== undefined) html += lowBalanceWarning(me.balance, me.low_threshold);
  html += '<div class="card"><h3>¿Estás trabajando?</h3>' +
    '<p>Estado actual: <strong>' + (me.online ? 'EN LÍNEA — recibís pedidos disponibles' : 'DESCONECTADO — no recibís pedidos') + '</strong></p>' +
    '<button type="button" class="big ' + (me.online ? 'offline' : 'online') + '" onclick="toggleOnline()">' +
    (me.online ? 'Dejar de trabajar' : 'Empezar a trabajar') + '</button>' +
    '<p class="hint">Para ponerte en línea tenés que tener POS registrado. Sin saldo de créditos no podés aceptar pedidos.</p></div>';
  contentEl.innerHTML = html;
}

async function toggleOnline() {
  try {
    var me = await api('/api/users?me=1');
    var updated = await api('/api/users?online=1', 'PUT', { online: !me.online });
    user.online = updated.online;
    localStorage.setItem('du_user', JSON.stringify(user));
    showMessage(updated.online ? 'Estás en línea.' : 'Estás desconectado.', 'ok');
    renderTab();
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

async function renderAvailable() {
  var me = await api('/api/users?me=1');
  if (!me.online) {
    contentEl.innerHTML = '<p>Estás desconectado. Ponete en línea en "Disponibilidad" para ver pedidos disponibles.</p>';
    return;
  }
  var orders = await api('/api/orders?available=1');
  if (!orders.length) { contentEl.innerHTML = '<p>No hay pedidos disponibles ahora mismo.</p>'; return; }
  contentEl.innerHTML = orders.map(function (o) {
    return orderCard(o, function (x) {
      return '<button type="button" class="big" onclick="acceptOrder(' + x.id + ')">Aceptar esta entrega</button>';
    });
  }).join('');
}

async function acceptOrder(orderId) {
  try {
    await api('/api/orders?id=' + encodeURIComponent(orderId), 'PUT', { action: 'accept' });
    showMessage('Pedido aceptado. Andá al comercio, pagá y tocá "Ya tengo la orden".', 'ok');
    currentTab = 'my-deliveries';
    buildTabs();
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

async function doPickup(orderId, btn) {
  var card = btn.closest('.card');
  var input = card ? card.querySelector('input[data-field="confirmed"]') : null;
  var value = input ? Number(input.value) : NaN;
  if (!value || value <= 0) {
    showMessage('Indicá el monto real pagado en el comercio.', 'error');
    return;
  }
  try {
    var updated = await api('/api/orders?id=' + encodeURIComponent(orderId), 'PUT', { action: 'pickup', confirmed_value: value });
    showMessage('¡Ya tenés la orden! Cobrá al cliente ' + money(updated.confirmed_total) + ' al entregar.', 'ok');
    renderTab();
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

async function doDeliver(orderId, btn) {
  var card = btn.closest('.card');
  var input = card ? card.querySelector('input[data-field="collected"]') : null;
  var value = input && input.value !== '' ? Number(input.value) : null;
  try {
    await api('/api/orders?id=' + encodeURIComponent(orderId), 'PUT', { action: 'deliver', collected_amount: value });
    showMessage('¡Entrega completada! Tu ganancia y las comisiones ya quedaron registradas.', 'ok');
    renderTab();
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

async function renderMyDeliveries() {
  var orders = await api('/api/orders');
  if (!orders.length) { contentEl.innerHTML = '<p>Todavía no aceptaste ningún pedido.</p>'; return; }
  contentEl.innerHTML = orders.map(function (o) {
    return orderCard(o, function (x) {
      if (x.status === 'aceptado') {
        return '<button type="button" onclick="cancelOrder(' + x.id + ')">Cancelar (liberar pedido)</button>';
      }
      return '';
    });
  }).join('');
}

async function renderProfile() {
  var me = await api('/api/users?me=1');
  var rows = await api('/api/users?movements=1');
  var html = '<div class="card"><h3>' + esc(me.name) + '</h3>' +
    '<p>Tel: ' + esc(me.phone) + ' · Vehículo: ' + esc(me.vehicle || '') + ' · RUT: ' + esc(me.monotributo_rut || '') + '</p>' +
    '<p>POS: ' + esc(me.pos_provider || '') + ' · ' + esc(me.pos_terminal || '') + '</p>' +
    '<p>Calificación: ' + starsText(me.avg_stars, me.ratings_count) + '</p></div>';
  if (me.balance !== undefined) html += lowBalanceWarning(me.balance, me.low_threshold);
  html += '<h3>Movimientos de créditos</h3>' + (rows.length ? rows.map(function (r) {
    return '<div class="card"><p>' + esc(new Date(r.created_at).toLocaleString('es-UY')) + ' — <strong>' + money(r.amount) + '</strong> · ' + esc(r.reason || '') + (r.order_id ? ' (pedido #' + r.order_id + ')' : '') + '</p></div>';
  }).join('') : '<p>Sin movimientos.</p>');
  contentEl.innerHTML = html;
}

// ---- PIN propio ----
function renderPin() {
  contentEl.innerHTML = '<div class="card"><h3>Cambiar mi PIN</h3>' +
    '<label>PIN nuevo (mínimo 4 caracteres) <input id="new-pin" type="password" inputmode="numeric"></label>' +
    '<button type="button" onclick="changePin()">Cambiar PIN</button></div>';
}

async function changePin() {
  var pin = document.getElementById('new-pin').value;
  try {
    await api('/api/auth?action=change-pin', 'POST', { new_pin: pin });
    showMessage('PIN cambiado.', 'ok');
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

// ---- Cableado y arranque ----
document.querySelectorAll('[data-nav]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var target = btn.getAttribute('data-nav');
    if (target === 'app' && user) { showApp(); return; }
    showView(target);
  });
});

document.getElementById('logout-btn').addEventListener('click', logout);

document.getElementById('login-form').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  var errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  try {
    var data = await api('/api/auth', 'POST', {
      role: document.getElementById('login-role').value,
      name: document.getElementById('login-name').value.trim(),
      pin: document.getElementById('login-pin').value,
    });
    token = data.token;
    user = data.user;
    localStorage.setItem('du_token', token);
    localStorage.setItem('du_user', JSON.stringify(user));
    currentTab = null;
    showApp();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('reg-role').addEventListener('change', function () {
  document.getElementById('delivery-fields').style.display =
    document.getElementById('reg-role').value === 'delivery' ? 'block' : 'none';
});

document.getElementById('register-form').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  var errEl = document.getElementById('register-error');
  var okEl = document.getElementById('register-ok');
  errEl.classList.add('hidden');
  okEl.classList.add('hidden');
  var role = document.getElementById('reg-role').value;
  var body = {
    role: role,
    name: document.getElementById('reg-name').value.trim(),
    phone: document.getElementById('reg-phone').value.trim(),
    pin: document.getElementById('reg-pin').value,
  };
  if (role === 'delivery') {
    body.vehicle = document.getElementById('reg-vehicle').value;
    body.monotributo_rut = document.getElementById('reg-rut').value.trim();
    body.pos_provider = document.getElementById('reg-pos-provider').value.trim();
    body.pos_terminal = document.getElementById('reg-pos-terminal').value.trim();
  }
  try {
    await api('/api/users', 'POST', body);
    okEl.textContent = '¡Cuenta creada! Ahora ingresá con tu nombre y PIN.';
    okEl.classList.remove('hidden');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('create-order-btn').addEventListener('click', createOrder);
document.getElementById('otros-value').addEventListener('input', renderBreakdown);
document.getElementById('track-btn').addEventListener('click', function () { loadTrack(); });

window.toggleOnline = toggleOnline;
window.acceptOrder = acceptOrder;
window.doPickup = doPickup;
window.doDeliver = doDeliver;
window.changePin = changePin;

// Arranque: sesión guardada, seguimiento por URL (?pedido=ID) o inicio.
(function init() {
  var params = new URLSearchParams(window.location.search);
  var pedido = params.get('pedido');
  if (token && user) {
    showApp();
    return;
  }
  if (pedido) {
    showView('track');
    document.getElementById('track-id').value = pedido;
    loadTrack(Number(pedido));
    return;
  }
  showView('home');
})();

})();
