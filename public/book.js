/* Kwema Ride — web booking client.
 *
 * Talks to the same API and WebSocket the mobile apps use. Nothing here is a
 * web-only code path: the quote is the same locked quote, dispatch is the
 * same sequential offer loop, and payment goes through the same providers.
 *
 * Sessions: a person signs in with an SMS code once. The browser then keeps a
 * long-lived, rotating refresh token (localStorage) and renews the short
 * access token silently, so they are not asked for a code again until they
 * sign out or the server revokes the session. The Sign out link removes the
 * tokens (use it on a shared computer).
 */

(function () {
  const API = '';
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (_) {} }
  function deviceId() {
    let id = lsGet('kwema_device');
    if (!id) {
      const a = new Uint8Array(16);
      (window.crypto || window.msCrypto).getRandomValues(a);
      id = 'web-' + Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
      lsSet('kwema_device', id);
    }
    return id;
  }
  let state = {
    token: lsGet('kwema_token') || null,
    pickup: null,
    dropoff: null,
    quotes: [],
    selected: null,
    payment: 'mobile_money',
    ride: null,
    // Every ride this rider has open (and recently finished ones still on
    // screen), keyed by ride id. `ride` above is the one in focus.
    rides: {},
    view: 'booking',
    forOther: false,
    pName: '',
    pPhone: '',
    pickupManual: false,
    pickupLabel: '',
    pinning: false,
    socket: null,
    map: null,
    markers: {},
    sessionToken: Math.random().toString(36).slice(2),
    service: 'ride',
    delivery: null,
    config: {},
    // Car pooling: 'off' (ride alone), 'match' (find a car already on the road),
    // 'host' (start a shared trip others can join).
    pool: 'off',
    coRiders: 0,
    saved: 0,
  };

  const panel = document.getElementById('panel');
  const T = (k) => kwemaT(k);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));

  /** The pool option is offered only for rides, in categories that seat more than one rider. */
  function poolOffered() {
    const cfg = state.config && state.config.pool;
    return Boolean(cfg && cfg.enabled && state.service === 'ride' &&
      state.selected && state.selected.poolPreview);
  }

  // =================================================================
  // API helper
  // =================================================================
  /**
   * Renews the access token with the stored refresh token. One renewal at a
   * time per browser (Web Locks across tabs) because refresh tokens rotate:
   * two tabs refreshing together would present a token the other just used.
   * Resolves 'ok', 'rejected' (session over) or 'unreachable' (try later).
   */
  let refreshing = null;
  function refreshSession() {
    if (refreshing) return refreshing;
    const run = async () => {
      // Another tab may already have renewed while we waited for the lock.
      const stored = lsGet('kwema_token');
      if (stored && stored !== state.token) { state.token = stored; return 'ok'; }
      const refresh = lsGet('kwema_refresh');
      if (!refresh) return 'rejected';
      try {
        const res = await fetch(API + '/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: refresh, deviceId: deviceId() }),
        });
        if (res.status === 200 || res.status === 201) {
          const out = await res.json();
          state.token = out.accessToken;
          lsSet('kwema_token', out.accessToken);
          lsSet('kwema_refresh', out.refreshToken);
          return 'ok';
        }
        return (res.status === 401 || res.status === 403) ? 'rejected' : 'unreachable';
      } catch (_) {
        return 'unreachable';
      }
    };
    const locked = (navigator.locks && navigator.locks.request)
      ? navigator.locks.request('kwema-refresh', run)
      : run();
    refreshing = Promise.resolve(locked).finally(() => { refreshing = null; });
    return refreshing;
  }

  function endSession(why) {
    lsDel('kwema_token');
    lsDel('kwema_refresh');
    state.token = null;
    state.rides = {}; state.ride = null; state.focus = null; state.view = 'booking';
    if (state.socket) { try { state.socket.close(); } catch (_) {} state.socket = null; }
    setTimeout(() => renderLogin(why), 0);
  }

  async function api(path, options = {}, retried) {
    const res = await fetch(API + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
        ...(options.headers || {}),
      },
    });
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      if (!retried) {
        const outcome = await refreshSession();
        if (outcome === 'ok') return api(path, options, true);
        if (outcome === 'unreachable') throw new Error('network_unreachable');
      }
      // The server refused the refresh token: the session is genuinely over.
      // Drawn after the caller's own error handler has run, so that handler
      // cannot paint an "unauthorized" message over it.
      const lang = kwemaLang();
      endSession(lang === 'fr' ? 'Session expirée. Reconnectez-vous.'
        : lang === 'en' ? 'Your session expired. Please sign in again.'
        : 'Muda wa kuingia umeisha. Tafadhali ingia tena.');
      throw new Error('session_expired');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || 'request_failed');
    return body;
  }

  // Renew quietly in the background so the token never lapses mid-trip, and
  // when the tab comes back from sleep.
  setInterval(() => { if (lsGet('kwema_refresh')) refreshSession(); }, 10 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && lsGet('kwema_refresh')) refreshSession();
  });

  function msg(text, kind) {
    return '<div class="msg msg-' + (kind || 'info') + '">' + text + '</div>';
  }

  // =================================================================
  // Login
  // =================================================================
  /** The emergency button follows the session, not the screen. */
  function toggleTopSos(visible) {
    const el = document.getElementById('sos-top');
    if (el) el.hidden = !visible;
  }

  function renderLogin(error, keepPhone) {
    const so = document.getElementById('signout'); if (so) so.hidden = true;
    toggleTopSos(false);
    panel.innerHTML =
      '<h2 style="font-size:22px;font-weight:800;margin-bottom:6px">' +
        (kwemaLang() === 'fr' ? 'Connexion' : kwemaLang() === 'en' ? 'Sign in' : 'Ingia') + '</h2>' +
      '<p style="color:var(--muted);font-size:14px;margin-bottom:20px">' +
        (kwemaLang() === 'fr' ? 'Nous enverrons un code par SMS.'
         : kwemaLang() === 'en' ? 'We will send a code by SMS.'
         : 'Tutakutumia msimbo kwa SMS.') + '</p>' +
      (error ? msg(error, 'err') : '') +
      '<label>' + (kwemaLang() === 'fr' ? 'Numéro de téléphone' : kwemaLang() === 'en' ? 'Phone number' : 'Namba ya simu') + '</label>' +
      '<div class="field"><input id="phone" value="' + (keepPhone || '+254') +
        '" inputmode="tel"></div>' +
      '<button class="btn btn-primary" style="width:100%" id="send">' +
        (kwemaLang() === 'fr' ? 'Envoyer le code' : kwemaLang() === 'en' ? 'Send code' : 'Tuma msimbo') +
      '</button>';

    document.getElementById('send').addEventListener('click', async () => {
      const phone = document.getElementById('phone').value.replace(/\s/g, '');
      if (!/^\+254[0-9]{9}$/.test(phone)) {
        return renderLogin(kwemaLang() === 'fr' ? 'Format : +254XXXXXXXXX'
          : kwemaLang() === 'en' ? 'Use the format +254XXXXXXXXX'
          : 'Tumia muundo +254XXXXXXXXX');
      }
      try {
        const out = await api('/api/auth/otp/request', {
          method: 'POST', body: JSON.stringify({ phone }),
        });

        // The endpoint returns 201 with sent:false when the 60s resend
        // cooldown is still running. Advancing to the code screen anyway —
        // which an earlier version did — showed a code prompt for an SMS
        // that was never sent, with nothing explaining why.
        if (out && out.sent === false) {
          const wait = out.retryAfter || 60;
          return renderLogin(
            kwemaLang() === 'fr'
              ? 'Un code a déjà été envoyé. Réessayez dans ' + wait + ' s.'
              : kwemaLang() === 'en'
              ? 'A code was already sent. Try again in ' + wait + 's.'
              : 'Msimbo tayari umetumwa. Jaribu tena baada ya sekunde ' + wait + '.',
            phone,
          );
        }
        renderOtp(phone);
      } catch (e) {
        renderLogin(e.message, phone);
      }
    });
  }

  function renderOtp(phone, error) {
    toggleTopSos(false);
    panel.innerHTML =
      '<h2 style="font-size:22px;font-weight:800;margin-bottom:6px">' +
        (kwemaLang() === 'fr' ? 'Code de vérification' : kwemaLang() === 'en' ? 'Verification code' : 'Msimbo') + '</h2>' +
      '<p style="color:var(--muted);font-size:14px;margin-bottom:20px">' + phone + '</p>' +
      (error ? msg(error, 'err') : '') +
      '<div class="field"><input id="code" inputmode="numeric" maxlength="6" ' +
        'style="letter-spacing:8px;font-size:22px;text-align:center;padding-left:15px"></div>' +
      '<button class="btn btn-primary" style="width:100%" id="verify">' +
        (kwemaLang() === 'fr' ? 'Vérifier' : kwemaLang() === 'en' ? 'Verify' : 'Thibitisha') + '</button>' +
      '<button class="btn btn-ghost" style="width:100%;margin-top:8px" id="back">' +
        (kwemaLang() === 'fr' ? 'Retour' : kwemaLang() === 'en' ? 'Back' : 'Rudi') + '</button>';

    document.getElementById('back').addEventListener('click', () => renderLogin());
    document.getElementById('verify').addEventListener('click', async () => {
      const code = document.getElementById('code').value.trim();
      try {
        const out = await api('/api/auth/otp/verify', {
          method: 'POST',
          body: JSON.stringify({ phone, code, deviceId: deviceId() }),
        });
        state.token = out.accessToken;
        lsSet('kwema_token', out.accessToken);
        lsSet('kwema_refresh', out.refreshToken);
        connectSocket();
        await pollTracking();
        if (openRides().length) renderRides(); else renderBooking();
      } catch (e) {
        renderOtp(phone, e.message);
      }
    });
  }

  // =================================================================
  // Booking
  // =================================================================
  function renderBooking(error) {
    toggleTopSos(true);
    const so = document.getElementById('signout'); if (so) so.hidden = false;
    const params = new URLSearchParams(location.search);
    const svcLabel = { ride: T('service.ride'), parcel: T('service.parcel'), food: T('service.food') };

    state.view = 'booking';
    // A ride for someone else never starts from the rider's own position:
    // the pickup is wherever that person is, and the rider has to say where.
    if (bookingForOther() && !state.pickupManual) { state.pickup = null; clearMarker('pickup'); }
    if (!bookingForOther()) state.pinning = false;
    syncMap();
    const openN = openRides().length;
    panel.innerHTML =
      (openN
        ? '<button class="btn btn-ghost" id="back-rides" style="margin-bottom:10px;font-size:13px">\u2190 ' +
          L3('Safari zangu', 'My rides', 'Mes courses') + ' (' + openN + ')</button>'
        : '') +
      '<div class="svc-tabs">' +
        ['ride', 'parcel', 'food'].map((s) =>
          `<button data-svc="${s}" class="${state.service === s ? 'on' : ''}">${svcLabel[s]}</button>`
        ).join('') +
      '</div>' +
      '<h2 style="font-size:20px;font-weight:800;margin:14px 0 16px">' + T('book.title') + '</h2>' +
      (error ? msg(error, 'err') : '') +
      '<div class="field"><span class="dot dot-from"></span>' +
        '<input id="from" placeholder="' + (bookingForOther()
          ? L3('Mahali pa kumchukua abiria', 'Where to pick the passenger up', 'Où prendre le passager')
          : T('book.from')) + '" autocomplete="off" value="' +
        esc(params.get('from') || (state.pickupManual ? state.pickupLabel : '')) + '"><div class="suggestions" id="from-sug" hidden></div></div>' +
      (bookingForOther()
        ? '<div class="pin-row"><button type="button" class="btn btn-ghost" id="pin-pickup">' + pinLabel() + '</button>' +
          '<span class="fw-note" id="pin-note">' + pinNote() + '</span></div>'
        : '') +
      '<div class="field"><span class="dot dot-to"></span>' +
        '<input id="to" placeholder="' + T('book.to') + '" autocomplete="off" value="' +
        (params.get('to') || '') + '"><div class="suggestions" id="to-sug" hidden></div></div>' +
      (state.service !== 'ride'
        ? '<div class="recip">' +
            '<label>' + T('delivery.what') + '</label>' +
            '<input id="d-what" placeholder="' + T('delivery.what_hint') + '">' +
            '<label>' + T('delivery.recipient_name') + '</label>' +
            '<input id="d-name">' +
            '<label>' + T('delivery.recipient_phone') + '</label>' +
            '<input id="d-phone" value="+254">' +
            '<label>' + T('delivery.size') + '</label>' +
            '<select id="d-size">' +
              '<option value="small">' + T('delivery.size_small') + '</option>' +
              '<option value="medium">' + T('delivery.size_medium') + '</option>' +
              '<option value="large">' + T('delivery.size_large') + '</option>' +
            '</select>' +
          '</div>'
        : '') +
      forWhomBlock() +
      '<button class="btn btn-primary" style="width:100%;margin-top:4px" id="quote">' +
        T('book.go') + '</button>' +
      '<div id="results" style="margin-top:20px"></div>';

    wireSearch('from', (p, label) => {
      state.pickup = p; state.pickupManual = true; state.pickupLabel = label; state.pinning = false;
      setMarker('pickup', p, label);
      refreshPinUi();
    });
    if (bookingForOther()) {
      // Typing again means the earlier choice no longer stands.
      document.getElementById('from').addEventListener('input', () => {
        state.pickupManual = false; state.pickup = null; state.pickupLabel = ''; clearMarker('pickup');
        refreshPinUi();
      });
      document.getElementById('pin-pickup').addEventListener('click', () => {
        state.pinning = !state.pinning;
        refreshPinUi();
      });
      refreshPinUi();
    } else if (!state.pickupManual && state.me) {
      state.pickup = state.me;
      setMarker('pickup', state.me, 'Pickup', { fit: false });
      labelFromMe();
    }
    wireSearch('to', (p, label) => { state.dropoff = p; setMarker('dropoff', p, label); });
    document.getElementById('quote').addEventListener('click', getQuotes);
    bindForWhom();
    const back = document.getElementById('back-rides');
    if (back) back.addEventListener('click', () => renderRides());

    document.querySelectorAll('[data-svc]').forEach((b) => {
      b.addEventListener('click', () => {
        state.service = b.dataset.svc;
        state.quotes = [];
        state.delivery = null;
        renderBooking();
      });
    });

    useBrowserLocation();
  }

  const pinLabel = () => state.pinning
    ? L3('Ghairi', 'Cancel', 'Annuler')
    : L3('Weka alama kwenye ramani', 'Place a pin on the map', 'Placer une épingle sur la carte');
  const pinNote = () => state.pinning
    ? L3('Gusa ramani mahali alipo abiria.', 'Click the map where the passenger is.', 'Cliquez sur la carte là où se trouve le passager.')
    : (state.pickupManual
        ? L3('Buruta alama ya kijani kuirekebisha.', 'Drag the green pin to adjust it.', 'Faites glisser l’épingle verte pour l’ajuster.')
        : L3('Tafuta mahali, au weka alama kwenye ramani.', 'Search for a place, or place a pin on the map.', 'Recherchez un lieu ou placez une épingle sur la carte.'));
  function refreshPinUi() {
    const b = document.getElementById('pin-pickup'), n = document.getElementById('pin-note');
    if (b) b.textContent = pinLabel();
    if (n) n.textContent = pinNote();
    if (state.map) state.map.setOptions({ draggableCursor: state.pinning ? 'crosshair' : null });
  }
  /** The rider chose a spot for the passenger: by tapping the map or dragging the pin. */
  async function placePickup(p) {
    state.pickup = p; state.pickupManual = true; state.pinning = false; state.pickupLabel = '';
    setMarker('pickup', p, 'Pickup', { fit: false });
    if (state.map) state.map.panTo(p);
    const input = document.getElementById('from');
    const fallback = L3('Mahali ulipoweka alama', 'Pin you placed', 'Épingle placée');
    if (input) input.value = fallback;
    state.pickupLabel = fallback;
    refreshPinUi();
    try {
      const r = await api('/api/maps/reverse-geocode?lat=' + p.lat + '&lng=' + p.lng + '&language=' + kwemaLang());
      // Only if the pin has not moved on while the lookup ran.
      if (r.address && state.pickup === p) {
        state.pickupLabel = r.address;
        const el = document.getElementById('from'); if (el) el.value = r.address;
      }
    } catch { /* the pin itself is what counts */ }
  }
  async function labelFromMe() {
    const input = document.getElementById('from');
    if (!input || input.value || !state.me) return;
    try {
      const r = await api('/api/maps/reverse-geocode?lat=' + state.me.lat + '&lng=' + state.me.lng + '&language=' + kwemaLang());
      const el = document.getElementById('from');
      if (r.address && el && !el.value && !bookingForOther()) el.value = r.address;
    } catch { /* a blank pickup field is fine; the marker is set */ }
  }

  /** Place autocomplete through our server proxy — the Maps key stays server-side. */
  function wireSearch(id, onPick) {
    const input = document.getElementById(id);
    const box = document.getElementById(id + '-sug');
    let timer;

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const value = input.value.trim();
      if (value.length < 2) { box.hidden = true; return; }
      // Debounced: Google bills autocomplete, and a fast typist generates a
      // request per keystroke otherwise.
      timer = setTimeout(async () => {
        try {
          const list = await api('/api/maps/autocomplete', {
            method: 'POST',
            body: JSON.stringify({
              input: value,
              sessionToken: state.sessionToken,
              language: kwemaLang(),
              ...(state.pickup ? { lat: state.pickup.lat, lng: state.pickup.lng } : {}),
            }),
          });
          if (!list.length) {
            box.innerHTML = '<div style="color:var(--muted);cursor:default">' +
              (kwemaLang() === 'fr' ? 'Aucun résultat'
               : kwemaLang() === 'en' ? 'No results'
               : 'Hakuna matokeo') + '</div>';
            box.hidden = false;
            return;
          }
          box.innerHTML = list.map((s) =>
            '<div data-id="' + s.placeId + '"><strong>' + s.primary + '</strong>' +
            '<small>' + s.secondary + '</small></div>').join('');
          box.hidden = false;
          box.querySelectorAll('div[data-id]').forEach((row) => {
            row.addEventListener('click', async () => {
              input.value = row.querySelector('strong').textContent;
              box.hidden = true;
              const detail = await api('/api/maps/place?placeId=' + row.dataset.id +
                '&sessionToken=' + state.sessionToken);
              if (detail && detail.point) onPick(detail.point, input.value);
            });
          });
        } catch (err) {
          // Silently hiding the box made a failing Places key look identical
          // to "no results", which is what made this hard to diagnose.
          box.innerHTML = '<div style="color:var(--stop);cursor:default">' +
            (kwemaLang() === 'fr' ? 'Recherche indisponible'
             : kwemaLang() === 'en' ? 'Search unavailable'
             : 'Utafutaji haupatikani') + '</div>';
          box.hidden = false;
        }
      }, 350);
    });

    document.addEventListener('click', (e) => {
      if (!box.contains(e.target) && e.target !== input) box.hidden = true;
    });
  }

  async function getQuotes() {
    if (bookingForOther() && !state.pickupManual) {
      return renderBooking(L3('Chagua kwanza mahali pa kumchukua abiria.', 'Choose where to pick the passenger up first.', 'Choisissez d’abord où prendre le passager.'));
    }
    if (!state.pickup || !state.dropoff) {
      return renderBooking(kwemaLang() === 'fr' ? 'Choisissez un départ et une destination.'
        : kwemaLang() === 'en' ? 'Choose a pickup and destination.'
        : 'Chagua mahali pa kuanzia na unakoenda.');
    }
    const results = document.getElementById('results');
    results.innerHTML = '<div class="status-box"><div class="spinner"></div></div>';

    try {
      const out = await api('/api/pricing/quote', {
        method: 'POST',
        body: JSON.stringify({
          serviceType: state.service,
          pickupLat: state.pickup.lat, pickupLng: state.pickup.lng,
          dropoffLat: state.dropoff.lat, dropoffLng: state.dropoff.lng,
          ...(state.service === 'ride' ? { pool: true } : {}),
        }),
      });
      state.quotes = out.quotes;
      state.selected = out.quotes.find((q) => q.category === 'standard') || out.quotes[0];
      renderQuotes();
      drawRoute(state.selected.polyline);
    } catch (e) {
      results.innerHTML = msg(e.message, 'err');
    }
  }

  const CAT_COLOUR = { boda: '#D9722B', bajaji: '#C9A227', standard: '#3A4BB8',
    xl: '#2E7D74', express: '#30409B',
    // Green for the electric tiers, so the distinction registers before the
    // label is read.
    e_boda: '#2E9E5B', e_bajaji: '#1E8E63', e_car: '#17806E' };
  const CAT_NAME = {"en": {"boda": "Bodaboda", "bajaji": "Tuk-tuk", "standard": "Car", "xl": "Car XL", "express": "Express", "e_boda": "Electric Bodaboda", "e_bajaji": "Electric Tuk-tuk", "e_car": "Electric Car"}, "sw": {"boda": "Bodaboda", "bajaji": "Tuk-tuk", "standard": "Gari", "xl": "Gari Kubwa", "express": "Express", "e_boda": "Boda ya Umeme", "e_bajaji": "Tuk-tuk ya Umeme", "e_car": "Gari la Umeme"}, "fr": {"boda": "Moto-taxi", "bajaji": "Tuk-tuk", "standard": "Voiture", "xl": "Voiture XL", "express": "Express", "e_boda": "Moto-taxi électrique", "e_bajaji": "Tuk-tuk électrique", "e_car": "Voiture électrique"}};

  function poolBlock() {
    if (!poolOffered()) { state.pool = 'off'; return ''; }
    const pv = state.selected.poolPreview;
    const opt = (id, label) => '<button data-pool="' + id + '"' +
      (state.pool === id ? ' class="on"' : '') + '>' + label + '</button>';
    let html = '<label style="margin-top:18px">' + T('pool.title') + '</label>' +
      '<div class="pool-modes">' +
        opt('off', T('pool.alone')) + opt('match', T('pool.share')) + opt('host', T('pool.host')) +
      '</div>';
    if (state.pool !== 'off') {
      html += '<div class="pool-box">' +
        '<div class="pool-price">' + fill(T('pool.price'), {
          shared: kwemaMoney(pv.sharedFareCents), best: kwemaMoney(pv.bestFareCents),
          solo: kwemaMoney(state.selected.fare.totalFareCents),
        }) + '</div>' +
        '<div class="pool-note">' + fill(T('pool.' + (state.pool === 'host' ? 'note_host' : 'note_match')),
          { seats: pv.seats }) + '</div>' +
        '<div class="pool-note">' + T('pool.fair') + '</div>' +
        '<button class="btn btn-ghost" id="pool-browse" style="width:100%;margin-top:10px">' +
          T('pool.browse') + '</button>' +
        '<div id="pool-list"></div>' +
      '</div>';
    }
    return html;
  }

  /** Shared trips going the same way, as a list the rider can join. */
  async function browsePool() {
    const box = document.getElementById('pool-list');
    if (!box) return;
    box.innerHTML = '<div class="status-box"><div class="spinner"></div></div>';
    try {
      const q = new URLSearchParams({
        category: state.selected.category,
        pickupLat: state.pickup.lat, pickupLng: state.pickup.lng,
        dropoffLat: state.dropoff.lat, dropoffLng: state.dropoff.lng,
      });
      const out = await api('/api/pool/trips?' + q.toString());
      if (!out.trips.length) { box.innerHTML = '<p class="pool-note">' + T('pool.none') + '</p>'; return; }
      box.innerHTML = out.trips.map((t) =>
        '<div class="pool-trip"><div>' +
          '<strong>' + esc(t.hostFirstName || '') + '</strong> · ' +
          esc(t.fromArea || '') + ' \u2192 ' + esc(t.toArea || '') +
          '<div class="pool-note">' + fill(T('pool.seats_left'), { n: t.seatsLeft }) + ' · ' +
            (t.hasDriver ? T('pool.on_road') : T('pool.waiting')) + '</div></div>' +
          '<button class="btn btn-primary" data-join="' + esc(t.tripId) + '">' + T('pool.join') + '</button>' +
        '</div>').join('');
      box.querySelectorAll('[data-join]').forEach((b) =>
        b.addEventListener('click', () => joinTrip(b.dataset.join)));
    } catch (e) {
      box.innerHTML = msg(e.message, 'err');
    }
  }

  async function joinTrip(tripId) {
    const q = state.selected;
    panel.querySelector('#results').innerHTML =
      '<div class="status-box"><div class="spinner"></div><p>' + T('how.2.t') + '</p></div>';
    try {
      const ride = await api('/api/pool/trips/' + encodeURIComponent(tripId) + '/join', {
        method: 'POST',
        body: JSON.stringify({
          clientGeneratedId: crypto.randomUUID(),
          quoteId: q.quoteId,
          category: q.category,
          paymentMethod: state.payment,
          pickup: { lat: state.pickup.lat, lng: state.pickup.lng,
            address: document.getElementById('from')?.value },
          dropoff: { lat: state.dropoff.lat, lng: state.dropoff.lng,
            address: document.getElementById('to')?.value },
        }),
      });
      afterRequested(ride, {
        serviceType: 'ride', forOther: false, paymentMethod: state.payment,
        pickup: { lat: state.pickup.lat, lng: state.pickup.lng },
        dropoff: { lat: state.dropoff.lat, lng: state.dropoff.lng },
        pickupAddress: document.getElementById('from')?.value,
        dropoffAddress: document.getElementById('to')?.value,
      });
    } catch (e) {
      renderQuotes();
      const box = document.getElementById('results');
      if (box) box.insertAdjacentHTML('afterbegin', msg(
        e.message === 'trip_not_joinable' ? T('pool.gone') : e.message, 'err'));
    }
  }

  function renderQuotes() {
    const lang = kwemaLang();
    const anyEstimate = state.quotes.some((q) => q.isEstimate);

    document.getElementById('results').innerHTML =
      (anyEstimate ? msg(lang === 'fr' ? 'Tarifs approximatifs — routage indisponible.'
        : lang === 'en' ? 'Approximate prices — routing unavailable.'
        : 'Bei za makadirio — ramani haipatikani.', 'info') : '') +
      state.quotes.map((q) =>
        '<div class="cat' + (state.selected && q.category === state.selected.category ? ' on' : '') +
          '" data-cat="' + q.category + '">' +
          '<div class="bar" style="background:' + CAT_COLOUR[q.category] + '"></div>' +
          (q.category.startsWith('e_') ? '<span class="ev">\u26A1</span>' : '') +
          '<div><div class="nm">' + CAT_NAME[lang][q.category] + '</div>' +
          '<div class="mt">' + Math.ceil(q.durationSeconds / 60) + ' min · ' +
            (q.distanceMetres / 1000).toFixed(1) + ' km</div></div>' +
          '<div class="pr"><strong>' + kwemaMoney(q.fare.totalFareCents) + '</strong>' +
          (q.fare.surgeMultiplier > 1
            ? '<span style="font-size:12px;color:var(--mg-600)">×' +
              q.fare.surgeMultiplier.toFixed(1) + '</span>' : '') +
          '</div></div>').join('') +
      poolBlock() +
      '<label style="margin-top:18px">' +
        (lang === 'fr' ? 'Paiement' : lang === 'en' ? 'Payment' : 'Malipo') + '</label>' +
      '<div class="pm">' +
        '<button data-pm="mobile_money" class="on">' + T('pay.mm.t') + '</button>' +
        '<button data-pm="card">' + T('pay.card.t') + '</button>' +
        '<button data-pm="cash">' + T('pay.cash.t') + '</button>' +
      '</div>' +
      '<div id="mno-wrap"><label>' + T('pay.mm.t') + '</label>' +
        '<select id="mno">' +
'<option value="mpesa">M-Pesa</option>' +
        '<option value="airtelmoney">Airtel Money</option>' +
        '</select></div>' +
      '<button class="btn btn-primary" style="width:100%;margin-top:16px" id="request">' +
        (lang === 'fr' ? 'Commander' : lang === 'en' ? 'Request ride' : 'Omba safari') + '</button>';

    document.querySelectorAll('.cat').forEach((el) => {
      el.addEventListener('click', () => {
        state.selected = state.quotes.find((q) => q.category === el.dataset.cat);
        renderQuotes();
        drawRoute(state.selected.polyline);
      });
    });
    document.querySelectorAll('.pm button').forEach((b) => {
      b.addEventListener('click', () => {
        state.payment = b.dataset.pm;
        document.querySelectorAll('.pm button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        document.getElementById('mno-wrap').style.display =
          state.payment === 'mobile_money' ? 'block' : 'none';
      });
    });
    document.querySelectorAll('[data-pool]').forEach((b) => {
      b.addEventListener('click', () => { state.pool = b.dataset.pool; renderQuotes(); });
    });
    const browse = document.getElementById('pool-browse');
    if (browse) browse.addEventListener('click', browsePool);
    document.getElementById('request').addEventListener('click', requestRide);
  }

  // =================================================================
  // Request + live tracking
  // =================================================================
  function readDelivery() {
    const el = (id) => document.getElementById(id);
    if (!el('d-name')) return null;
    const name = el('d-name').value.trim();
    const phone = el('d-phone').value.replace(/\s/g, '');
    const what = el('d-what').value.trim();

    if (name.length < 2) return { error: T('delivery.err_name') };
    if (!/^\+254[0-9]{9}$/.test(phone)) return { error: T('apply.err.phone') };
    if (what.length < 2) return { error: T('delivery.err_what') };

    return {
      recipientName: name,
      recipientPhone: phone,
      description: what,
      size: el('d-size').value,
    };
  }

  async function requestRide() {
    const q = state.selected;
    askNotifyPermission();

    // Booking for someone else needs their name so the driver knows who to
    // look for.
    if (bookingForOther() && state.pName.trim().length < 2) {
      const box = panel.querySelector('#results');
      if (box) box.innerHTML = msg(L3('Andika jina la abiria.', 'Enter the passenger\u2019s name.', 'Saisissez le nom du passager.'), 'err');
      return;
    }

    // A delivery cannot be dispatched without a named recipient — there is
    // nobody to hand it to otherwise.
    if (state.service !== 'ride') {
      const d = readDelivery();
      if (!d || d.error) {
        const box = panel.querySelector('#results');
        if (box) {
          box.innerHTML = msg(
            (d && d.error) ? d.error : T('delivery.err_name'), 'err');
        }
        return;
      }
      state.delivery = d;
    }

    panel.querySelector('#results').innerHTML =
      '<div class="status-box"><div class="spinner"></div><p>' + T('how.2.t') + '</p></div>';

    try {
      const other = bookingForOther();
      const pickupAddr = document.getElementById('from')?.value;
      const dropAddr = document.getElementById('to')?.value;
      const ride = await api('/api/rides/request', {
        method: 'POST',
        body: JSON.stringify({
          clientGeneratedId: crypto.randomUUID(),
          serviceType: state.service,
          ...(other ? { passengerName: state.pName.trim(),
            ...(state.pPhone.trim() ? { passengerPhone: state.pPhone.trim() } : {}) } : {}),
          ...(state.delivery ? { delivery: state.delivery } : {}),
          quoteId: q.quoteId,
          category: q.category,
          paymentMethod: state.payment,
          ...(poolOffered() && state.pool !== 'off' ? { poolMode: state.pool } : {}),
          pickup: { lat: state.pickup.lat, lng: state.pickup.lng,
            address: document.getElementById('from')?.value },
          dropoff: { lat: state.dropoff.lat, lng: state.dropoff.lng,
            address: document.getElementById('to')?.value },
        }),
      });
      afterRequested(ride, {
        serviceType: state.service,
        passengerName: other ? state.pName.trim() : null,
        forOther: other,
        paymentMethod: state.payment,
        pickup: { lat: state.pickup.lat, lng: state.pickup.lng },
        dropoff: { lat: state.dropoff.lat, lng: state.dropoff.lng },
        pickupAddress: pickupAddr, dropoffAddress: dropAddr,
      });
    } catch (e) {
      renderBooking(friendlyError(e.message));
    }
  }

  /** Live updates over the same WebSocket namespace the apps use. */
  function connectSocket() {
    if (state.socket || !window.io) return;
    const socket = window.io('/rt', {
      // Read at every (re)connect, so a reconnect after the access token was
      // renewed carries the new one.
      auth: (cb) => cb({ token: state.token }),
      transports: ['websocket', 'polling'],
    });
    state.socket = socket;
    socket.on('connect_error', async () => {
      const outcome = await refreshSession();
      if (outcome === 'ok') socket.connect();
    });

    socket.on('connect', () => { pollTracking(); });
    socket.on('ride:status_change', (d) => {
      if (!d.rideId) return;
      // Settled fare and what sharing saved (no status on this event).
      if (!d.status && d.poolDiscountCents != null) {
        const r = state.rides[d.rideId];
        if (r) { r.saved = Number(d.poolDiscountCents) || 0; r.finalFareCents = d.fareCents; afterChange(); }
        return;
      }
      if (!d.status) return;
      const known = !!state.rides[d.rideId];
      upsertRide({ rideId: d.rideId, status: d.status, driver: d.driver, vehicle: d.vehicle,
        finalFareCents: d.finalFareCents != null ? d.finalFareCents : (d.fareCents != null ? d.fareCents : undefined) });
      // A ride this page has not met (started on the phone, say), or an
      // accepted event that arrived without the driver: fetch the full picture.
      if (!known || (liveStatus(d.status) && !(state.rides[d.rideId] || {}).driver)) pollTracking();
      afterChange();
    });
    socket.on('ride:message', onChatMessage);
    socket.on('call:signal', (m) => { onCallSignal(m).catch(() => cleanupCall()); });
    socket.on('ride:driver_moved', (d) => {
      const id = d.rid || (state.ride && state.ride.id);
      const r = id && state.rides[id];
      if (!r) return;
      r.driverPosition = { lat: d.la / 1e6, lng: d.ln / 1e6 };
      r.liveAt = Date.now();
      syncMap();
      if (state.view === 'tracking' && Date.now() - (state.lastPanel || 0) > 2500) {
        state.lastPanel = Date.now();
        renderRides();
      }
    });
    socket.on('ride:pool_update', (d) => {
      const r = state.rides[d.rideId] || state.ride;
      if (r) { r.coRiders = Number(d.coRiders) || 0; afterChange(); }
    });
    socket.on('payment:status', (d) => {
      if (d.status !== 'success') return;
      const r = (d.rideId && state.rides[d.rideId]) || state.ride;
      if (r) { r.isPaid = true; afterChange(); }
    });
    // Application heartbeat; the gateway reaps sockets that go quiet.
    setInterval(() => socket.emit('hb', { t: Date.now() }), 20000);
  }

  // =================================================================
  // Rides in progress (one or many)
  // =================================================================
  const OPEN = ['requested', 'searching', 'accepted', 'arrived', 'in_progress'];
  const announced = new Set();
  const openRides = () => Object.values(state.rides).filter((r) => OPEN.includes(r.status));
  const ownOpenInService = () => openRides().some((r) => !r.forOther && (r.serviceType || 'ride') === state.service);
  const bookingForOther = () => state.service === 'ride' && (state.forOther || ownOpenInService());

  function friendlyError(m) {
    if (m === 'already_active_ride') return L3('Tayari una safari yako inayoendelea. Omba kwa ajili ya mtu mwingine.', 'You already have a ride of your own in progress. Book it for someone else.', 'Vous avez déjà une course en cours. Réservez pour quelqu’un d’autre.');
    if (m === 'too_many_active_rides') return L3('Umefikia kikomo cha safari za watu wengine.', 'You have reached the limit of open rides for other people.', 'Limite de courses ouvertes pour d’autres personnes atteinte.');
    return m;
  }

  /** Who is riding: the rider, or someone they are booking for. */
  function forWhomBlock() {
    if (state.service !== 'ride') return '';
    const other = bookingForOther();
    return '<div class="forwhom">' +
      '<div class="fw-label">' + L3('Nani anasafiri?', 'Who is riding?', 'Qui voyage ?') + '</div>' +
      '<div class="pm"><button data-fw="me" class="' + (other ? '' : 'on') + '"' + (ownOpenInService() ? ' disabled style="opacity:.5"' : '') + '>' +
        L3('Kwa ajili yangu', 'For me', 'Pour moi') + '</button>' +
      '<button data-fw="other" class="' + (other ? 'on' : '') + '">' +
        L3('Kwa mtu mwingine', 'For someone else', 'Pour quelqu’un d’autre') + '</button></div>' +
      (ownOpenInService() ? '<p class="fw-note">' + L3('Tayari una safari yako inayoendelea, kwa hiyo hii ni ya mtu mwingine.',
        'You already have a ride of your own in progress, so this one is for someone else.',
        'Vous avez déjà une course en cours, celle-ci est donc pour quelqu’un d’autre.') + '</p>' : '') +
      (other ? '<input id="p-name" placeholder="' + L3('Jina la abiria', 'Passenger name', 'Nom du passager') + '" value="' + esc(state.pName) + '">' +
        '<input id="p-phone" placeholder="' + L3('Simu ya abiria (si lazima)', 'Passenger phone (optional)', 'Téléphone du passager (facultatif)') + '" value="' + esc(state.pPhone) + '">' : '') +
      '</div>';
  }
  function bindForWhom() {
    document.querySelectorAll('[data-fw]').forEach((b) => b.addEventListener('click', () => {
      if (b.disabled) return;
      state.forOther = b.dataset.fw === 'other';
      // The pickup belongs to whoever is riding, so it starts again.
      state.pickupManual = false; state.pickupLabel = ''; state.pinning = false;
      state.pickup = null; clearMarker('pickup');
      const to = document.getElementById('to');
      const keep = { to: to && to.value };
      renderBooking();
      if (keep.to) document.getElementById('to').value = keep.to;
    }));
    const n = document.getElementById('p-name'); if (n) n.addEventListener('input', () => { state.pName = n.value; });
    const p = document.getElementById('p-phone'); if (p) p.addEventListener('input', () => { state.pPhone = p.value; });
  }

  // ---- alerts: notification, sound, vibration, tab title ----
  function askNotifyPermission() {
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (_) {}
  }
  function beep() {
    try {
      const c = new (window.AudioContext || window.webkitAudioContext)();
      const o = c.createOscillator(), g = c.createGain();
      o.connect(g); g.connect(c.destination); g.gain.value = 0.15; o.frequency.value = 880; o.start();
      setTimeout(() => { o.frequency.value = 1175; }, 180);
      setTimeout(() => { o.stop(); c.close(); }, 420);
    } catch (_) {}
  }
  let flashTimer = null; const baseTitle = document.title;
  function flashTitle(text) {
    clearInterval(flashTimer);
    let on = false;
    const stop = () => { clearInterval(flashTimer); document.title = baseTitle; window.removeEventListener('focus', stop); };
    flashTimer = setInterval(() => { document.title = (on = !on) ? text : baseTitle; }, 900);
    window.addEventListener('focus', stop);
    if (!document.hidden) setTimeout(stop, 6000);
  }
  function alertUser(title, body, tag) {
    beep();
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (_) {}
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, tag, icon: '/brand/icon-180.png' }); } catch (_) {}
    flashTitle(title);
  }
  const vehicleLine = (r) => r.vehicle ? [r.vehicle.colour, r.vehicle.make, r.vehicle.model].filter(Boolean).join(' ') + ' · ' + r.vehicle.plate : '';
  function announce(old, r) {
    const key = r.id + ':' + r.status;
    if (announced.has(key)) return;
    if (!old.status) { announced.add(key); return; }
    if (old.status === r.status) return;
    announced.add(key);
    const who = r.forOther ? ' (' + r.passengerName + ')' : '';
    const name = r.driver ? r.driver.name : '';
    if (r.status === 'accepted') alertUser(L3('Dereva amepatikana', 'Driver found', 'Chauffeur trouvé') + who, name + ' — ' + vehicleLine(r), key);
    else if (r.status === 'arrived') alertUser(L3('Dereva wako amefika', 'Your driver has arrived', 'Votre chauffeur est arrivé') + who, name + ' — ' + vehicleLine(r), key);
    else if (r.status === 'in_progress') alertUser(L3('Safari imeanza', 'Trip started', 'Trajet commencé') + who, '', key);
    else if (r.status === 'completed') alertUser(L3('Safari imekamilika', 'Trip complete', 'Trajet terminé') + who, '', key);
  }

  function upsertRide(patch) {
    const id = patch.rideId || patch.id;
    if (!id) return null;
    const old = state.rides[id] || {};
    const clean = {};
    Object.keys(patch).forEach((k) => {
      const v = patch[k];
      if (v === undefined) return;
      if (v === null && (k === 'driver' || k === 'vehicle' || k === 'driverPosition')) return;
      clean[k] = v;
    });
    const r = Object.assign({}, old, clean, { rideId: id, id });
    if (!r.seenAt) r.seenAt = Date.now();
    state.rides[id] = r;
    announce(old, r);
    if (state.ride && state.ride.id === id) state.ride = r;
    if (!state.ride) focusRide(id, true);
    return r;
  }

  function focusRide(id, quiet) {
    const r = state.rides[id];
    if (!r) return;
    if (!state.ride || state.ride.id !== id) { chat.msgs = []; chat.open = false; chat.unread = 0; renderChat(); }
    state.focus = id; state.ride = r;
    if (!quiet) { renderRides(); syncMap(); }
  }

  function afterRequested(ride, extra) {
    const r = upsertRide(Object.assign({}, ride, extra, { status: ride.status || 'searching' }));
    announced.add(r.id + ':' + r.status);
    focusRide(r.id, true);
    // The form starts fresh for the next ride.
    state.dropoff = null; state.quotes = []; state.selected = null; state.delivery = null;
    state.pool = 'off'; state.forOther = false; state.pName = ''; state.pPhone = '';
    state.pickupManual = false; state.pickupLabel = ''; state.pinning = false; state.pickup = state.me || null;
    if (state.routeLine) { state.routeLine.setMap(null); state.routeLine = null; }
    connectSocket();
    pollTracking();
    renderRides();
    syncMap();
  }

  function dropRide(id) {
    delete state.rides[id];
    if (state.ride && state.ride.id === id) {
      state.ride = null; state.focus = null;
      const next = openRides()[0] || Object.values(state.rides)[0];
      if (next) focusRide(next.id, true);
    }
  }

  function afterChange() { syncMap(); if (state.view === 'tracking') renderRides(); }

  /** Rebuilds every open ride from the server: on load, on a timer while rides are open, after a reconnect. */
  async function pollTracking() {
    if (!state.token) return;
    try {
      const list = await api('/api/rides/tracking');
      if (!Array.isArray(list)) return;
      const seen = new Set();
      list.forEach((j) => {
        seen.add(j.rideId);
        const old = state.rides[j.rideId];
        if (!old) announced.add(j.rideId + ':' + j.status);
        const patch = Object.assign({}, j);
        // A live socket position is fresher than a poll; only fill a gap.
        if (old && old.liveAt && Date.now() - old.liveAt < 8000) delete patch.driverPosition;
        delete patch.arrivedAt;
        upsertRide(patch);
      });
      Object.values(state.rides).forEach((r) => {
        if (OPEN.includes(r.status) && !seen.has(r.id) && Date.now() - (r.seenAt || 0) > 25000) {
          r.status = 'expired';
        }
      });
      if (!state.ride) { const f = openRides()[0] || Object.values(state.rides)[0]; if (f) focusRide(f.id, true); }
      syncMap();
      if (state.view === 'tracking') renderRides();
    } catch (_) { /* offline: the socket and the next poll catch up */ }
  }
  setInterval(() => { if (openRides().length) pollTracking(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollTracking(); });

  function distM(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  const fmtDist = (m) => m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m / 10) * 10 + ' m';

  function renderRides() {
    const r = state.ride;
    if (!r) { state.view = 'booking'; return renderBooking(); }
    state.view = 'tracking';
    toggleTopSos(true);
    const so = document.getElementById('signout'); if (so) so.hidden = false;
    const lang = kwemaLang();
    const labels = {
      requested: { sw: 'Tunatafuta dereva...', en: 'Finding a driver...', fr: 'Recherche d’un chauffeur...' },
      searching: { sw: 'Tunatafuta dereva...', en: 'Finding a driver...', fr: 'Recherche d’un chauffeur...' },
      accepted: { sw: 'Dereva amepatikana, anakuja', en: 'Driver found, on the way', fr: 'Chauffeur trouvé, il arrive' },
      arrived: { sw: 'Dereva amefika', en: 'Driver has arrived', fr: 'Le chauffeur est arrivé' },
      in_progress: { sw: 'Safari imeanza', en: 'Trip in progress', fr: 'Trajet en cours' },
      completed: { sw: 'Safari imekamilika', en: 'Trip complete', fr: 'Trajet terminé' },
      expired: { sw: 'Hakuna dereva karibu', en: 'No drivers nearby', fr: 'Aucun chauffeur à proximité' },
      cancelled: { sw: 'Safari imeghairiwa', en: 'Ride cancelled', fr: 'Course annulée' },
      failed: { sw: 'Safari imeshindikana', en: 'Ride failed', fr: 'Course échouée' },
      paid: { sw: 'Malipo yamekamilika', en: 'Payment complete', fr: 'Paiement effectué' },
    };
    const st = (r.status === 'completed' && r.isPaid) ? 'paid' : r.status;
    const label = (labels[st] || labels.searching)[lang];
    const done = !OPEN.includes(r.status);
    const live = liveStatus(r.status);

    let away = '';
    if (r.driverPosition && (r.status === 'accepted' || r.status === 'in_progress')) {
      const tgt = r.status === 'accepted' ? r.pickup : r.dropoff;
      if (tgt) away = '<p style="text-align:center;color:var(--lk-700);font-weight:700;margin:0 0 10px">' +
        (r.status === 'accepted'
          ? L3('Dereva yuko umbali wa ', 'Driver is ', 'Le chauffeur est à ')
          : L3('Umbali wa kufika: ', 'To destination: ', 'Jusqu’à destination : ')) +
        fmtDist(distM(r.driverPosition, tgt)) + (r.status === 'accepted' ? L3('', ' away', '') : '') + '</p>';
    }

    const tabs = Object.values(state.rides).length > 1
      ? '<div class="ride-tabs">' + Object.values(state.rides).map((x) =>
          '<button data-focus="' + x.id + '" class="' + (x.id === r.id ? 'on' : '') + '">' +
          esc(x.forOther ? x.passengerName : L3('Mimi', 'Me', 'Moi')) + ' · ' +
          ((labels[x.status] || labels.searching)[lang]).replace('...', '') + '</button>').join('') + '</div>'
      : '';

    const d = r.driver, v = r.vehicle;
    const initial = esc(((d && d.name) || '?')[0]);
    const card = d ? '<div class="driver-card"><div class="dc-row">' +
        (d.photoUrl
          ? '<img class="dc-photo" src="' + esc(API + d.photoUrl) + '" alt="" data-init="' + initial + '">'
          : '<div class="dc-photo dc-init">' + initial + '</div>') +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:800;font-size:17px">' + esc(d.name) + '</div>' +
          '<div style="color:var(--muted);font-size:13px">★ ' + Number(d.rating || 5).toFixed(1) +
            (d.trips ? ' · ' + d.trips + ' ' + L3('safari', 'trips', 'courses') : '') + '</div>' +
          (v ? '<div style="font-weight:600;margin-top:4px">' + esc([v.colour, v.make, v.model].filter(Boolean).join(' ')) + '</div>' +
               '<div class="plate">' + esc(v.plate) + '</div>' : '') +
        '</div></div></div>' : '';

    const fare = (r.finalFareCents != null ? r.finalFareCents : r.quotedFareCents);

    panel.innerHTML =
      tabs +
      (r.forOther ? '<p style="font-weight:700;margin:0 0 6px">📍 ' + L3('Kwa ', 'For ', 'Pour ') + esc(r.passengerName) + '</p>' : '') +
      '<div class="status-box">' +
        (done ? '' : '<div class="spinner"></div>') +
        '<h2 style="font-size:20px;font-weight:800">' + label + '</h2>' +
        (r.reference ? '<p style="color:var(--muted);font-size:14px;margin-top:6px">' + esc(r.reference) + '</p>' : '') +
      '</div>' +
      (r.status === 'arrived'
        ? msg('🔔 ' + L3('Dereva wako amefika. Mtafute kwa namba ya gari.', 'Your driver has arrived. Look for the plate number.', 'Votre chauffeur est arrivé. Repérez la plaque.'), 'ok') : away) +
      (r.coRiders > 0 && !done
        ? '<div class="pool-note" style="text-align:center;margin-bottom:8px">' + fill(T('pool.sharing'), { n: r.coRiders }) + '</div>' : '') +
      (r.saved > 0 && r.status === 'completed'
        ? '<div class="pool-note" style="text-align:center;margin-bottom:8px">' + fill(T('pool.saved'), { amount: kwemaMoney(r.saved) }) + '</div>' : '') +
      card +
      (live && d
        ? '<div style="display:flex;gap:8px;margin:10px 0">' +
          '<button class="btn btn-ghost" style="flex:1" id="chat-btn">' + chatLabel() + '</button>' +
          '<button class="btn btn-primary" style="flex:1" id="call-btn">📞 ' + L3('Piga simu', 'Call', 'Appeler') + '</button></div>'
        : '') +
      (fare ? '<p style="text-align:center;font-weight:800;font-size:18px;margin:8px 0">' + kwemaMoney(fare) + '</p>' : '') +
      (r.status === 'completed' && !r.isPaid && r.paymentMethod && r.paymentMethod !== 'cash'
        ? '<button class="btn btn-primary" style="width:100%" id="pay">' + T('pay.mm.t') + '</button>' : '') +
      (!done ? '<button class="btn btn-ghost" style="width:100%;margin-top:10px" id="share-trip">📍 ' + T('share.btn') + '</button>' +
        '<div id="share-opts" hidden style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"></div>' : '') +
      (!done ? '<button class="btn-sos" id="sos">' +
        (lang === 'fr' ? 'Urgence' : lang === 'en' ? 'Emergency' : 'Dharura') + '</button>' : '') +
      // Booking again never waits: not for payment, not for another ride.
      '<button class="btn btn-ghost" style="width:100%;margin-top:10px" id="another">+ ' + L3('Omba safari nyingine', 'Request another ride', 'Demander une autre course') + '</button>' +
      (done ? '<button class="btn btn-ghost" style="width:100%;margin-top:8px" id="close-ride">' + L3('Funga', 'Close', 'Fermer') + '</button>' : '');

    bindCommButtons();
    if (!live) { chat.open = false; renderChat(); if (call.state !== 'idle') endCall(true); }

    // A driver photo that fails to load falls back to the initial.
    panel.querySelectorAll('img.dc-photo').forEach((img) => img.addEventListener('error', () => {
      const f = document.createElement('div');
      f.className = 'dc-photo dc-init'; f.textContent = img.dataset.init || '?';
      img.replaceWith(f);
    }));
    panel.querySelectorAll('[data-focus]').forEach((b) => b.addEventListener('click', () => focusRide(b.dataset.focus)));
    const another = document.getElementById('another');
    if (another) another.addEventListener('click', () => {
      if (done) dropRide(r.id);
      state.dropoff = null; state.quotes = []; state.selected = null;
      state.pickupManual = false; state.pickupLabel = ''; state.pinning = false; state.pickup = state.me || null;
      renderBooking();
    });
    const closeBtn = document.getElementById('close-ride');
    if (closeBtn) closeBtn.addEventListener('click', () => { dropRide(r.id); if (state.ride) { renderRides(); syncMap(); } else renderBooking(); });
    const pay = document.getElementById('pay'); if (pay) pay.addEventListener('click', payNow);
    const sos = document.getElementById('sos'); if (sos) sos.addEventListener('click', raiseSos);
    const shareBtn = document.getElementById('share-trip');
    if (shareBtn) shareBtn.addEventListener('click', () => shareTrip(r.id || r.rideId));
  }

  /**
   * Live trip sharing: gets a tracking link for this trip and offers it on
   * WhatsApp, SMS or the phone's own share sheet. Anyone with the link sees
   * the vehicle move until the trip ends.
   */
  async function shareTrip(rideId) {
    const box = document.getElementById('share-opts');
    try {
      const out = await api('/api/rides/' + encodeURIComponent(rideId) + '/share', { method: 'POST' });
      if (navigator.share) {
        try { await navigator.share({ title: 'Kwema Ride', text: out.text }); return; }
        catch (e) { /* dismissed or unsupported: fall back to the buttons */ }
      }
      if (!box) return;
      box.hidden = false;
      box.innerHTML =
        '<a class="btn btn-primary" style="flex:1;text-align:center" target="_blank" rel="noopener" href="' + esc(out.whatsappUrl) + '">' + T('share.whatsapp') + '</a>' +
        '<a class="btn btn-ghost" style="flex:1;text-align:center" href="' + esc(out.smsUrl) + '">' + T('share.sms') + '</a>' +
        '<button class="btn btn-ghost" style="flex:1" id="share-copy">' + T('share.copy') + '</button>';
      const copy = document.getElementById('share-copy');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(out.url); copy.textContent = T('share.copied'); }
        catch (e) { prompt(T('share.copy'), out.url); }
      });
    } catch (e) {
      alert(e.message || 'Could not create the link');
    }
  }

  async function payNow() {
    try {
      if (state.payment === 'card') {
        const out = await api('/api/payments/card/initiate', {
          method: 'POST', body: JSON.stringify({ rideId: state.ride.rideId || state.ride.id }),
        });
        // Card details are entered on the provider's own page, never here.
        window.open(out.checkoutUrl, '_blank', 'noopener');
      } else {
        await api('/api/payments/collect', {
          method: 'POST',
          body: JSON.stringify({
            rideId: state.ride.rideId || state.ride.id,
            mno: (document.getElementById('mno') || {}).value || 'mpesa',
          }),
        });
        afterChange();
      }
    } catch (e) {
      panel.insertAdjacentHTML('afterbegin', msg(e.message, 'err'));
    }
  }

  // =================================================================
  // Emergency
  //
  // Confirmed once, because a misfire costs an operator's night, then sent
  // with whatever location the browser can give. A refused or unavailable
  // geolocation must never block the alert.
  // =================================================================
  async function raiseSos() {
    const lang = kwemaLang();
    const confirmText = lang === 'fr'
      ? 'Envoyer une alerte d\u2019urgence à Kwema Ride ?'
      : lang === 'en'
      ? 'Send an emergency alert to Kwema Ride?'
      : 'Tuma ombi la dharura kwa Kwema Ride?';
    if (!window.confirm(confirmText)) return;

    let coords = null;
    try {
      coords = await new Promise((resolve) => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude,
                           accuracyM: Math.round(p.coords.accuracy) }),
          () => resolve(null),
          { timeout: 4000, enableHighAccuracy: true });
      });
    } catch { coords = null; }

    try {
      await api('/sos', {
        method: 'POST',
        body: JSON.stringify({
          rideId: state.ride && (state.ride.rideId || state.ride.id),
          ...(coords || {}),
        }),
      });
    } catch { /* the alert is still worth confirming; ops also watch the log */ }

    const sent = lang === 'fr'
      ? 'Alerte envoyée. Appelez le 112 pour la police, l\u2019ambulance ou les pompiers.'
      : lang === 'en'
      ? 'Alert sent. Call 112 for police, ambulance or fire.'
      : 'Ombi limetumwa. Piga 112 kwa polisi, ambulensi au zimamoto.';
    if (window.confirm(sent + '\n\nOK = 112')) {
      window.location.href = 'tel:112';
    }
  }

  // =================================================================
  // Map
  // =================================================================
  function initMap() {
    if (!window.google || !window.google.maps) {
      document.getElementById('map').innerHTML =
        '<div class="map-fallback"><strong>' +
        (kwemaLang() === 'fr' ? 'Carte indisponible' : kwemaLang() === 'en' ? 'Map unavailable' : 'Ramani haipatikani') +
        '</strong><span>' +
        (kwemaLang() === 'fr' ? 'La réservation fonctionne quand même.'
         : kwemaLang() === 'en' ? 'Booking still works without it.'
         : 'Bado unaweza kuomba safari.') + '</span></div>';
      return;
    }
    state.map = new google.maps.Map(document.getElementById('map'), {
      center: { lat: -1.2864, lng: 36.8172 }, // Nairobi city centre
      zoom: 13,
      disableDefaultUI: true,
      zoomControl: true,
    });
    // Back off for a few seconds after the rider moves the map themselves.
    state.map.addListener('dragstart', () => { state.mapPausedUntil = Date.now() + 12000; });
    // Placing the passenger's pickup by clicking the map.
    state.map.addListener('click', (e) => {
      if (!state.pinning || !e.latLng) return;
      placePickup({ lat: e.latLng.lat(), lng: e.latLng.lng() });
    });
    // "My location" button.
    const here = document.createElement('button');
    here.type = 'button'; here.className = 'btn btn-ghost'; here.textContent = '\u25ce';
    here.title = kwemaLang() === 'en' ? 'My location' : kwemaLang() === 'fr' ? 'Ma position' : 'Mahali nilipo';
    here.style.cssText = 'margin:10px;padding:8px 12px;font-size:18px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.25)';
    here.addEventListener('click', () => {
      state.mapPausedUntil = 0;
      if (state.me) { state.map.panTo(state.me); state.map.setZoom(16); }
      else useBrowserLocation();
    });
    state.map.controls[google.maps.ControlPosition.RIGHT_BOTTOM].push(here);
  }

  function clearMarker(k) {
    if (state.markers[k]) { state.markers[k].setMap(null); delete state.markers[k]; }
  }

  /** Creates the marker, or moves it if it exists (no flicker on every GPS fix). */
  function setMarker(key, point, label, opts) {
    opts = opts || {};
    if (!state.map) return;
    const base = key.split(':')[0];
    const colours = { pickup: '#1E7A4C', dropoff: '#C0392B', driver: '#3A4BB8', other: '#E67E22', me: '#2563EB' };
    const existing = state.markers[key];
    if (existing) {
      existing.setPosition(point);
      existing.setTitle(label || '');
    } else {
      state.markers[key] = new google.maps.Marker({
        position: point, map: state.map, title: label,
        zIndex: base === 'driver' ? 5 : (base === 'me' ? 6 : 1),
        icon: {
          path: google.maps.SymbolPath.CIRCLE, scale: base === 'me' ? 8 : 9,
          fillColor: colours[base] || '#8E44AD', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3,
        },
      });
    }
    if (base === 'pickup') {
      const m = state.markers[key];
      // The pickup of a ride for someone else can be dragged to adjust it.
      m.setDraggable(state.view === 'booking' && bookingForOther());
      if (!m._kwemaDrag) {
        m._kwemaDrag = true;
        m.addListener('dragend', (e) => { if (e.latLng) placePickup({ lat: e.latLng.lat(), lng: e.latLng.lng() }); });
      }
    }
    if (opts.fit === false) return;
    const bounds = new google.maps.LatLngBounds();
    Object.values(state.markers).forEach((m) => bounds.extend(m.getPosition()));
    if (Object.keys(state.markers).length > 1) state.map.fitBounds(bounds, 70);
    else state.map.setCenter(point);
  }

  /** Puts the right markers on the map for what the panel is showing. */
  function syncMap() {
    if (!state.map) return;
    const tracking = state.view === 'tracking' && state.ride;
    const r = state.ride;
    const pk = tracking ? r.pickup : state.pickup;
    const dp = tracking ? r.dropoff : state.dropoff;
    if (pk && !(tracking && r.status === 'in_progress')) setMarker('pickup', pk, 'Pickup', { fit: false }); else clearMarker('pickup');
    if (dp) setMarker('dropoff', dp, 'Drop-off', { fit: false }); else clearMarker('dropoff');

    const wantD = new Set(), wantO = new Set();
    openRides().forEach((x) => {
      if (x.driverPosition) {
        const k = 'driver:' + x.id; wantD.add(k);
        setMarker(k, x.driverPosition, (x.forOther ? x.passengerName + ' \u00b7 ' : '') + ((x.driver && x.driver.name) || 'Dereva'), { fit: false });
      }
      if (tracking && x.id !== r.id && x.pickup && x.status !== 'in_progress') {
        const k = 'other:' + x.id; wantO.add(k);
        setMarker(k, x.pickup, x.forOther ? x.passengerName : 'Pickup', { fit: false });
      }
    });
    Object.keys(state.markers).forEach((k) => {
      if ((k.startsWith('driver:') && !wantD.has(k)) || (k.startsWith('other:') && !wantO.has(k))) clearMarker(k);
    });
    if (tracking) fitTracking();
  }

  /** Keeps the focused ride's car, its next stop and the rider in view. */
  function fitTracking() {
    if (!state.map || !state.ride) return;
    const now = Date.now();
    if (now < (state.mapPausedUntil || 0) || now - (state.lastFit || 0) < 4000) return;
    const r = state.ride;
    const pts = [];
    if (r.driverPosition) pts.push(r.driverPosition);
    const target = r.status === 'in_progress' ? r.dropoff : r.pickup;
    if (target) pts.push(target);
    if (state.me) pts.push(state.me);
    if (pts.length < 2) { if (pts.length === 1) state.map.panTo(pts[0]); return; }
    state.lastFit = now;
    const bounds = new google.maps.LatLngBounds();
    pts.forEach((p) => bounds.extend(p));
    state.map.fitBounds(bounds, 80);
  }

  function drawRoute(polyline) {
    if (!state.map || !polyline || !google.maps.geometry) return;
    if (state.routeLine) state.routeLine.setMap(null);
    state.routeLine = new google.maps.Polyline({
      path: google.maps.geometry.encoding.decodePath(polyline),
      strokeColor: '#3A4BB8', strokeWeight: 5, strokeOpacity: 0.85, map: state.map,
    });
  }

  /** Follows the rider's own position, so the map shows where they are now. */
  function useBrowserLocation() {
    if (!navigator.geolocation || state.watchId != null) return;
    state.watchId = navigator.geolocation.watchPosition(async (pos) => {
      if (pos.coords.accuracy > 200) return;
      const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const first = !state.me;
      state.me = p;
      setMarker('me', p, L3('Mimi', 'Me', 'Moi'), { fit: false });
      const booking = state.view === 'booking';
      // The pickup follows the rider until they choose one or pick a destination.
      if (booking && !bookingForOther() && !state.pickupManual && !state.dropoff && (!state.pickup || distM(state.pickup, p) > 25)) {
        state.pickup = p;
        setMarker('pickup', p, 'Pickup', { fit: false });
      }
      if (booking && !state.dropoff && state.map && Date.now() > (state.mapPausedUntil || 0)) {
        if (first) state.map.setZoom(16);
        state.map.panTo(p);
      }
      if (state.view === 'tracking') fitTracking();
      if (first) {
        try {
          const r = await api('/api/maps/reverse-geocode?lat=' + p.lat + '&lng=' + p.lng + '&language=' + kwemaLang());
          const input = document.getElementById('from');
          if (r.address && input && !input.value && !bookingForOther()) input.value = r.address;
        } catch { /* a blank pickup field is fine; the marker is set */ }
      }
    }, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }

  // =================================================================
  // Boot
  // =================================================================
  document.querySelectorAll('#lang button').forEach((b) => {
    b.addEventListener('click', () => {
      kwemaSetLang(b.dataset.lang);
      location.reload();
    });
  });

  fetch('/api/config/public').then((r) => r.json()).then((cfg) => {
    state.config = cfg;
    const scripts = [];
    if (cfg.mapsBrowserKey) {
      // loading=async silences Google's performance warning and is their
      // documented pattern for script-tag loading.
      scripts.push('https://maps.googleapis.com/maps/api/js?key=' +
        encodeURIComponent(cfg.mapsBrowserKey) + '&libraries=geometry&loading=async');
    }
    scripts.push('/socket.io/socket.io.js');

    let pending = scripts.length;
    if (!pending) return start();
    scripts.forEach((src) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = s.onerror = () => { if (--pending === 0) start(); };
      document.head.appendChild(s);
    });
  }).catch(start);


  // =================================================================
  // In-ride messages and audio calls (rider <-> driver, live trips only)
  // =================================================================
  const L3 = (sw, en, fr) => ({ sw, en, fr })[kwemaLang()] || en;
  const rideIdNow = () => state.ride && (state.ride.rideId || state.ride.id);
  const liveStatus = (st) => ['accepted', 'arrived', 'in_progress'].includes(st);

  function myUserId() {
    try { return JSON.parse(atob(state.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; }
    catch (_) { return null; }
  }
  const chat = { open: false, msgs: [], unread: 0 };

  function chatEl() { return document.getElementById('chat-overlay'); }

  function renderChat() {
    let box = chatEl();
    if (!chat.open) { if (box) box.remove(); return; }
    if (!box) {
      box = document.createElement('div');
      box.id = 'chat-overlay';
      box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:50;background:var(--surface,#fff);' +
        'border-top-left-radius:18px;border-top-right-radius:18px;box-shadow:0 -6px 30px rgba(0,0,0,.25);' +
        'max-width:520px;margin:0 auto;padding:14px;display:flex;flex-direction:column;height:60vh;';
      document.body.appendChild(box);
    }
    box.innerHTML =
      '<div style="display:flex;align-items:center;margin-bottom:8px">' +
        '<strong style="flex:1;font-size:16px">' + L3('Ujumbe', 'Messages', 'Messages') + '</strong>' +
        '<button class="btn btn-ghost" id="chat-close">' + L3('Funga', 'Close', 'Fermer') + '</button></div>' +
      '<div id="chat-list" style="flex:1;overflow:auto;display:flex;flex-direction:column;gap:6px">' +
        (chat.msgs.length ? chat.msgs.map((m) =>
          '<div style="align-self:' + (m.mine ? 'flex-end' : 'flex-start') + ';max-width:78%;padding:8px 12px;' +
          'border-radius:14px;background:' + (m.mine ? 'var(--primary,#3A4BB8);color:#fff' : '#eee;color:#222') + '">' +
          esc(m.body) + '</div>').join('')
          : '<p style="color:var(--muted);text-align:center;margin-top:20px">' +
            L3('Hakuna ujumbe bado.', 'No messages yet.', 'Aucun message.') + '</p>') +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:8px">' +
        '<input id="chat-input" maxlength="500" style="flex:1" placeholder="' +
          L3('Andika ujumbe', 'Type a message', 'Écrire un message') + '">' +
        '<button class="btn btn-primary" id="chat-send">' + L3('Tuma', 'Send', 'Envoyer') + '</button></div>';
    const list = document.getElementById('chat-list');
    list.scrollTop = list.scrollHeight;
    document.getElementById('chat-close').onclick = () => { chat.open = false; renderChat(); };
    const send = async () => {
      const input = document.getElementById('chat-input');
      const body = input.value.trim();
      if (!body) return;
      input.value = '';
      try { await api('/api/rides/' + rideIdNow() + '/messages', { method: 'POST', body: JSON.stringify({ body }) }); }
      catch (_) { input.value = body; }
    };
    document.getElementById('chat-send').onclick = send;
    document.getElementById('chat-input').onkeydown = (e) => { if (e.key === 'Enter') send(); };
  }

  async function openChat() {
    chat.open = true; chat.unread = 0;
    try {
      const list = await api('/api/rides/' + rideIdNow() + '/messages');
      chat.msgs = list.map((m) => ({ id: m.id, mine: m.mine, body: m.body }));
    } catch (_) {}
    renderChat();
  }

  function onChatMessage(m) {
    if (m.rideId !== rideIdNow() || chat.msgs.some((x) => x.id === m.id)) return;
    chat.msgs.push({ id: m.id, mine: m.senderId === myUserId(), body: m.body });
    if (chat.open) renderChat(); else { chat.unread += 1; const b = document.getElementById('chat-btn'); if (b) b.textContent = chatLabel(); }
  }
  const chatLabel = () => '💬 ' + L3('Ujumbe', 'Message', 'Message') + (chat.unread ? ' (' + chat.unread + ')' : '');

  // ---- audio call (WebRTC; the server only relays the signalling) ----
  const call = { pc: null, stream: null, rideId: null, state: 'idle', pendingIce: [], incoming: false };

  function callSignal(type, data) {
    if (state.socket) state.socket.emit('call:signal', { rideId: call.rideId || rideIdNow(), type, data });
  }

  function callBar(text, actions) {
    let bar = document.getElementById('call-bar');
    if (!text) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'call-bar';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:60;background:#1E7A4C;color:#fff;' +
        'padding:12px 16px;display:flex;gap:10px;align-items:center;justify-content:center;';
      document.body.appendChild(bar);
    }
    bar.innerHTML = '<span style="flex:1">' + text + '</span>' +
      actions.map((a, i) => '<button class="btn" data-i="' + i + '" style="background:#fff;color:#222">' + a.label + '</button>').join('');
    bar.querySelectorAll('button').forEach((b) => { b.onclick = actions[Number(b.dataset.i)].run; });
  }

  async function makePeer() {
    const cfg = await api('/api/rides/' + call.rideId + '/call-config');
    call.pc = new RTCPeerConnection({ iceServers: cfg.iceServers });
    call.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    call.stream.getTracks().forEach((t) => call.pc.addTrack(t, call.stream));
    call.pc.onicecandidate = (e) => { if (e.candidate) callSignal('ice', e.candidate.toJSON()); };
    call.pc.ontrack = (e) => {
      let a = document.getElementById('call-audio');
      if (!a) { a = document.createElement('audio'); a.id = 'call-audio'; a.autoplay = true; document.body.appendChild(a); }
      a.srcObject = e.streams[0];
    };
    call.pc.onconnectionstatechange = () => {
      if (call.pc && call.pc.connectionState === 'connected') {
        call.state = 'active';
        callBar(L3('Simu inaendelea', 'On a call', 'Appel en cours'), [{ label: L3('Kata', 'Hang up', 'Raccrocher'), run: () => endCall(true) }]);
      }
      if (call.pc && ['failed', 'closed'].includes(call.pc.connectionState)) endCall(false);
    };
  }

  function cleanupCall() {
    try { if (call.pc) call.pc.close(); } catch (_) {}
    try { if (call.stream) call.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    const a = document.getElementById('call-audio'); if (a) a.remove();
    call.pc = null; call.stream = null; call.state = 'idle'; call.pendingIce = []; call.incoming = false;
    callBar(null);
  }

  function endCall(notify) {
    if (notify) callSignal('end');
    cleanupCall();
  }

  async function startCall() {
    if (call.state !== 'idle') return;
    if (!navigator.mediaDevices || !window.RTCPeerConnection) {
      alert(L3('Kivinjari hiki hakiwezi kupiga simu.', 'This browser cannot place calls.', 'Ce navigateur ne peut pas appeler.'));
      return;
    }
    call.rideId = rideIdNow(); call.state = 'calling';
    callBar(L3('Inapiga simu…', 'Calling…', 'Appel…'), [{ label: L3('Ghairi', 'Cancel', 'Annuler'), run: () => endCall(true) }]);
    try { await makePeer(); callSignal('invite'); }
    catch (_) { cleanupCall(); }
    setTimeout(() => { if (call.state === 'calling') endCall(true); }, 45000);
  }

  async function onCallSignal(m) {
    if (m.type === 'invite') {
      if (call.state !== 'idle') { state.socket.emit('call:signal', { rideId: m.rideId, type: 'busy' }); return; }
      call.rideId = m.rideId; call.state = 'ringing'; call.incoming = true;
      callBar(L3('Dereva anapiga simu', 'Your driver is calling', 'Votre chauffeur appelle'), [
        { label: L3('Pokea', 'Answer', 'Répondre'), run: async () => {
          try { await makePeer(); call.state = 'connecting'; callSignal('accept'); callBar(L3('Inaunganisha…', 'Connecting…', 'Connexion…'), []); }
          catch (_) { callSignal('reject'); cleanupCall(); }
        } },
        { label: L3('Kataa', 'Decline', 'Refuser'), run: () => { callSignal('reject'); cleanupCall(); } },
      ]);
      return;
    }
    if (m.rideId !== call.rideId) return;
    if (m.type === 'accept' && call.pc) {
      call.state = 'connecting';
      const offer = await call.pc.createOffer();
      await call.pc.setLocalDescription(offer);
      callSignal('offer', offer);
    } else if (m.type === 'offer' && call.pc) {
      await call.pc.setRemoteDescription(m.data);
      for (const c of call.pendingIce) await call.pc.addIceCandidate(c);
      call.pendingIce = [];
      const answer = await call.pc.createAnswer();
      await call.pc.setLocalDescription(answer);
      callSignal('answer', answer);
    } else if (m.type === 'answer' && call.pc) {
      await call.pc.setRemoteDescription(m.data);
      for (const c of call.pendingIce) await call.pc.addIceCandidate(c);
      call.pendingIce = [];
    } else if (m.type === 'ice') {
      if (call.pc && call.pc.remoteDescription) { try { await call.pc.addIceCandidate(m.data); } catch (_) {} }
      else call.pendingIce.push(m.data);
    } else if (['reject', 'busy', 'end'].includes(m.type)) {
      cleanupCall();
    }
  }

  function bindCommButtons() {
    const c = document.getElementById('chat-btn'); if (c) c.onclick = openChat;
    const k = document.getElementById('call-btn'); if (k) k.onclick = startCall;
  }

  function start() {
    const topSos = document.getElementById('sos-top');
    if (topSos) {
      topSos.textContent = kwemaLang() === 'fr' ? 'Urgence'
        : kwemaLang() === 'en' ? 'Emergency' : 'Dharura';
      topSos.addEventListener('click', raiseSos);
    }
    const bar = document.querySelector('header, .topbar, .site-header') || document.body;
    const out = document.createElement('button');
    out.id = 'signout'; out.className = 'btn btn-ghost'; out.hidden = true;
    out.style.cssText = 'position:fixed;top:8px;right:90px;z-index:40;font-size:12px;padding:4px 10px';
    out.textContent = kwemaLang() === 'fr' ? 'Déconnexion' : kwemaLang() === 'en' ? 'Sign out' : 'Toka';
    out.addEventListener('click', async () => {
      try { await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: lsGet('kwema_refresh') }) }); } catch (_) {}
      endSession();
    });
    document.body.appendChild(out);
    initMap();
    if (!lsGet('kwema_refresh')) { state.token = null; renderLogin(); return; }
    // Returning visitor: renew first so the first request is not a 401.
    refreshSession().then(async (outcome) => {
      if (outcome === 'ok' || (outcome === 'unreachable' && state.token)) {
        // Pick up rides already open (started on the phone, or before a reload).
        connectSocket();
        await pollTracking();
        if (openRides().length) renderRides(); else renderBooking();
      } else renderLogin();
    });
  }
})();
