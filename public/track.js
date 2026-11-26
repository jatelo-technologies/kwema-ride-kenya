/* Kwema Ride — live trip page behind a share link.
 *
 * Anyone with the link sees the trip move, without an account. The token in
 * the URL is the only key. Polls every 5 seconds while the trip is live and
 * stops once it has ended.
 */
(function () {
  const token = new URLSearchParams(location.search).get('t') || '';
  const T = (k) => kwemaT(k) || k;
  const $ = (id) => document.getElementById(id);

  kwemaApplyI18n();

  let map = null, carMarker = null, fitted = false, timer = null;

  function initMap(pickup, dropoff) {
    if (map || !window.L) return;
    map = L.map('tmap', { zoomControl: true, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    const dot = (color) => L.divIcon({
      className: '',
      html: `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)"></div>`,
      iconSize: [16, 16], iconAnchor: [8, 8],
    });
    L.marker([pickup.lat, pickup.lng], { icon: dot('#3A4BB8') }).addTo(map);
    L.marker([dropoff.lat, dropoff.lng], { icon: dot('#E39B1F') }).addTo(map);
    map.fitBounds([[pickup.lat, pickup.lng], [dropoff.lat, dropoff.lng]], { padding: [50, 50] });
  }

  function placeCar(d, pickup, dropoff) {
    if (!map) return;
    const pos = [d.lat, d.lng];
    if (!carMarker) {
      carMarker = L.marker(pos, {
        icon: L.divIcon({
          className: '',
          html: '<div style="width:34px;height:34px;border-radius:50%;background:#1C2557;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;color:#fff;font-size:17px">🚗</div>',
          iconSize: [34, 34], iconAnchor: [17, 17],
        }),
        zIndexOffset: 1000,
      }).addTo(map);
    } else {
      carMarker.setLatLng(pos);
    }
    if (!fitted) {
      map.fitBounds([pos, [pickup.lat, pickup.lng], [dropoff.lat, dropoff.lng]], { padding: [50, 50] });
      fitted = true;
    }
  }

  function statusText(v) {
    const name = v.riderFirstName || T('track.someone');
    switch (v.status) {
      case 'requested':
      case 'searching': return { s: T('track.st.searching'), sub: name };
      case 'accepted': return { s: T('track.st.accepted'), sub: name };
      case 'arrived': return { s: T('track.st.arrived'), sub: name };
      case 'in_progress': return { s: T('track.st.in_progress').replace('{name}', name), sub: '' };
      case 'completed': return { s: T('track.st.completed').replace('{name}', name), sub: '' };
      default: return { s: T('track.st.cancelled'), sub: '' };
    }
  }

  function render(v) {
    const st = statusText(v);
    $('status').textContent = st.s;
    $('sub').textContent = st.sub;
    $('from').textContent = v.pickup.address || '';
    $('to').textContent = v.dropoff.address || '';
    if (v.emergency && v.emergency.primary) {
      $('emg').textContent = v.emergency.primary;
      $('emg').href = 'tel:' + v.emergency.primary;
    }
    if (v.vehicle) {
      $('veh').hidden = false;
      $('driver').textContent = (v.driverFirstName ? v.driverFirstName + ' · ' : '') + T('track.driver');
      $('vdesc').textContent = v.vehicle.description || '';
      $('plate').textContent = v.vehicle.plate;
    }
    initMap(v.pickup, v.dropoff);
    if (v.driver) placeCar(v.driver, v.pickup, v.dropoff);
    else if (carMarker) { map.removeLayer(carMarker); carMarker = null; }

    const live = ['requested', 'searching', 'accepted', 'arrived', 'in_progress'].includes(v.status);
    $('live').classList.toggle('off', !live);
    $('live-t').textContent = live ? T('track.live') : T('track.ended');
    $('upd').textContent = T('track.updated') + ' ' + new Date(v.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (!live && timer) { clearInterval(timer); timer = null; }
  }

  async function poll() {
    try {
      const r = await fetch('/api/share/' + encodeURIComponent(token), { cache: 'no-store' });
      if (r.status === 404) {
        $('body').hidden = true; $('gone').hidden = false;
        $('live').classList.add('off'); $('live-t').textContent = T('track.ended');
        if (timer) { clearInterval(timer); timer = null; }
        return;
      }
      if (!r.ok) return; // transient: try again on the next tick
      render(await r.json());
    } catch (e) { /* offline for a moment — next tick retries */ }
  }

  if (!token) { $('body').hidden = true; $('gone').hidden = false; return; }
  poll();
  timer = setInterval(poll, 5000);
})();
