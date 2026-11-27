/*
 * BackStreet Register iPad. Plain JavaScript (no build step) so it runs on old iPads (iPadOS 15).
 * Shows the floor plan with open tables; tap a table to see its items, print its bill, or add one
 * of the 6 best-sellers (a kitchen/bar ticket prints at the till). Uses the device link from
 * Settings → Register iPad; the token is kept on this iPad only.
 */
(function () {
  'use strict';
  var TOKEN_KEY = 'bs_register_device_token';
  var FLOOR_KEY = 'bs_register_floor';
  var REFRESH_MS = 5000;

  var state = { data: null, floor: null, tableId: null, orderId: null, busy: false, loading: false, lastOk: 0 };

  // Phones: tables as a grid of big buttons, and a tapped table opens full screen.
  function isPhone() { return window.innerWidth < 700; }
  function sortTables(list) {
    return list.slice().sort(function (a, b) {
      var oa = ordersFor(a.id).length ? 0 : 1; var ob = ordersFor(b.id).length ? 0 : 1;
      if (oa !== ob) return oa - ob;
      return String(a.number).localeCompare(String(b.number), undefined, { numeric: true });
    });
  }

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function money(v) { return '$' + (Math.round(Number(v || 0) * 100) / 100).toFixed(2); }
  function randomKey() { return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  function store(key, value) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) { void e; /* private mode */ } }
  function read(key) { try { return localStorage.getItem(key); } catch (e) { void e; return null; } }

  // A new link from Settings arrives as /mini.html#t=TOKEN. Keep it in the address too: an icon
  // saved to the Home Screen or desktop opens with its own empty storage and needs the link.
  (function takeTokenFromLink() {
    var m = /[#&]t=([A-Za-z0-9_-]{20,200})/.exec(location.hash || '');
    if (m) { store(TOKEN_KEY, m[1]); return; }
    var saved = read(TOKEN_KEY);
    if (saved && history.replaceState) history.replaceState(null, '', location.pathname + '#t=' + saved);
  })();

  var toastTimer = null;
  function toast(text, isError) {
    var t = $('toast');
    t.textContent = text;
    t.className = 'toast' + (isError ? ' err' : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast hidden'; }, isError ? 5000 : 2500);
  }

  function showConnect() {
    $('app').className = 'hidden';
    $('connect').className = 'screen';
  }

  function call(method, path, body, idempotencyKey) {
    var token = read(TOKEN_KEY);
    if (!token) { showConnect(); return Promise.reject(new Error('not connected')); }
    var headers = { 'Authorization': 'Device ' + token, 'Content-Type': 'application/json' };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return fetch('/api/mini' + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' })
      .then(function (res) {
        return res.text().then(function (text) {
          var data = {};
          try { data = text ? JSON.parse(text) : {}; } catch (e) { void e; data = {}; }
          if (res.status === 401) { store(TOKEN_KEY, null); if (history.replaceState) history.replaceState(null, '', location.pathname); showConnect(); throw new Error(data.error || 'Not connected'); }
          if (!res.ok) throw new Error(data.error || ('Error ' + res.status));
          return data;
        });
      });
  }

  function floorsOf(data) {
    var seen = {}; var list = [];
    data.tables.forEach(function (t) {
      var f = t.floor || 'Floor';
      if (!seen[f]) { seen[f] = true; list.push(f); }
    });
    return list;
  }

  function ordersFor(tableId) {
    if (!state.data) return [];
    return state.data.orders.filter(function (o) { return String(o.table_id) === String(tableId); });
  }

  function renderFloors() {
    var wrap = $('floors');
    wrap.innerHTML = '';
    var floors = floorsOf(state.data);
    if (!state.floor || floors.indexOf(state.floor) === -1) state.floor = floors[0] || null;
    floors.forEach(function (f) {
      var openCount = state.data.tables.filter(function (t) { return (t.floor || 'Floor') === f && ordersFor(t.id).length > 0; }).length;
      var b = el('button', f === state.floor ? 'on' : '', f + (openCount ? ' (' + openCount + ')' : ''));
      b.onclick = function () { state.floor = f; store(FLOOR_KEY, f); render(); };
      wrap.appendChild(b);
    });
  }

  function renderMap() {
    var map = $('map');
    map.innerHTML = '';
    var phone = isPhone();
    map.className = phone ? 'map grid' : 'map';
    var list = state.data.tables.filter(function (t) { return (t.floor || 'Floor') === state.floor; });
    // Phones have little room: show only tables with an open bill.
    if (phone) {
      list = list.filter(function (t) { return ordersFor(t.id).length > 0; });
      if (!list.length) { map.appendChild(el('p', 'hint', 'No open tables on this floor')); return; }
    }
    (phone ? sortTables(list) : list).forEach(function (t) {
      var open = ordersFor(t.id);
      var total = open.reduce(function (sum, o) { return sum + Number(o.total || 0); }, 0);
      var cls = 'table' + (open.length ? ' open' : '') + (String(t.id) === String(state.tableId) ? ' sel' : '');
      var b = el('button', cls);
      if (!phone) {
        b.style.left = Math.min(95, Math.max(5, Number(t.position_x) || 50)) + '%';
        b.style.top = Math.min(92, Math.max(8, Number(t.position_y) || 50)) + '%';
      }
      b.appendChild(el('b', '', t.number));
      if (open.length) b.appendChild(el('span', 'amt', money(total)));
      b.onclick = function () {
        state.tableId = t.id;
        var first = ordersFor(t.id)[0];
        state.orderId = first ? first.id : null;
        render();
      };
      map.appendChild(b);
    });
  }

  function renderPanel() {
    var panel = $('panel');
    panel.innerHTML = '';
    var table = state.data.tables.filter(function (t) { return String(t.id) === String(state.tableId); })[0];
    if (!table) { panel.appendChild(el('p', 'hint', 'Tap a table')); return; }
    var open = ordersFor(table.id);
    if (isPhone()) {
      var back = el('button', 'back', '\u2190 Tables');
      back.onclick = function () { state.tableId = null; state.orderId = null; render(); window.scrollTo(0, 0); };
      panel.appendChild(back);
    }
    panel.appendChild(el('h2', '', table.number));
    if (!open.length) { panel.appendChild(el('p', 'hint', 'No open bill on this table')); return; }
    if (!open.some(function (o) { return String(o.id) === String(state.orderId); })) state.orderId = open[0].id;
    if (open.length > 1) {
      var tabs = el('div', 'tabs');
      open.forEach(function (o) {
        var b = el('button', String(o.id) === String(state.orderId) ? 'on' : '', o.tab_name || ('#' + o.order_number));
        b.onclick = function () { state.orderId = o.id; render(); };
        tabs.appendChild(b);
      });
      panel.appendChild(tabs);
    }
    var order = open.filter(function (o) { return String(o.id) === String(state.orderId); })[0];
    panel.appendChild(el('div', 'sub', (order.guest_count ? order.guest_count + ' guests · ' : '') + '#' + order.order_number));

    var items = el('div', 'items');
    order.items.forEach(function (i) {
      var r = el('div', 'row');
      r.appendChild(el('span', '', i.quantity + ' × ' + i.name));
      r.appendChild(el('span', '', money(i.total)));
      items.appendChild(r);
    });
    var tr = el('div', 'row total');
    tr.appendChild(el('span', '', 'Total'));
    tr.appendChild(el('span', '', money(order.total)));
    items.appendChild(tr);
    panel.appendChild(items);

    var print = el('button', 'big print', 'Print bill');
    print.disabled = state.busy;
    print.onclick = function () { printBill(order); };
    panel.appendChild(print);

    panel.appendChild(el('div', 'label', 'Add one'));
    var top = el('div', 'top');
    (state.data.top || []).forEach(function (p) {
      var b = el('button', '');
      var pic = el('span', 'pic', p.has_image ? '' : '+');
      if (p.has_image) pic.style.backgroundImage = 'url(/api/products/' + encodeURIComponent(p.id) + '/image?t=' + encodeURIComponent(p.v || '') + ')';
      b.appendChild(pic);
      var txt = el('span', 'txt');
      txt.appendChild(el('span', 'nm', p.name));
      txt.appendChild(el('small', '', '+ ' + money(p.price)));
      b.appendChild(txt);
      b.disabled = state.busy;
      b.onclick = function () { addItem(order, p); };
      top.appendChild(b);
    });
    panel.appendChild(top);
  }

  function render() {
    if (!state.data) return;
    // On a phone the open table takes the whole screen; without one, only the tables show.
    var app = $('app');
    app.className = isPhone() ? (state.tableId ? 'phone table-open' : 'phone') : '';
    renderFloors();
    renderMap();
    renderPanel();
  }

  function setStatus() {
    var s = $('status');
    var stale = state.lastOk && Date.now() - state.lastOk > 20000;
    if (!state.lastOk) { s.textContent = 'Loading…'; s.className = 'status'; return; }
    var d = new Date(state.lastOk);
    var hh = ('0' + d.getHours()).slice(-2); var mm = ('0' + d.getMinutes()).slice(-2);
    s.textContent = stale ? 'No connection · last ' + hh + ':' + mm : 'Updated ' + hh + ':' + mm;
    s.className = 'status' + (stale ? ' bad' : '');
  }

  function load() {
    if (state.loading || state.busy) return;
    state.loading = true;
    call('GET', '/floor').then(function (data) {
      state.data = data;
      state.lastOk = Date.now();
      $('connect').className = 'screen hidden';
      $('app').className = '';
      render();
    }).catch(function () { /* status shows it */ }).then(function () {
      state.loading = false;
      setStatus();
    });
  }

  function addItem(order, product) {
    if (state.busy) return;
    state.busy = true; render();
    call('POST', '/orders/' + order.id + '/items', { product_id: product.id }, randomKey())
      .then(function (res) {
        if (res.floor) { state.data = res.floor; state.lastOk = Date.now(); }
        toast('Added ' + product.name + ' · ticket printing');
      })
      .catch(function (err) { if (read(TOKEN_KEY)) toast(err.message, true); })
      .then(function () { state.busy = false; render(); setStatus(); });
  }

  function printBill(order) {
    if (state.busy) return;
    state.busy = true; render();
    call('POST', '/orders/' + order.id + '/print-bill', {})
      .then(function () { toast('Bill sent to the printer'); })
      .catch(function (err) { if (read(TOKEN_KEY)) toast(err.message, true); })
      .then(function () { state.busy = false; render(); });
  }

  state.floor = read(FLOOR_KEY);
  if (!read(TOKEN_KEY)) { showConnect(); return; }
  load();
  setInterval(load, REFRESH_MS);
  setInterval(setStatus, 5000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  window.addEventListener('resize', function () { render(); });
})();
