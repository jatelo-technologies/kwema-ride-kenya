/// Turn-by-turn style route guidance for the rider and driver maps.
///
/// The route comes from the server's /maps/route (the Google key never leaves
/// the server). The client then does the cheap part itself, so the map keeps
/// moving without a billed call per GPS fix:
///
///  * The polyline ahead is trimmed to the vehicle's position as it advances,
///    and the remaining distance and time shrink with it.
///  * A new route is fetched only when it is needed: a new leg starts (to the
///    pickup, then to the drop-off), the vehicle leaves the route (a wrong
///    turn, a diversion), or the estimate has gone stale.
///
/// Requests are spaced out, which keeps well inside the server's per-user
/// rate limit and the Maps bill.

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../network/api_client.dart';

/// Decodes a Google encoded polyline.
List<LatLng> decodePolyline(String encoded) {
  final points = <LatLng>[];
  var index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    var shift = 0, result = 0, b;
    do {
      b = encoded.codeUnitAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < encoded.length);
    lat += (result & 1) != 0 ? ~(result >> 1) : (result >> 1);

    shift = 0;
    result = 0;
    do {
      b = encoded.codeUnitAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < encoded.length);
    lng += (result & 1) != 0 ? ~(result >> 1) : (result >> 1);

    points.add(LatLng(lat / 1e5, lng / 1e5));
  }
  return points;
}

double metresBetween(LatLng a, LatLng b) {
  const r = 6371000.0;
  double rad(double d) => d * math.pi / 180;
  final dLat = rad(b.latitude - a.latitude);
  final dLng = rad(b.longitude - a.longitude);
  final h = math.sin(dLat / 2) * math.sin(dLat / 2) +
      math.cos(rad(a.latitude)) *
          math.cos(rad(b.latitude)) *
          math.sin(dLng / 2) *
          math.sin(dLng / 2);
  return r * 2 * math.atan2(math.sqrt(h), math.sqrt(1 - h));
}

/// Compass bearing from [a] to [b], degrees clockwise from north.
double bearingBetween(LatLng a, LatLng b) {
  double rad(double d) => d * math.pi / 180;
  final dLng = rad(b.longitude - a.longitude);
  final y = math.sin(dLng) * math.cos(rad(b.latitude));
  final x = math.cos(rad(a.latitude)) * math.sin(rad(b.latitude)) -
      math.sin(rad(a.latitude)) * math.cos(rad(b.latitude)) * math.cos(dLng);
  return (math.atan2(y, x) * 180 / math.pi + 360) % 360;
}

class RouteGuideState {
  const RouteGuideState({
    this.points = const [],
    this.distanceM = 0,
    this.durationS = 0,
    this.legKey,
    this.loading = false,
    this.isEstimate = false,
  });

  /// The road still ahead, starting at the vehicle.
  final List<LatLng> points;
  final int distanceM;
  final int durationS;

  /// Which leg this is for ('pickup:<ride>' / 'dropoff:<ride>').
  final String? legKey;
  final bool loading;
  final bool isEstimate;

  bool get hasRoute => points.length >= 2;
}

class RouteGuide extends StateNotifier<RouteGuideState> {
  RouteGuide(this._api) : super(const RouteGuideState());

  final ApiClient _api;

  List<LatLng> _full = const [];
  double _totalDist = 0;
  double _totalDur = 0;
  String? _key;
  DateTime _fetchedAt = DateTime.fromMillisecondsSinceEpoch(0);
  bool _inFlight = false;
  int _cursor = 0;

  static const _offRouteM = 120.0;
  static const _minGap = Duration(seconds: 20);
  static const _maxAge = Duration(minutes: 3);

  /// Call on every position change. Cheap: only the occasional call hits the network.
  Future<void> follow({
    required LatLng origin,
    required LatLng destination,
    required String legKey,
    String category = 'standard',
  }) async {
    final newLeg = legKey != _key;
    final age = DateTime.now().difference(_fetchedAt);

    if (!newLeg && _full.length >= 2) {
      final off = _distanceToRoute(origin);
      _trim(origin);
      final needFresh =
          (off > _offRouteM && age > _minGap) || age > _maxAge;
      if (!needFresh) return;
    } else if (!newLeg && age < _minGap) {
      return; // a route request just failed; do not hammer the server
    }
    if (_inFlight) return;
    _inFlight = true;
    if (newLeg) {
      _key = legKey;
      _full = const [];
      state = RouteGuideState(legKey: legKey, loading: true);
    }

    try {
      final res = await _api.post('/maps/route', {
        'originLat': origin.latitude,
        'originLng': origin.longitude,
        'destLat': destination.latitude,
        'destLng': destination.longitude,
        'category': category,
      });
      if (_key != legKey) return; // the leg changed while we were waiting
      final m = (res as Map).cast<String, dynamic>();
      final pts = decodePolyline(m['polyline']?.toString() ?? '');
      _full = pts.length >= 2 ? pts : [origin, destination];
      _totalDist = (m['distanceMetres'] as num?)?.toDouble() ?? 0;
      _totalDur = ((m['durationInTrafficSeconds'] ?? m['durationSeconds'])
                  as num?)
              ?.toDouble() ??
          0;
      _fetchedAt = DateTime.now();
      _cursor = 0;
      _publish(origin, isEstimate: m['isEstimate'] == true);
    } catch (e) {
      // Keep whatever route is on screen. Guidance is an aid; a failed
      // request must never blank the map or throw into the UI.
      _fetchedAt = DateTime.now();
      if (_full.isEmpty) {
        _full = [origin, destination];
        _totalDist = metresBetween(origin, destination);
        _totalDur = _totalDist / 6.0; // ~22 km/h straight-line fallback
        _publish(origin, isEstimate: true);
      }
      debugPrint('route guide: $e');
    } finally {
      _inFlight = false;
    }
  }

  void clear() {
    _key = null;
    _full = const [];
    _cursor = 0;
    state = const RouteGuideState();
  }

  // -----------------------------------------------------------------

  double _distanceToRoute(LatLng p) {
    if (_full.isEmpty) return 0;
    var best = double.infinity;
    // Search a window ahead of the cursor; the vehicle only moves forward.
    final end = math.min(_full.length, _cursor + 60);
    for (var i = _cursor; i < end; i++) {
      final d = metresBetween(p, _full[i]);
      if (d < best) best = d;
    }
    // Fall back to a full scan if the window found nothing close (a U-turn).
    if (best > _offRouteM) {
      for (var i = 0; i < _full.length; i++) {
        final d = metresBetween(p, _full[i]);
        if (d < best) best = d;
      }
    }
    return best;
  }

  void _trim(LatLng p) {
    var best = double.infinity;
    var idx = _cursor;
    final end = math.min(_full.length, _cursor + 60);
    for (var i = _cursor; i < end; i++) {
      final d = metresBetween(p, _full[i]);
      if (d < best) {
        best = d;
        idx = i;
      }
    }
    if (best <= _offRouteM) {
      _cursor = idx;
      _publish(p);
    } else {
      // Off route: still show the remaining line from the vehicle; a fresh
      // route replaces it as soon as the spacing rule allows.
      _publish(p);
    }
  }

  void _publish(LatLng p, {bool? isEstimate}) {
    if (_full.length < 2) return;
    final ahead = <LatLng>[p, ..._full.sublist(math.min(_cursor + 1, _full.length - 1))];
    var remaining = 0.0;
    for (var i = 1; i < ahead.length; i++) {
      remaining += metresBetween(ahead[i - 1], ahead[i]);
    }
    final share = _totalDist <= 0 ? 0.0 : (remaining / _totalDist).clamp(0.0, 1.0);
    state = RouteGuideState(
      points: ahead,
      distanceM: remaining.round(),
      durationS: (_totalDur * share).round(),
      legKey: _key,
      isEstimate: isEstimate ?? state.isEstimate,
    );
  }
}

final driverRouteGuideProvider =
    StateNotifierProvider<RouteGuide, RouteGuideState>(
        (ref) => RouteGuide(ref.watch(apiClientProvider)));

final riderRouteGuideProvider =
    StateNotifierProvider<RouteGuide, RouteGuideState>(
        (ref) => RouteGuide(ref.watch(apiClientProvider)));

/// Hands the destination to Google Maps for full voice navigation. The
/// in-app line is a guide; some drivers want spoken turns.
Future<void> openExternalNavigation(LatLng to) async {
  final uri = Uri.parse(
      'https://www.google.com/maps/dir/?api=1&destination=${to.latitude},${to.longitude}&travelmode=driving');
  try {
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  } catch (e) {
    debugPrint('navigation launch failed: $e');
  }
}
