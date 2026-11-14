/* Landing page behaviour.
 *
 * The board is the page's one moving part. Everything else responds only to a
 * click, and the board itself stops if the visitor has asked for reduced
 * motion or moves focus into the page.
 */

(function () {
  // ---------------------------------------------------------------
  // Fares
  //
  // Computed here from the same rate card the server uses, so
  // the marketing figures cannot drift away from what someone is actually
  // quoted. Amounts in the local currency. These are the placeholder rates pending the official
  // tariff, which is what the banner at the top of the page says.
  // ---------------------------------------------------------------
  // Speeds are average door-to-door pace on a real city route, taken from what
  // Google Directions actually returns — not the much slower figure the
  // dispatcher uses to estimate a driver's approach through traffic. Using
  // the dispatch figure here inflated every duration roughly fourfold and
  // made the board quote prices the app would never charge.
  // Average door-to-door pace on a real city route, from what Google
  // Directions returns — not the slower figure the dispatcher uses to
  // estimate a driver's approach through traffic.
  const TIERS = {
    boda:     { colour: '#D9722B', speed: 32 },
    bajaji:   { colour: '#C9A227', speed: 26 },
    standard: { colour: '#3A4BB8', speed: 30 },
    xl:       { colour: '#2E7D74', speed: 28 },
  };

  function minutes(tier, km) {
    return Math.max(1, Math.round((km / TIERS[tier].speed) * 60));
  }

  // Indicative routes with approximate road distances; replace with real,
  // recognisable pairs from the client.
  const ROUTES = [
    { from: "Nairobi CBD", to: "Westlands", km: 6.0 },
    { from: "Kilimani", to: "Upper Hill", km: 3.5 },
    { from: "JKIA", to: "Nairobi CBD", km: 16.0 },
    { from: "Eastleigh", to: "Nairobi CBD", km: 4.5 },
    { from: "Kasarani", to: "Roysambu", km: 5.5 },
    { from: "Karen", to: "Lang’ata", km: 8.0 },
    { from: "South B", to: "Industrial Area", km: 5.0 },
  ];

  const TIER_NAMES = {"en": {"boda": "Bodaboda", "bajaji": "Tuk-tuk", "standard": "Car", "xl": "Car XL"}, "sw": {"boda": "Bodaboda", "bajaji": "Tuk-tuk", "standard": "Gari", "xl": "Gari Kubwa"}, "fr": {"boda": "Moto-taxi", "bajaji": "Tuk-tuk", "standard": "Voiture", "xl": "Voiture XL"}, "rw": {"boda": "Moto", "bajaji": "Tuk-tuk", "standard": "Imodoka", "xl": "Imodoka XL"}, "lg": {"boda": "Bodaboda", "bajaji": "Tuk-tuk", "standard": "Mmotoka", "xl": "Mmotoka XL"}};
  const TIER_KEY = TIER_NAMES.en;

  let index = 0;
  let timer = null;

  function paintBoard(animate) {
    const r = ROUTES[index];
    const lang = kwemaLang();

    document.getElementById('from').textContent = r.from;
    document.getElementById('to').textContent = r.to;
    document.getElementById('meta').textContent = r.km.toFixed(1) + ' km';

    const names = TIER_NAMES[lang] || TIER_NAMES.en;

    const unit = 'min';

    // Travel time, not fare. Quoting prices here would commit the business to
    // figures set by a rate card that is still provisional, and a marketing
    // number that disagrees with the app's quote is worse than no number.
    document.getElementById('fares').innerHTML = Object.keys(TIERS).map((tier) => `
      <div class="fare">
        <div class="bar" style="background:${TIERS[tier].colour}"></div>
        <div class="tier">${names[tier]}</div>
        <div class="amt">${minutes(tier, r.km)}</div>
        <div class="min">${unit}</div>
      </div>`).join('');

    const board = document.getElementById('board');
    if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      board.classList.remove('board-swap');
      void board.offsetWidth; // restart the animation
      board.classList.add('board-swap');
    }
  }

  function startBoard() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    stopBoard();
    timer = setInterval(() => {
      index = (index + 1) % ROUTES.length;
      paintBoard(true);
    }, 3600);
  }
  function stopBoard() { if (timer) { clearInterval(timer); timer = null; } }

  // Stop cycling when the tab is hidden — no reason to spend a phone's
  // battery redrawing a board nobody is looking at.
  document.addEventListener('visibilitychange', () => {
    document.hidden ? stopBoard() : startBoard();
  });

  // ---------------------------------------------------------------
  // Downloads
  //
  // Store URLs come from the server so links go live the moment the apps are
  // published, without a redeploy. Anything unconfigured renders as a
  // disabled tile rather than a dead link.
  //
  // The direct APK sits alongside the stores rather than below them: Play
  // Store access is inconsistent on the cheaper Android handsets sold here,
  // and sideloading is an ordinary way to install an app in this market.
  // ---------------------------------------------------------------
  let config = {};
  let currentDl = 'rider';

  function renderStores(which) {
    currentDl = which;
    const row = document.getElementById('stores');
    const apps = (config.apps && config.apps[which]) || {};

    row.innerHTML = [
      ['ios', apps.ios, 'App Store', 'iPhone'],
      ['android', apps.android, 'Google Play', 'Android'],
      ['apk', apps.apk, 'APK', kwemaT('dl.apk')],
    ].map(([kind, url, small, strong]) => {
      const live = Boolean(url);
      return `<a class="store${live ? '' : ' off'}" href="${live ? url : '#'}"
                 ${live ? 'rel="noopener"' : 'aria-disabled="true"'}
                 ${kind === 'apk' && live ? 'download' : ''}>
                <span><small>${live ? small : kwemaT('dl.soon')}</small>
                <strong>${strong}</strong></span></a>`;
    }).join('');

    document.getElementById('apk-note').textContent = kwemaT('dl.apk.note');
  }

  document.querySelectorAll('.dl-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.dl-tab').forEach((t) => t.classList.remove('on'));
      tab.classList.add('on');
      renderStores(tab.dataset.dl);
    });
  });

  fetch('/api/config/public')
    .then((r) => r.json())
    .then((c) => { config = c; renderStores('rider'); })
    .catch(() => renderStores('rider'));

  // ---------------------------------------------------------------
  kwemaApplyI18n();
  document.querySelectorAll('#lang button').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === kwemaLangRaw());
    b.addEventListener('click', () => {
      kwemaSetLang(b.dataset.lang);
      paintBoard(false);
      renderStores(currentDl);
    });
  });

  paintBoard(false);
  startBoard();
})();

/* ---------------------------------------------------------------------
 * Driver applications.
 *
 * Three fields plus consent. Documents are collected later: asking someone
 * to photograph a licence and an insurance certificate on a roadside web
 * form is how an applicant becomes a bounce.
 * ------------------------------------------------------------------- */
(function () {
  const form = document.getElementById('apply-form');
  if (!form) return;

  const msg = document.getElementById('apply-msg');
  const submit = document.getElementById('ap-submit');

  const show = (text, kind) => {
    msg.innerHTML = `<div class="apply-note apply-${kind}">${text}</div>`;
    msg.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const t = (key) => kwemaT(key);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.innerHTML = '';
    document.querySelectorAll('.apply-card input').forEach(
      (el) => el.removeAttribute('aria-invalid'));

    const name = document.getElementById('ap-name');
    const phone = document.getElementById('ap-phone');
    const email = document.getElementById('ap-email');
    const consent = document.getElementById('ap-consent');

    // Validate here as well as on the server, so someone on a poor connection
    // learns about a typo before waiting on a request.
    const phoneValue = phone.value.replace(/\s/g, '');
    if (name.value.trim().length < 2) {
      name.setAttribute('aria-invalid', 'true'); name.focus();
      return show(t('apply.err.name'), 'err');
    }
    if (!/^\+254[0-9]{9}$/.test(phoneValue)) {
      phone.setAttribute('aria-invalid', 'true'); phone.focus();
      return show(t('apply.err.phone'), 'err');
    }
    if (email.value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim())) {
      email.setAttribute('aria-invalid', 'true'); email.focus();
      return show(t('apply.err.email'), 'err');
    }
    if (!consent.checked) {
      return show(t('apply.err.consent'), 'err');
    }

    submit.disabled = true;
    const original = submit.textContent;
    submit.textContent = t('apply.sending');

    try {
      const res = await fetch('/api/drivers/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: name.value.trim(),
          phone: phoneValue,
          email: email.value.trim() || undefined,
          city: document.getElementById('ap-city').value.trim() || undefined,
          vehicleType: document.getElementById('ap-type').value,
          consent: true,
          website: document.getElementById('ap-website').value,
        }),
      });

      if (res.status === 429) return show(t('apply.err.rate'), 'err');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        return show(Array.isArray(body.message) ? body.message.join(', ')
                                                : (body.message || t('apply.err.generic')), 'err');
      }

      form.querySelectorAll('input').forEach((el) => {
        if (el.type === 'checkbox') el.checked = false;
        else if (el.id !== 'ap-phone') el.value = '';
      });
      document.getElementById('ap-phone').value = '+254';
      show(t('apply.done'), 'ok');
    } catch {
      show(t('apply.err.network'), 'err');
    } finally {
      submit.disabled = false;
      submit.textContent = original;
    }
  });
})();
