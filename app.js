// Delivery Uruguay — app de una sola página (JavaScript sin compilación).
// Roles staff: admin (solo por Acceso dueño), comercio, delivery (ingreso con
// PIN). Clientes: cuenta propia con email + contraseña o Google. Los clientes
// también pueden pedir sin login (invitados).
// Moneda: $U. Horarios: America/Montevideo (el filtro de abiertos lo hace la API).

(function () {
'use strict';

var token = localStorage.getItem('du_token') || '';
var user = null;
try { user = JSON.parse(localStorage.getItem('du_user') || 'null'); } catch (e) { user = null; }

var loginView = document.getElementById('login-view');
var ownerLoginView = document.getElementById('owner-login-view');
var customerLoginView = document.getElementById('customer-login-view');
var customerRegisterView = document.getElementById('customer-register-view');
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
var googleClientId = '';
var googleScriptLoading = false;

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

// Cédula uruguaya — MISMA función que el backend (api/_db.js validateCI):
// solo dígitos, 8 dígitos (con ceros a la izquierda si hace falta), pesos
// [2,9,8,7,6,3,4] sobre los 7 primeros, verificador = (10 - suma%10) % 10.
function validateCI(ci) {
  var digits = String(ci || '').replace(/\D/g, '');
  if (!digits) return false;
  if (digits.length <= 8) {
    while (digits.length < 8) digits = '0' + digits;
  }
  if (!/^\d{8}$/.test(digits)) return false;
  var weights = [2, 9, 8, 7, 6, 3, 4];
  var sum = 0;
  for (var i = 0; i < 7; i++) sum += Number(digits[i]) * weights[i];
  var check = (10 - (sum % 10)) % 10;
  return check === Number(digits[7]);
}

// Teléfonos uruguayos para WhatsApp y llamadas: solo dígitos, se saca el
// 0 inicial y se agrega el prefijo 598 si no lo tiene (ej. 099123456 ->
// 59899123456; 59899123456 queda igual).
function normalizeUYPhone(phone) {
  var d = String(phone || '').replace(/[^0-9]/g, '');
  if (!d) return '';
  if (d.indexOf('598') === 0) return d;
  if (d.charAt(0) === '0') d = d.slice(1);
  return '598' + d;
}

// Links con un toque: WhatsApp (wa.me) y llamada (tel:).
function phoneLinks(phone) {
  var n = normalizeUYPhone(phone);
  if (!n) return '';
  return '<a href="https://wa.me/' + n + '">WhatsApp</a> · <a href="tel:+' + n + '">Llamar</a>';
}

// Distancia legible: menos de 1 km se muestra en metros.
function fmtKm(km) {
  var n = Number(km);
  if (!Number.isFinite(n)) return '';
  if (n < 1) return Math.round(n * 1000) + ' m';
  return n.toFixed(1) + ' km';
}

// Geolocalización del navegador: NUNCA rechaza; null = sin permiso, sin
// soporte o error. El flujo sigue igual (sin filtrar, mostrando todo).
function getPosition() {
  return new Promise(function (resolve) {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(function (pos) {
      resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    }, function () { resolve(null); }, { timeout: 10000, maximumAge: 60000 });
  });
}

// Ubicaciones en memoria de esta sesión: la del cliente (para cercanía de
// comercios) y la del delivery (para filtrar por radio). Nunca se guardan
// en la base: se mandan solo como parámetros de cada consulta.
var customerLoc = null;
var driverLoc = null;

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
  ownerLoginView.classList.add('hidden');
  customerLoginView.classList.add('hidden');
  customerRegisterView.classList.add('hidden');
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
  if (name === 'owner-login') ownerLoginView.classList.remove('hidden');
  if (name === 'customer-login') { customerLoginView.classList.remove('hidden'); initGoogleButtons(); }
  if (name === 'customer-register') { customerRegisterView.classList.remove('hidden'); initGoogleButtons(); }
  if (name === 'register') registerView.classList.remove('hidden');
  if (name === 'app') { appView.classList.remove('hidden'); }
  window.scrollTo(0, 0);
}

function roleLabel(role) {
  var map = { admin: 'dueño', comercio: 'comercio', delivery: 'delivery', customer: 'cliente' };
  return map[role] || role;
}

function showLogin() {
  userBar.classList.add('hidden');
  showView('login');
}

function showApp() {
  userBar.classList.remove('hidden');
  userNameEl.textContent = user.name + ' (' + roleLabel(user.role) + ')';
  showView('app');
  if (!currentTab) {
    currentTab = user.role === 'admin' ? 'admin-stores' :
      user.role === 'comercio' ? 'store' :
      user.role === 'customer' ? 'customer-account' : 'availability';
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
    googleClientId = settings.google_client_id || '';
    var url = '/api/stores?open=1';
    if (customerLoc) url += '&lat=' + encodeURIComponent(customerLoc.lat) + '&lng=' + encodeURIComponent(customerLoc.lng);
    var stores = await api(url);
    metaEl.innerHTML = 'Hora en Montevideo: <strong>' + esc(montevideoTimeText()) + '</strong> · Envío: <strong>' + driverPct + '%</strong> de la mercadería (se cobra al recibir). Solo se muestran comercios abiertos ahora.' +
      (customerLoc
        ? ' <br>Ordenados del más cercano. <button type="button" class="secondary" onclick="useCustomerLocation()">Actualizar mi ubicación</button>'
        : ' <button type="button" class="secondary" onclick="useCustomerLocation()">Usar mi ubicación para ver cercanía</button>');
    if (!stores.length) {
      listEl.innerHTML = '<p>No hay comercios abiertos en este momento. Probá más tarde.</p>';
      return;
    }
    listEl.innerHTML = stores.map(function (s) {
      return '<div class="card">' +
        '<h3>' + esc(s.name) + '</h3>' +
        '<p>' + esc(s.type) + ' · ' + esc(s.address) + '</p>' +
        (s.distance_km !== null && s.distance_km !== undefined ? '<p>A <strong>' + fmtKm(s.distance_km) + '</strong> de vos</p>' : '') +
        '<p>' + starsText(s.avg_stars, s.ratings_count) + '</p>' +
        '<p>Horario: ' + (s.open_24h ? 'Abierto 24 horas' : esc(s.open_time) + ' – ' + esc(s.close_time)) + '</p>' +
        '<button type="button" onclick="openCatalog(' + s.id + ')">Ver catálogo y pedir</button>' +
        '</div>';
    }).join('');
  } catch (e) {
    listEl.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
  }
}

async function useCustomerLocation() {
  var pos = await getPosition();
  if (!pos) {
    showMessage('No se pudo obtener tu ubicación (permiso negado o sin GPS). Se muestran todos los comercios.', 'error');
    return;
  }
  customerLoc = pos;
  showMessage('Ubicación activa: comercios ordenados del más cercano.', 'ok');
  loadOpenStores();
}

async function useDriverLocation() {
  var pos = await getPosition();
  if (!pos) {
    showMessage('No se pudo obtener tu ubicación (permiso negado o sin GPS). Se muestran todos los pedidos.', 'error');
    return;
  }
  driverLoc = pos;
  showMessage('Ubicación activa: solo ves pedidos dentro de tu radio.', 'ok');
  renderTab();
}

async function useStoreLocation() {
  var pos = await getPosition();
  var statusEl = document.getElementById('store-loc-status');
  if (!pos) {
    showMessage('No se pudo obtener tu ubicación (permiso negado o sin GPS).', 'error');
    return;
  }
  document.getElementById('store-lat').value = pos.lat;
  document.getElementById('store-lng').value = pos.lng;
  if (statusEl) statusEl.textContent = 'Ubicación lista para guardar: ' + pos.lat.toFixed(5) + ', ' + pos.lng.toFixed(5) + ' (guardá el formulario).';
  showMessage('Ubicación capturada. Guardá el formulario para aplicarla.', 'ok');
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
    googleClientId = settings.google_client_id || '';
    var products = await api('/api/stores?products=1&store_id=' + encodeURIComponent(storeId));
    var openStores = await api('/api/stores?open=1');
    var storeWithRating = openStores.find(function (s) { return s.id === store.id; });
    currentStore = store;
    currentCatalog = products;
    cart = {};
    // Cliente logueado: prellenar sus datos en el checkout.
    if (user && user.role === 'customer') {
      document.getElementById('cust-name').value = user.name || '';
      document.getElementById('cust-phone').value = user.phone || '';
      document.getElementById('cust-address').value = user.default_address || '';
    }
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
      '<p>' + esc(order.items) + '</p>';
    if (order.lines && order.lines.length) {
      html += '<ul>' + order.lines.map(function (l) {
        var badge = l.item_status === 'sin_stock' ? ' <span class="badge badge-cancelado">Sin stock</span>' :
          l.item_status === 'levantado' ? ' <span class="badge badge-entregado">Levantado</span>' : '';
        return '<li>' + l.qty + 'x ' + esc(l.name) + ' (' + money(l.price) + ' c/u)' + badge + '</li>';
      }).join('') + '</ul>';
    }
    if (order.status === 'cancelado' && order.cancel_reason) {
      html += '<p class="error">Motivo: ' + esc(order.cancel_reason) + '</p>';
    }
    html +=
      '<p>Entrega en: ' + esc(order.delivery_address) + '</p>' +
      '<p>Subtotal mercadería: <strong>' + money(order.merchandise_vigente) + '</strong></p>' +
      '<p>Envío: <strong>' + money(order.delivery_fee_vigente) + '</strong></p>' +
      '<p>TOTAL a pagar al delivery: <strong>' + money(order.total_vigente) + '</strong>' +
      (order.confirmed_total !== null ? ' (actualizado al confirmar el delivery)' : '') + '</p>';
    if (order.status !== 'disponible') {
      html += '<p>Delivery: ' + esc(order.driver_name || '') + (order.driver_phone ? ' · ' + phoneLinks(order.driver_phone) : '') + '</p>';
      html += '<p>Comercio: ' + esc(order.store_phone || '') + (order.store_phone ? ' · ' + phoneLinks(order.store_phone) : '') + '</p>';
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
    { id: 'admin-customers', label: 'Clientes' },
    { id: 'admin-orders', label: 'Pedidos' },
    { id: 'admin-settings', label: 'Ajustes' },
    { id: 'admin-balances', label: 'Saldos y créditos' },
    { id: 'admin-reports', label: 'Reportes' },
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

function customerTabs() {
  return [
    { id: 'customer-account', label: 'Mi cuenta' },
    { id: 'customer-orders', label: 'Mis pedidos' },
  ];
}

function buildTabs() {
  var tabs = user.role === 'admin' ? adminTabs() : user.role === 'comercio' ? comercioTabs() : user.role === 'customer' ? customerTabs() : driverTabs();
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
    (user && user.role === 'delivery' && o.status === 'disponible' ? '' : '<p>Cliente: ' + esc(o.customer_name) + (o.customer_phone ? ' · ' + phoneLinks(o.customer_phone) : '') + '</p>') +
    '<p>Entrega en: ' + esc(o.delivery_address) + '</p>' +
    '<p>Mercadería: ' + money(o.confirmed_value !== null ? o.confirmed_value : o.merchandise_value) +
    ' · Envío: ' + money(o.confirmed_delivery_fee !== null ? o.confirmed_delivery_fee : o.delivery_fee) +
    ' · Total: <strong>' + money(o.confirmed_total !== null ? o.confirmed_total : o.total) + '</strong></p>';
  if (o.driver_name) html += '<p>Delivery: ' + esc(o.driver_name) + (o.driver_phone && o.status !== 'disponible' ? ' · ' + phoneLinks(o.driver_phone) : '') + '</p>';
  if (o.distance_km !== null && o.distance_km !== undefined) html += '<p>Distancia al comercio: <strong>' + fmtKm(o.distance_km) + '</strong></p>';
  if (o.store_ready) html += '<p class="ok">✓ El comercio ya lo tiene armado y listo.</p>';
  if (o.status === 'aceptado' && user.role === 'delivery') {
    html += '<p><strong>Pagar en comercio: ' + money(o.merchandise_value) + ' (estimado)</strong></p>' +
      '<p class="hint">Antes de retirar, marcá cada ítem en el checklist: lo que levantás y lo que está sin stock. El total a cobrar se calcula solo con lo levantado. Para ítems "otros", indicá cuánto pagaste.</p>' +
      '<button type="button" class="big" onclick="openChecklist(' + o.id + ')">Checklist de retiro</button>';
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
    'admin-customers': renderAdminCustomers,
    'admin-orders': renderAdminOrders,
    'admin-settings': renderAdminSettings,
    'admin-balances': renderAdminBalances,
    'admin-reports': renderAdminReports,
    'store': renderStoreForm,
    'catalog-mine': renderCatalogMine,
    'my-orders': renderMyOrders,
    'my-balance': renderMyBalance,
    'availability': renderAvailability,
    'available': renderAvailable,
    'my-deliveries': renderMyDeliveries,
    'profile': renderProfile,
    'customer-account': renderCustomerAccount,
    'customer-orders': renderCustomerOrders,
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
      '<p>Tel: ' + esc(d.phone) + ' · Vehículo: ' + esc(d.vehicle || '') + '</p>' +
      '<p>RUT: ' + esc(d.monotributo_rut || '—') + ' · Razón social: ' + esc(d.razon_social || '—') + '</p>' +
      '<p>POS: ' + esc(d.pos_provider || '') + ' · ' + esc(d.pos_terminal || '') + '</p>' +
      '<p>En línea: ' + (d.online ? 'Sí' : 'No') + ' · Activo: ' + (d.active ? 'Sí' : 'No') + '</p>' +
      '<button type="button" onclick="toggleUserActive(' + d.id + ', true)">Reactivar</button>' +
      '<button type="button" onclick="toggleUserActive(' + d.id + ', false)">Suspender</button></div>';
  }).join('');
}

async function renderAdminCustomers() {
  var customers = await api('/api/admin?customers=1');
  if (!customers.length) { contentEl.innerHTML = '<p>No hay clientes registrados todavía. Los invitados aparecen en sus pedidos, no acá.</p>'; return; }
  contentEl.innerHTML = customers.map(function (c) {
    return '<div class="card"><h3>' + esc(c.full_name) + '</h3>' +
      '<p>CI: ' + esc(c.ci || '—') + ' · Email: ' + esc(c.email) + ' · Tel: ' + esc(c.phone) + '</p>' +
      '<p>Dirección: ' + esc(c.default_address || '—') + ' · Google: ' + (c.google_linked ? 'Sí' : 'No') + ' · Activo: ' + (c.active ? 'Sí' : 'No') + '</p>' +
      '<button type="button" onclick="toggleCustomerActive(' + c.id + ', true)">Reactivar</button>' +
      '<button type="button" onclick="toggleCustomerActive(' + c.id + ', false)">Suspender</button></div>';
  }).join('');
}

async function toggleCustomerActive(customerId, active) {
  try {
    await api('/api/admin?customers=1&id=' + encodeURIComponent(customerId), 'PUT', { active: active });
    showMessage(active ? 'Cliente reactivado.' : 'Cliente suspendido.', 'ok');
    renderTab();
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

async function renderAdminReports() {
  var stores = await api('/api/stores');
  var drivers = await api('/api/users?role=delivery');
  var today = new Date().toISOString().slice(0, 10);
  var from = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  contentEl.innerHTML = '<div class="card"><h3>Reportes</h3>' +
    '<label>Desde <input id="rep-from" type="date" value="' + from + '"></label>' +
    '<label>Hasta <input id="rep-to" type="date" value="' + today + '"></label>' +
    '<label>Comercio <select id="rep-store"><option value="">Todos</option>' + stores.map(function (s) { return '<option value="' + s.id + '">' + esc(s.name) + '</option>'; }).join('') + '</select></label>' +
    '<label>Delivery <select id="rep-driver"><option value="">Todos</option>' + drivers.map(function (d) { return '<option value="' + d.id + '">' + esc(d.name) + '</option>'; }).join('') + '</select></label>' +
    '<button type="button" class="big" onclick="loadReports()">Ver reportes</button></div>' +
    '<div id="reports-box"></div>';
  loadReports();
}

async function loadReports() {
  var box = document.getElementById('reports-box');
  if (!box) return;
  box.innerHTML = 'Cargando…';
  var from = document.getElementById('rep-from').value;
  var to = document.getElementById('rep-to').value;
  var storeId = document.getElementById('rep-store').value;
  var driverId = document.getElementById('rep-driver').value;
  try {
    var q = '/api/admin?reports=1&from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
    if (storeId) q += '&store_id=' + encodeURIComponent(storeId);
    if (driverId) q += '&driver_id=' + encodeURIComponent(driverId);
    var r = await api(q);
    var t = r.totals;
    var html = '<div class="card"><h3>Totales del período (' + esc(r.from) + ' a ' + esc(r.to) + ')</h3>' +
      '<p>Pedidos entregados: <strong>' + t.delivered_count + '</strong></p>' +
      '<p>Mercadería total: <strong>' + money(t.merchandise) + '</strong></p>' +
      '<p>Envíos totales: <strong>' + money(t.delivery_fees) + '</strong></p>' +
      '<p>Ganancia total de deliveries: <strong>' + money(t.driver_earnings) + '</strong></p>' +
      '<p>Corte plataforma desde deliveries: <strong>' + money(t.platform_from_driver) + '</strong></p>' +
      '<p>Corte plataforma desde comercios: <strong>' + money(t.platform_from_store) + '</strong></p>' +
      '<p>Créditos cargados: <strong>' + money(t.credits_loaded) + '</strong></p>' +
      '<p>Créditos descontados: <strong>' + money(t.credits_deducted) + '</strong></p></div>';
    html += '<h3>Por comercio</h3>' + (r.by_store.length ? r.by_store.map(function (s) {
      return '<div class="card"><p><strong>' + esc(s.name) + '</strong> — ' + s.orders + ' pedidos · mercadería ' + money(s.merchandise) + ' · corte ' + money(s.platform_cut) + '</p></div>';
    }).join('') : '<p>Sin datos.</p>');
    html += '<h3>Por delivery</h3>' + (r.by_driver.length ? r.by_driver.map(function (d) {
      return '<div class="card"><p><strong>' + esc(d.name) + '</strong> — ' + d.orders + ' pedidos · mercadería ' + money(d.merchandise) + ' · ganancia ' + money(d.earnings) + ' · corte ' + money(d.platform_cut) + '</p></div>';
    }).join('') : '<p>Sin datos.</p>');
    html += '<h3>Pedidos del período</h3>' + (r.orders.length ? r.orders.map(function (o) {
      return '<div class="card"><p><strong>Pedido #' + o.id + '</strong> — ' + esc(o.store_name) + ' · ' + esc(o.customer_name) + ' · <span class="status ' + esc(o.status) + '">' + esc(statusLabel(o.status)) + '</span> · total ' + money(o.total) + '</p></div>';
    }).join('') : '<p>Sin pedidos en el período.</p>');
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
  }
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
    '<label>ID de cliente de Google (para "Continuar con Google"; vacío = desactivado) <input id="set-google-id" type="text" value="' + esc(s.google_client_id || '') + '" placeholder="xxxx.apps.googleusercontent.com"></label>' +
    '<p class="hint">El ID se crea gratis en Google Cloud Console (ver README). Es público por diseño: solo habilita el botón de Google.</p>' +
    '<button type="button" onclick="saveSettings()">Guardar ajustes</button></div>';
}

async function saveSettings() {
  try {
    await api('/api/admin?settings=1', 'PUT', {
      driver_pct: Number(document.getElementById('set-driver-pct').value),
      platform_driver_pct: Number(document.getElementById('set-platform-driver-pct').value),
      store_pct: Number(document.getElementById('set-store-pct').value),
      low_balance_threshold: Number(document.getElementById('set-threshold').value),
      google_client_id: document.getElementById('set-google-id').value.trim(),
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
    '<p id="store-loc-status">' + (store && store.lat !== null && store.lat !== undefined && store.lng !== null && store.lng !== undefined ? 'Ubicación guardada: ' + esc(Number(store.lat).toFixed(5)) + ', ' + esc(Number(store.lng).toFixed(5)) : 'Sin ubicación guardada: guardala para que los deliveries te encuentren por cercanía.') + '</p>' +
    '<p><button type="button" class="secondary" onclick="useStoreLocation()">Usar mi ubicación actual</button></p>' +
    '<input id="store-lat" type="hidden" value="' + (store && store.lat !== null && store.lat !== undefined ? esc(store.lat) : '') + '">' +
    '<input id="store-lng" type="hidden" value="' + (store && store.lng !== null && store.lng !== undefined ? esc(store.lng) : '') + '">' +
    '<label><input id="store-24h" type="checkbox"' + (store && store.open_24h ? ' checked' : '') + '> Abierto 24 horas</label>' +
    (store ? '<label><input id="store-paused" type="checkbox"' + (store.paused ? ' checked' : '') + '> Pausar tienda temporalmente (no aparecés en comercios abiertos hasta reanudar)</label>' +
    (store.paused ? '<p class="warning">Tu tienda está pausada: no aparecés en el listado de clientes.</p>' : '') : '') +
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
    paused: document.getElementById('store-paused') ? document.getElementById('store-paused').checked : undefined,
    lat: document.getElementById('store-lat') ? (document.getElementById('store-lat').value === '' ? null : Number(document.getElementById('store-lat').value)) : undefined,
    lng: document.getElementById('store-lng') ? (document.getElementById('store-lng').value === '' ? null : Number(document.getElementById('store-lng').value)) : undefined,
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
      '<h3>' + esc(p.name) + ' — ' + money(p.price) + (p.active ? '' : ' (inactivo)') + (p.out_of_stock ? ' <span class="badge badge-cancelado">Sin stock</span>' : '') + '</h3>' +
      '<p>' + esc(p.description || '') + '</p>' +
      '<button type="button" onclick="editProduct(' + p.id + ')">Editar</button>' +
      '<button type="button" onclick="toggleProduct(' + p.id + ',' + (p.active ? 'false' : 'true') + ')">' + (p.active ? 'Desactivar' : 'Activar') + '</button>' +
      (p.out_of_stock ? '<button type="button" onclick="restockProduct(' + p.id + ')">Volver a poner en stock</button>' : '') + '</div>';
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

async function restockProduct(productId) {
  try {
    await api('/api/stores?products=1&id=' + productId, 'PUT', { out_of_stock: false });
    showMessage('Producto de nuevo en stock: ya aparece en el catálogo.', 'ok');
    renderTab();
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

async function renderMyOrders() {
  var orders = await api('/api/orders');
  if (!orders.length) { contentEl.innerHTML = '<p>No tenés pedidos todavía.</p>'; return; }
  var html = '';
  // Aviso destacado al comercio: órdenes aceptadas, en camino, para armar ya.
  if (user.role === 'comercio') {
    var accepted = orders.filter(function (o) { return o.status === 'aceptado'; });
    if (accepted.length) {
      var details = await Promise.all(accepted.map(function (o) {
        return api('/api/orders?id=' + encodeURIComponent(o.id)).catch(function () { return null; });
      }));
      html += '<div class="notice"><h3>🚨 Órdenes en camino — armalas ahora</h3>' +
        '<p>Estos pedidos ya tienen delivery asignado en camino. Armá los ítems y marcá "Pedido armado y listo".</p></div>';
      details.forEach(function (d, i) {
        if (!d) return;
        var o = accepted[i];
        var linesHtml = (d.lines || []).map(function (l) {
          return '<li>' + l.qty + 'x ' + esc(l.name) + '</li>';
        }).join('');
        html += '<div class="card notice-card"><h3>Pedido #' + d.id + ' — ' + esc(d.customer_name) + '</h3>' +
          '<p>Cliente: ' + esc(d.customer_name) + (d.customer_phone ? ' · ' + phoneLinks(d.customer_phone) : '') + '</p>' +
          '<p>Entrega en: ' + esc(d.delivery_address) + '</p>' +
          '<p>Delivery: ' + esc(d.driver_name || '') + (d.driver_phone ? ' · ' + phoneLinks(d.driver_phone) : '') + '</p>' +
          '<p>Aceptado: ' + esc(d.accepted_at ? new Date(d.accepted_at).toLocaleString('es-UY') : '') + '</p>' +
          '<ul>' + linesHtml + '</ul>' +
          (d.store_ready
            ? '<p class="ok">✓ Marcado como armado y listo.</p>'
            : '<button type="button" class="big" onclick="markStoreReady(' + d.id + ')">Pedido armado y listo</button>') +
          '</div>';
      });
    }
  }
  html += orders.map(function (o) {
    return orderCard(o, function (x) {
      if (x.status === 'disponible' || x.status === 'aceptado') {
        return '<button type="button" onclick="cancelOrder(' + x.id + ')">Cancelar pedido</button>';
      }
      return '';
    });
  }).join('');
  contentEl.innerHTML = html;
}

async function markStoreReady(orderId) {
  try {
    await api('/api/orders?ready=1&id=' + encodeURIComponent(orderId), 'PUT', { store_ready: true });
    showMessage('Pedido marcado como armado y listo. El delivery ya lo ve.', 'ok');
    renderTab();
  } catch (e) {
    showMessage(e.message, 'error');
  }
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
  if (!window.confirm('¿Seguro que querés cancelar este pedido? Esta acción no se puede deshacer.')) return;
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
window.useCustomerLocation = useCustomerLocation;
window.useDriverLocation = useDriverLocation;
window.useStoreLocation = useStoreLocation;
window.saveRadius = saveRadius;

// ---- Delivery ----
async function renderAvailability() {
  var me = await api('/api/users?me=1');
  user.online = me.online;
  localStorage.setItem('du_user', JSON.stringify(user));
  var html = '';
  if (me.balance !== undefined) html += lowBalanceWarning(me.balance, me.low_threshold);
  if (me.stage2_complete === false) {
    html += '<div class="notice"><h3>Completá los datos de tu empresa para empezar a recibir pedidos</h3>' +
      '<p>Te falta: ' + esc((me.stage2_missing || []).join(', ')) + '</p>' +
      '<button type="button" class="big" onclick="goToProfile()">Completar etapa 2</button></div>';
  }
  html += '<div class="card"><h3>¿Estás trabajando?</h3>' +
    '<p>Estado actual: <strong>' + (me.online ? 'EN LÍNEA — recibís pedidos disponibles' : 'DESCONECTADO — no recibís pedidos') + '</strong></p>' +
    '<button type="button" class="big ' + (me.online ? 'offline' : 'online') + '" onclick="toggleOnline()">' +
    (me.online ? 'Dejar de trabajar' : 'Empezar a trabajar') + '</button>' +
    '<p class="hint">Para ponerte en línea tenés que tener los datos de tu empresa y tu POS completos. Sin saldo de créditos no podés aceptar pedidos.</p></div>';
  contentEl.innerHTML = html;
}

function goToProfile() {
  currentTab = 'profile';
  buildTabs();
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
  var radius = me.work_radius_km !== undefined && me.work_radius_km !== null ? me.work_radius_km : 30;
  var url = '/api/orders?available=1';
  if (driverLoc) url += '&lat=' + encodeURIComponent(driverLoc.lat) + '&lng=' + encodeURIComponent(driverLoc.lng);
  var orders = await api(url);
  var head = '<div class="card"><h3>Pedidos disponibles</h3>' +
    '<p>Tu radio de trabajo: <strong>' + esc(radius) + ' km</strong> (se cambia en "Mi perfil").</p>' +
    (driverLoc
      ? '<p>Ubicación activa: solo ves pedidos de comercios a menos de ' + esc(radius) + ' km. <button type="button" class="secondary" onclick="useDriverLocation()">Actualizar mi ubicación</button></p>'
      : '<p>Sin ubicación: se muestran todos los pedidos. <button type="button" onclick="useDriverLocation()">Usar mi ubicación para filtrar por radio</button></p>') +
    '</div>';
  if (!orders.length) { contentEl.innerHTML = head + '<p>No hay pedidos disponibles ahora mismo.</p>'; return; }
  contentEl.innerHTML = head + orders.map(function (o) {
    return orderCard(o, function (x) {
      return '<p><strong>Tu ganancia: ' + money(x.delivery_fee) + '</strong> · Total a cobrar al cliente: <strong>' + money(x.total) + '</strong></p>' +
        '<button type="button" class="big" onclick="acceptOrder(' + x.id + ')">Aceptar esta entrega</button>';
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

// ---- Cliente ----
async function renderCustomerAccount() {
  var me = await api('/api/users?customer=me');
  var html = '';
  if (!me.profile_complete) {
    html += '<div class="notice"><h3>Completá tus datos para poder pedir</h3>' +
      '<p>Faltan tu cédula, teléfono o dirección. Con el perfil completo podés pedir con tus datos ya cargados.</p></div>';
  }
  html += '<div class="card"><h3>Mi cuenta</h3>' +
    '<label>Nombre completo <input id="ca-name" type="text" value="' + esc(me.full_name) + '"></label>' +
    '<label>Cédula de identidad ' + (me.ci
      ? '<input type="text" value="' + esc(me.ci) + '" disabled><span class="hint">La cédula no se puede cambiar.</span>'
      : '<input id="ca-ci" type="text" inputmode="numeric" placeholder="8 dígitos, sin puntos ni guiones" required>') + '</label>' +
    '<label>Email <input type="email" value="' + esc(me.email) + '" disabled></label>' +
    '<label>Teléfono <input id="ca-phone" type="text" value="' + esc(me.phone) + '"></label>' +
    '<label>Dirección de entrega <input id="ca-address" type="text" value="' + esc(me.default_address || '') + '"></label>' +
    '<label>Contraseña nueva (opcional, mínimo 6 caracteres) <input id="ca-password" type="password"></label>' +
    '<button type="button" class="big" onclick="saveCustomerAccount()">Guardar cambios</button></div>';
  html += '<p><button type="button" onclick="switchTab(\'customer-orders\')">Ver mis pedidos</button></p>';
  contentEl.innerHTML = html;
}

async function saveCustomerAccount() {
  var body = {
    full_name: document.getElementById('ca-name').value.trim(),
    phone: document.getElementById('ca-phone').value.trim(),
    default_address: document.getElementById('ca-address').value.trim(),
  };
  var ciEl = document.getElementById('ca-ci');
  if (ciEl) {
    if (!validateCI(ciEl.value.trim())) {
      showMessage('La cédula no es válida (8 dígitos con dígito verificador).', 'error');
      return;
    }
    body.ci = ciEl.value.trim();
  }
  var pw = document.getElementById('ca-password').value;
  if (pw) body.password = pw;
  try {
    var updated = await api('/api/users?customer=me', 'PUT', body);
    user.name = updated.full_name;
    user.phone = updated.phone;
    user.default_address = updated.default_address;
    user.profile_complete = updated.profile_complete;
    localStorage.setItem('du_user', JSON.stringify(user));
    showMessage(updated.profile_complete ? 'Datos guardados. Ya podés pedir.' : 'Datos guardados. Todavía falta completar tu perfil.', updated.profile_complete ? 'ok' : 'error');
    renderTab();
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

async function renderCustomerOrders() {
  var me = await api('/api/users?customer=me');
  if (!me.orders.length) { contentEl.innerHTML = '<p>Todavía no hiciste pedidos. Cuando pidas, acá vas a ver tu historial.</p>'; return; }
  contentEl.innerHTML = me.orders.map(function (o) {
    var full = {
      id: o.id, store_name: o.store_name, status: o.status, items: o.items,
      customer_name: me.full_name, customer_phone: me.phone, delivery_address: '',
      merchandise_value: o.merchandise_value, delivery_fee: o.delivery_fee, total: o.total,
      confirmed_value: null, confirmed_delivery_fee: null, confirmed_total: o.confirmed_total,
      driver_name: null,
    };
    return orderCard(full, function (x) {
      return '<button type="button" onclick="loadTrack(' + x.id + ')">Ver seguimiento</button>';
    });
  }).join('');
}

// ---- Checklist de retiro (delivery) ----
async function openChecklist(orderId) {
  contentEl.innerHTML = 'Cargando checklist…';
  try {
    var o = await api('/api/orders?id=' + encodeURIComponent(orderId));
    renderChecklistView(o);
  } catch (e) {
    contentEl.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
  }
}

function renderChecklistView(o) {
  var lines = o.lines || [];
  window._checklistLines = lines;
  var lifted = lines.filter(function (l) { return l.item_status === 'levantado'; });
  var liftedTotal = lifted.reduce(function (s, l) { return round2(s + Number(l.price) * l.qty); }, 0);
  var allResolved = lines.length > 0 && lines.every(function (l) { return l.item_status !== 'pendiente'; });
  var allOut = lines.length > 0 && lines.every(function (l) { return l.item_status === 'sin_stock'; });
  var html = '<div class="card"><h3>Checklist de retiro — Pedido #' + o.id + ' — ' + esc(o.store_name || '') + '</h3>' +
    '<p>Cliente: ' + esc(o.customer_name) + ' · Entrega en: ' + esc(o.delivery_address) + '</p>' +
    (o.store_ready ? '<p class="ok">✓ El comercio ya lo tiene armado y listo.</p>' : '<p class="hint">El comercio todavía no lo marcó como armado.</p>') +
    '</div>';
  html += lines.map(function (l) {
    var badge = l.item_status === 'sin_stock' ? '<span class="badge badge-cancelado">Sin stock</span>' :
      l.item_status === 'levantado' ? '<span class="badge badge-entregado">Levantado</span>' :
      '<span class="badge badge-disponible">Pendiente</span>';
    return '<div class="card"><h3>' + l.qty + 'x ' + esc(l.name) + ' — ' + money(l.price) + ' c/u ' + badge + '</h3>' +
      '<button type="button" onclick="setItemStatus(' + o.id + ',' + l.id + ',\'levantado\')">✓ Levantado</button> ' +
      '<button type="button" onclick="setItemStatus(' + o.id + ',' + l.id + ',\'sin_stock\')">Sin stock</button> ' +
      '<button type="button" class="secondary" onclick="setItemStatus(' + o.id + ',' + l.id + ',\'pendiente\')">Volver a pendiente</button></div>';
  }).join('');
  var otrosInputs = lines.filter(function (l) { return l.item_status === 'levantado' && (l.product_id === null || l.product_id === undefined); }).map(function (l) {
    return '<label>¿Cuánto pagaste por ' + esc(l.name) + '? $U <input type="number" min="0" step="1" id="otros-price-' + l.id + '" value="' + l.price + '" oninput="recalcChecklistTotal()"></label>';
  }).join('');
  html += '<div class="card"><h3>Resumen</h3>' +
    (otrosInputs ? '<p>Precio pagado por ítems "otros" (sin producto de catálogo):</p>' + otrosInputs : '') +
    '<p>Total confirmado con lo levantado: <strong id="checklist-total">' + money(liftedTotal) + '</strong> (solo ítems levantados; lo sin stock no cuenta).</p>' +
    (!allResolved ? '<p class="warning">Marcá todos los ítems antes de confirmar el retiro.</p>' : '') +
    '<button type="button" class="big" onclick="doPickup(' + o.id + ')">Ya tengo la orden</button>' +
    (allOut ? '<button type="button" onclick="cancelAllOutOfStock(' + o.id + ')">Cancelar pedido (todo sin stock)</button>' : '') +
    '<p><button type="button" class="secondary" onclick="renderTab()">Volver a mis entregas</button></p></div>';
  contentEl.innerHTML = html;
}

function recalcChecklistTotal() {
  var lines = window._checklistLines || [];
  var total = 0;
  lines.forEach(function (l) {
    if (l.item_status !== 'levantado') return;
    var price = Number(l.price);
    if (l.product_id === null || l.product_id === undefined) {
      var inp = document.getElementById('otros-price-' + l.id);
      if (inp) price = Number(inp.value || 0) || 0;
    }
    total = round2(total + price * l.qty);
  });
  var el = document.getElementById('checklist-total');
  if (el) el.textContent = money(total);
}

async function setItemStatus(orderId, itemId, status) {
  try {
    await api('/api/orders?item=1&id=' + encodeURIComponent(orderId), 'PUT', { item_id: itemId, status: status });
    openChecklist(orderId);
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

async function doPickup(orderId) {
  try {
    var prices = {};
    (window._checklistLines || []).forEach(function (l) {
      if (l.item_status === 'levantado' && (l.product_id === null || l.product_id === undefined)) {
        var inp = document.getElementById('otros-price-' + l.id);
        if (inp) prices[l.id] = Number(inp.value || 0) || 0;
      }
    });
    var updated = await api('/api/orders?id=' + encodeURIComponent(orderId), 'PUT', { action: 'pickup', item_prices: prices });
    showMessage('¡Ya tenés la orden! Cobrá al cliente ' + money(updated.confirmed_total) + ' al entregar.', 'ok');
    currentTab = 'my-deliveries';
    buildTabs();
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

async function cancelAllOutOfStock(orderId) {
  if (!window.confirm('¿Seguro que querés cancelar el pedido? Todos los ítems están sin stock y el cliente verá ese motivo.')) return;
  try {
    await api('/api/orders?id=' + encodeURIComponent(orderId), 'PUT', { action: 'cancel', reason: 'Todo sin stock' });
    showMessage('Pedido cancelado: todo sin stock. El cliente lo ve cancelado con ese motivo.', 'ok');
    currentTab = 'my-deliveries';
    buildTabs();
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

function fmtDate(v) {
  if (!v) return '';
  return String(v).slice(0, 10);
}

async function renderProfile() {
  var me = await api('/api/users?me=1');
  var rows = await api('/api/users?movements=1');
  var html = '<div class="card"><h3>' + esc(me.name) + '</h3>' +
    '<p>Tel: ' + esc(me.phone) + ' · Vehículo: ' + esc(me.vehicle || '') + ' · RUT: ' + esc(me.monotributo_rut || '') + '</p>' +
    '<p>POS: ' + esc(me.pos_provider || '') + ' · ' + esc(me.pos_terminal || '') + '</p>' +
    '<p>Calificación: ' + starsText(me.avg_stars, me.ratings_count) + '</p></div>';
  if (me.role === 'delivery') {
    if (me.stage2_complete) {
      html += '<p class="ok">✓ Datos de tu empresa completos: podés ponerte en línea y recibir pedidos.</p>';
    } else {
      html += '<div class="notice"><h3>Completá los datos de tu empresa para empezar a recibir pedidos</h3>' +
        '<p>Te falta: ' + esc((me.stage2_missing || []).join(', ')) + '</p>' +
        '<p>Sin estos datos no podés ponerte en línea.</p></div>';
    }
    html += '<div class="card"><h3>Etapa 2: datos de mi empresa unipersonal</h3>' +
      '<p class="hint">Los marcados con * son obligatorios para ponerte en línea. Los demás son opcionales.</p>' +
      '<label>RUT de monotributo (12 dígitos) * <input id="s2-rut" type="text" inputmode="numeric" value="' + esc(me.monotributo_rut || '') + '"></label>' +
      '<label>Razón social * <input id="s2-razon" type="text" value="' + esc(me.razon_social || '') + '"></label>' +
      '<label>Nombre de fantasía <input id="s2-fantasia" type="text" value="' + esc(me.nombre_fantasia || '') + '"></label>' +
      '<label>Domicilio fiscal * <input id="s2-domicilio" type="text" value="' + esc(me.domicilio_fiscal || '') + '"></label>' +
      '<label>Actividad (giro) * <input id="s2-actividad" type="text" placeholder="Ej.: Reparto de mercaderías" value="' + esc(me.actividad || '') + '"></label>' +
      '<label>Fecha de inicio de actividades <input id="s2-fecha" type="date" value="' + fmtDate(me.fecha_inicio_actividades) + '"></label>' +
      '<label>Teléfono de la empresa <input id="s2-tel-emp" type="text" value="' + esc(me.telefono_empresa || '') + '"></label>' +
      '<label>Email de la empresa <input id="s2-email-emp" type="email" value="' + esc(me.email_empresa || '') + '"></label>' +
      '<label>Nº de empresa BPS <input id="s2-bps" type="text" value="' + esc(me.numero_bps || '') + '"></label>' +
      '<label>Proveedor de POS * <input id="s2-pos-prov" type="text" placeholder="Ej.: Mercado Pago Point, Getnet" value="' + esc(me.pos_provider || '') + '"></label>' +
      '<label>Terminal POS * <input id="s2-pos-term" type="text" value="' + esc(me.pos_terminal || '') + '"></label>' +
      '<label>Teléfono personal <input id="s2-phone" type="text" value="' + esc(me.phone || '') + '"></label>' +
      '<label>Vehículo <select id="s2-vehicle"><option value="moto"' + (me.vehicle === 'moto' ? ' selected' : '') + '>Moto</option><option value="bici"' + (me.vehicle === 'bici' ? ' selected' : '') + '>Bici</option><option value="auto"' + (me.vehicle === 'auto' ? ' selected' : '') + '>Auto</option></select></label>' +
      '<button type="button" class="big" onclick="saveStage2()">Guardar datos de mi empresa</button></div>';
    html += '<div class="card"><h3>Radio de trabajo</h3>' +
      '<p>Solo ves pedidos de comercios dentro de este radio, medido desde tu ubicación cuando abrís "Disponibles". Sin ubicación, ves todos los pedidos.</p>' +
      '<label>Radio de trabajo (km) <input id="s2-radius" type="number" min="1" max="200" step="1" value="' + esc(me.work_radius_km !== undefined && me.work_radius_km !== null ? me.work_radius_km : 30) + '"></label>' +
      '<button type="button" onclick="saveRadius()">Guardar radio</button></div>';
    html += '<div class="card"><h3>Cómo empezar</h3>' +
      '<h4>💼 Abrir tu empresa lo más barato posible</h4>' +
      '<p>El monotributo es el régimen más barato para arrancar como unipersonal. El trámite se hace en DGI (para el RUT) y en BPS (alta de empresa) y se puede iniciar en línea. Los costos y requisitos exactos cambian: confirmalos en dgi.gub.uy, bps.gub.uy o con un contador antes de arrancar.</p>' +
      '<h4>📟 Conseguir tu POS</h4>' +
      '<p>Se pide online a proveedores como Mercado Pago Point, Getnet u otros. Muchos lectores básicos no tienen alquiler mensual. Tiene que quedar vinculado a la cuenta de tu propia empresa unipersonal: consultá las condiciones de cada proveedor antes de elegir.</p>' +
      '<p class="hint">Estos son consejos generales, no un trámite exacto: verificá siempre en las fuentes oficiales.</p></div>';
  }
  if (me.balance !== undefined) html += lowBalanceWarning(me.balance, me.low_threshold);
  html += '<h3>Movimientos de créditos</h3>' + (rows.length ? rows.map(function (r) {
    return '<div class="card"><p>' + esc(new Date(r.created_at).toLocaleString('es-UY')) + ' — <strong>' + money(r.amount) + '</strong> · ' + esc(r.reason || '') + (r.order_id ? ' (pedido #' + r.order_id + ')' : '') + '</p></div>';
  }).join('') : '<p>Sin movimientos.</p>');
  contentEl.innerHTML = html;
}

async function saveStage2() {
  var body = {
    phone: document.getElementById('s2-phone').value.trim(),
    vehicle: document.getElementById('s2-vehicle').value,
    monotributo_rut: document.getElementById('s2-rut').value.trim(),
    razon_social: document.getElementById('s2-razon').value.trim(),
    nombre_fantasia: document.getElementById('s2-fantasia').value.trim(),
    domicilio_fiscal: document.getElementById('s2-domicilio').value.trim(),
    actividad: document.getElementById('s2-actividad').value.trim(),
    fecha_inicio_actividades: document.getElementById('s2-fecha').value,
    telefono_empresa: document.getElementById('s2-tel-emp').value.trim(),
    email_empresa: document.getElementById('s2-email-emp').value.trim(),
    numero_bps: document.getElementById('s2-bps').value.trim(),
    pos_provider: document.getElementById('s2-pos-prov').value.trim(),
    pos_terminal: document.getElementById('s2-pos-term').value.trim(),
  };
  try {
    var updated = await api('/api/users?me=1', 'PUT', body);
    if (updated.stage2_complete) {
      showMessage('¡Datos completos! Ya podés ponerte en línea.', 'ok');
    } else {
      showMessage('Datos guardados. Todavía falta: ' + (updated.stage2_missing || []).join(', '), 'error');
    }
    renderTab();
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

async function saveRadius() {
  var v = Math.floor(Number(document.getElementById('s2-radius').value));
  if (!Number.isFinite(v) || v < 1 || v > 200) {
    showMessage('El radio debe ser entre 1 y 200 km.', 'error');
    return;
  }
  try {
    await api('/api/users?me=1', 'PUT', { work_radius_km: v });
    showMessage('Radio de trabajo guardado: ' + v + ' km.', 'ok');
  } catch (e) {
    showMessage(e.message, 'error');
  }
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

// ---- Google (clientes) ----
function saveCustomerSession(data) {
  token = data.token;
  user = {
    id: data.customer.id,
    name: data.customer.full_name,
    role: 'customer',
    email: data.customer.email,
    phone: data.customer.phone,
    default_address: data.customer.default_address,
    profile_complete: data.customer.profile_complete,
  };
  localStorage.setItem('du_token', token);
  localStorage.setItem('du_user', JSON.stringify(user));
  currentTab = 'customer-account';
  showApp();
  if (!data.customer.profile_complete) {
    showMessage('Completá tu cédula, teléfono y dirección en Mi cuenta para poder pedir.', 'error');
  }
}

async function initGoogleButtons() {
  if (!googleClientId) {
    try {
      var s = await api('/api/stores?settings=public');
      googleClientId = s.google_client_id || '';
      driverPct = Number(s.driver_pct || 0);
    } catch (e) { /* sin Google: se sigue con email y contraseña */ }
  }
  if (!googleClientId) return;
  var regBox = document.getElementById('google-register-box');
  var loginBox = document.getElementById('google-login-box');
  if (regBox) regBox.classList.remove('hidden');
  if (loginBox) loginBox.classList.remove('hidden');
  if (window.google && window.google.accounts) { renderGoogleButtons(); return; }
  if (googleScriptLoading) return;
  googleScriptLoading = true;
  var script = document.createElement('script');
  script.src = 'https://accounts.google.com/gsi/client';
  script.async = true;
  script.defer = true;
  script.onload = renderGoogleButtons;
  document.head.appendChild(script);
}

function renderGoogleButtons() {
  if (!window.google || !window.google.accounts || !googleClientId) return;
  try {
    window.google.accounts.id.initialize({ client_id: googleClientId, callback: handleGoogleCredential });
    var regEl = document.getElementById('google-register-btn');
    var loginEl = document.getElementById('google-login-btn');
    if (regEl) { regEl.innerHTML = ''; window.google.accounts.id.renderButton(regEl, { theme: 'outline', size: 'large', width: 320 }); }
    if (loginEl) { loginEl.innerHTML = ''; window.google.accounts.id.renderButton(loginEl, { theme: 'outline', size: 'large', width: 320 }); }
  } catch (e) { /* Google no disponible: se sigue con email y contraseña */ }
}

async function handleGoogleCredential(response) {
  try {
    var data = await api('/api/auth?customer=google', 'POST', { id_token: response.credential });
    saveCustomerSession(data);
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
  }
  try {
    await api('/api/users', 'POST', body);
    okEl.textContent = role === 'delivery'
      ? '¡Cuenta creada! Ahora ingresá con tu nombre y PIN, y desde tu perfil completá los datos de tu empresa y tu POS para poder ponerte en línea.'
      : '¡Cuenta creada! Ahora ingresá con tu nombre y PIN.';
    okEl.classList.remove('hidden');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('customer-register-form').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  var errEl = document.getElementById('customer-register-error');
  var okEl = document.getElementById('customer-register-ok');
  errEl.classList.add('hidden');
  okEl.classList.add('hidden');
  if (!validateCI(document.getElementById('cust-reg-ci').value.trim())) {
    errEl.textContent = 'La cédula no es válida (8 dígitos con dígito verificador).';
    errEl.classList.remove('hidden');
    return;
  }
  try {
    await api('/api/auth?customer=register', 'POST', {
      full_name: document.getElementById('cust-reg-name').value.trim(),
      ci: document.getElementById('cust-reg-ci').value.trim(),
      email: document.getElementById('cust-reg-email').value.trim(),
      phone: document.getElementById('cust-reg-phone').value.trim(),
      default_address: document.getElementById('cust-reg-address').value.trim(),
      password: document.getElementById('cust-reg-password').value,
    });
    okEl.textContent = '¡Cuenta creada! Ahora ingresá como cliente con tu email y contraseña.';
    okEl.classList.remove('hidden');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('customer-login-form').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  var errEl = document.getElementById('customer-login-error');
  errEl.classList.add('hidden');
  try {
    var data = await api('/api/auth?customer=login', 'POST', {
      email: document.getElementById('cust-login-email').value.trim(),
      password: document.getElementById('cust-login-password').value,
    });
    saveCustomerSession(data);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('owner-login-form').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  var errEl = document.getElementById('owner-login-error');
  errEl.classList.add('hidden');
  try {
    var data = await api('/api/auth?owner=1', 'POST', {
      name: document.getElementById('owner-name').value.trim(),
      pin: document.getElementById('owner-pin').value,
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

document.getElementById('create-order-btn').addEventListener('click', createOrder);
document.getElementById('otros-value').addEventListener('input', renderBreakdown);
document.getElementById('track-btn').addEventListener('click', function () { loadTrack(); });

window.toggleOnline = toggleOnline;
window.acceptOrder = acceptOrder;
window.doPickup = doPickup;
window.doDeliver = doDeliver;
window.changePin = changePin;
window.openChecklist = openChecklist;
window.setItemStatus = setItemStatus;
window.cancelAllOutOfStock = cancelAllOutOfStock;
window.markStoreReady = markStoreReady;
window.restockProduct = restockProduct;
window.saveStage2 = saveStage2;
window.goToProfile = goToProfile;
window.toggleCustomerActive = toggleCustomerActive;
window.loadReports = loadReports;
window.saveCustomerAccount = saveCustomerAccount;

// Arranque: sesión guardada, acceso dueño (?dueno=1), seguimiento por URL
// (?pedido=ID) o inicio.
(function init() {
  var params = new URLSearchParams(window.location.search);
  var pedido = params.get('pedido');
  var dueno = params.get('dueno');
  if (token && user) {
    showApp();
    return;
  }
  if (dueno === '1') {
    showView('owner-login');
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
