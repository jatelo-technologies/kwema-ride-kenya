/// Rider state: destination search, quoting, requesting, live tracking.

import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import '../../core/models/models.dart';
import '../../core/notify/trip_notifier.dart';
import '../../core/network/api_client.dart';
import '../../core/network/session_store.dart';
import '../../core/network/socket_client.dart';
import '../../core/country_config.dart';

class RiderState {
  const RiderState({
    this.pickup,
    this.dropoff,
    this.pickupLabel,
    this.dropoffLabel,
    this.quotes = const [],
    this.selected,
    this.rides = const {},
    this.focusId,
    this.driverPositions = const {},
    this.suggestions = const [],
    this.isQuoting = false,
    this.isRequesting = false,
    this.errorKey,
    this.paymentMethod = 'cash',
    this.service = ServiceType.ride,
    this.delivery,
    this.poolMode = 'off',
    this.poolTrips = const [],
    this.isBrowsingPool = false,
    this.myPosition,
    this.locationGranted = false,
    this.composing = false,
    this.forOther = false,
    this.passengerName = '',
    this.passengerPhone = '',
    this.pickupSuggestions = const [],
    this.pickingPickup = false,
    this.pickupChosen = false,
  });

  final LatLng? pickup;
  final LatLng? dropoff;
  final String? pickupLabel;
  final String? dropoffLabel;
  final List<FareQuote> quotes;
  final FareQuote? selected;

  /// Every ride this rider has open (plus recently finished ones still on
  /// screen), keyed by ride id. A rider can have several at once: their own
  /// and rides booked for other people.
  final Map<String, Ride> rides;

  /// The ride shown in the panel and followed by the camera.
  final String? focusId;

  /// Where each ride's driver is right now.
  final Map<String, LatLng> driverPositions;
  final List<PlaceSuggestion> suggestions;
  final bool isQuoting;
  final bool isRequesting;
  final String? errorKey;
  final String paymentMethod;
  final ServiceType service;

  /// Set for parcel and food, null for a ride.
  final DeliveryDetails? delivery;

  /// Car pooling: 'off' rides alone, 'match' looks for a car already going
  /// this way, 'host' starts a shared trip others can join.
  final String poolMode;

  /// Shared trips going this rider's way, for the browse list.
  final List<PoolTrip> poolTrips;
  final bool isBrowsingPool;

  /// The rider's own live position, updated as they move.
  final LatLng? myPosition;

  /// True once the OS has granted location. The map is rebuilt when this
  /// flips, because Google's blue dot is only switched on at map creation.
  final bool locationGranted;

  /// True while the rider is setting up another ride on top of ones in
  /// progress.
  final bool composing;

  /// Booking for someone else.
  final bool forOther;
  final String passengerName;
  final String passengerPhone;

  /// Autocomplete results for the passenger's pickup (rides for someone else).
  final List<PlaceSuggestion> pickupSuggestions;

  /// True while the rider is placing the pickup by tapping the map.
  final bool pickingPickup;

  /// True once the rider has set the pickup themselves (search, pin or drag).
  /// A ride for someone else needs this: it must not silently use the
  /// rider's own location.
  final bool pickupChosen;

  Ride? get ride => focusId == null ? null : rides[focusId];
  LatLng? get driverPosition =>
      focusId == null ? null : driverPositions[focusId];

  /// Rides still in progress, oldest first.
  List<Ride> get activeRides =>
      rides.values.where((r) => !r.status.isTerminal).toList();

  /// An active ride of the rider's own in the service being booked. The
  /// server allows only one of these, so another booking must be for someone
  /// else.
  bool get hasOwnActive => rides.values.any((r) =>
      !r.status.isTerminal && !r.forOther && r.serviceType == service);

  bool get mustBookForOther => hasOwnActive;

  /// True when this booking will be for another person.
  bool get bookingForOther => forOther || mustBookForOther;

  /// A passenger's pickup has to be chosen (not taken from the rider's GPS).
  /// Deliveries have their own pickup/dropoff form.
  bool get pickupIsPassengers => bookingForOther && !service.isDelivery;

  /// True when the selected tier offers a shared price for this trip.
  bool get canPool =>
      service == ServiceType.ride && selected?.poolPreview != null;

  bool get isPooling => canPool && poolMode != 'off';

  bool get canRequest =>
      pickup != null &&
      dropoff != null &&
      selected != null &&
      // A delivery needs a named recipient before it can be dispatched;
      // there is nobody to hand it to otherwise.
      (!service.isDelivery || delivery != null) &&
      // Booking for someone else needs their name so the driver knows who
      // to look for.
      (!bookingForOther ||
          (passengerName.trim().length >= 2 &&
              (pickupChosen || service.isDelivery)));

  /// The tracking panel is shown for the focused ride unless the rider is
  /// setting up another one.
  bool get hasActiveRide => ride != null && !composing;

  RiderState copyWith({
    LatLng? pickup, LatLng? dropoff, String? pickupLabel, String? dropoffLabel,
    List<FareQuote>? quotes, FareQuote? selected,
    Map<String, Ride>? rides, String? focusId,
    Map<String, LatLng>? driverPositions, List<PlaceSuggestion>? suggestions,
    bool? isQuoting, bool? isRequesting, String? errorKey, String? paymentMethod,
    ServiceType? service, DeliveryDetails? delivery,
    String? poolMode, List<PoolTrip>? poolTrips, bool? isBrowsingPool,
    LatLng? myPosition, bool? locationGranted, bool? composing,
    bool? forOther, String? passengerName, String? passengerPhone,
    List<PlaceSuggestion>? pickupSuggestions, bool? pickingPickup,
    bool? pickupChosen, bool clearPickup = false,
    bool clearFocus = false, bool clearError = false, bool clearDelivery = false,
    bool clearDropoff = false,
  }) => RiderState(
        pickup: clearPickup ? null : (pickup ?? this.pickup),
        dropoff: clearDropoff ? null : (dropoff ?? this.dropoff),
        pickupLabel: clearPickup ? null : (pickupLabel ?? this.pickupLabel),
        dropoffLabel: clearDropoff ? null : (dropoffLabel ?? this.dropoffLabel),
        quotes: quotes ?? this.quotes,
        selected: selected ?? this.selected,
        rides: rides ?? this.rides,
        focusId: clearFocus ? null : (focusId ?? this.focusId),
        driverPositions: driverPositions ?? this.driverPositions,
        suggestions: suggestions ?? this.suggestions,
        isQuoting: isQuoting ?? this.isQuoting,
        isRequesting: isRequesting ?? this.isRequesting,
        errorKey: clearError ? null : (errorKey ?? this.errorKey),
        paymentMethod: paymentMethod ?? this.paymentMethod,
        service: service ?? this.service,
        delivery: clearDelivery ? null : (delivery ?? this.delivery),
        poolMode: poolMode ?? this.poolMode,
        poolTrips: poolTrips ?? this.poolTrips,
        isBrowsingPool: isBrowsingPool ?? this.isBrowsingPool,
        myPosition: myPosition ?? this.myPosition,
        locationGranted: locationGranted ?? this.locationGranted,
        composing: composing ?? this.composing,
        forOther: forOther ?? this.forOther,
        passengerName: passengerName ?? this.passengerName,
        passengerPhone: passengerPhone ?? this.passengerPhone,
        pickupSuggestions: pickupSuggestions ?? this.pickupSuggestions,
        pickingPickup: pickingPickup ?? this.pickingPickup,
        pickupChosen: pickupChosen ?? this.pickupChosen,
      );
}

class RiderController extends StateNotifier<RiderState> {
  RiderController(this._api, this._socket) : super(const RiderState()) {
    _listen();
    unawaited(TripNotifier.instance.init());
    unawaited(_socket.connect());
    unawaited(locateMe());
    unawaited(refreshTracking());
    // Safety net behind the live socket: the panel is rebuilt from the server
    // every few seconds while a ride is open, so a missed event can never
    // leave the rider looking at "searching" after a driver has accepted.
    _poll = Timer.periodic(const Duration(seconds: 6), (_) {
      if (state.activeRides.isNotEmpty) unawaited(refreshTracking());
    });
  }

  final ApiClient _api;
  final SocketClient _socket;
  final List<StreamSubscription<dynamic>> _subs = [];
  Timer? _poll;
  StreamSubscription<Position>? _posSub;
  bool _pickupChosenByRider = false;

  /// Notifications already sent, so a poll that repeats a status does not
  /// buzz the phone twice. Key: `<rideId>:<status>`.
  final Set<String> _announced = {};

  /// Places session token. Google bills autocomplete per session rather than
  /// per keystroke when this is supplied, and a rider typing "Mlimani"
  /// generates seven requests.
  String _placesSession = DateTime.now().millisecondsSinceEpoch.toString();

  Timer? _debounce;

  /// Rides the rider has closed on this device. The server keeps listing a
  /// finished ride for half an hour, so without this the next poll would put
  /// it straight back on screen and the rider would be stuck looking at it.
  final Set<String> _dismissed = {};

  // -----------------------------------------------------------------
  // Ride bookkeeping
  // -----------------------------------------------------------------

  /// Adds or replaces a ride. The newest ride takes focus when [focus] is
  /// set; otherwise focus only moves if nothing is focused.
  void _put(Ride ride, {bool focus = false}) {
    final next = Map<String, Ride>.of(state.rides)..[ride.id] = ride;
    state = state.copyWith(
      rides: next,
      focusId: (focus || state.focusId == null || !next.containsKey(state.focusId))
          ? ride.id
          : state.focusId,
    );
  }

  /// Brings another ride into the panel.
  void focusRide(String id) {
    if (!state.rides.containsKey(id)) return;
    state = state.copyWith(focusId: id, composing: false);
  }

  /// Removes a ride from the screen and moves focus to another open one.
  void _drop(String id) {
    _dismissed.add(id);
    final next = Map<String, Ride>.of(state.rides)..remove(id);
    final pos = Map<String, LatLng>.of(state.driverPositions)..remove(id);
    String? focus = state.focusId == id ? null : state.focusId;
    if (focus == null) {
      for (final r in next.values) {
        if (!r.status.isTerminal) {
          focus = r.id;
          break;
        }
      }
    }
    if (focus == null && next.isNotEmpty) focus = next.keys.first;
    state = RiderState(
      pickup: state.pickup, dropoff: state.dropoff,
      pickupLabel: state.pickupLabel, dropoffLabel: state.dropoffLabel,
      quotes: state.quotes, selected: state.selected,
      rides: next, focusId: focus, driverPositions: pos,
      suggestions: state.suggestions, isQuoting: state.isQuoting,
      isRequesting: state.isRequesting, errorKey: state.errorKey,
      paymentMethod: state.paymentMethod, service: state.service,
      delivery: state.delivery, poolMode: state.poolMode,
      poolTrips: state.poolTrips, isBrowsingPool: state.isBrowsingPool,
      myPosition: state.myPosition, locationGranted: state.locationGranted,
      composing: state.composing, forOther: state.forOther,
      passengerName: state.passengerName, passengerPhone: state.passengerPhone,
      pickupSuggestions: state.pickupSuggestions,
      pickingPickup: state.pickingPickup, pickupChosen: state.pickupChosen,
    );
  }

  String _who(Ride r) => r.forOther ? ' (${r.passengerName})' : '';

  /// One alert per ride per status, whatever path the news arrived by.
  void _announce(Ride before, Ride after) {
    final key = '${after.id}:${after.status.name}';
    if (_announced.contains(key)) return;
    final vehicle = after.vehicle == null
        ? ''
        : '${after.vehicle!.colour} ${after.vehicle!.make} ${after.vehicle!.model}'
            ' · ${after.vehicle!.plate}';
    final name = after.driver?.name ?? '';
    switch (after.status) {
      case RideStatus.accepted:
        _announced.add(key);
        TripNotifier.instance.alert(
          id: after.id.hashCode & 0x3fffffff,
          title: 'Dereva amepatikana · Driver found${_who(after)}',
          body: '$name — $vehicle'.trim(),
        );
      case RideStatus.arrived:
        _announced.add(key);
        TripNotifier.instance.alert(
          id: (after.id.hashCode + 1) & 0x3fffffff,
          title: 'Dereva wako amefika · Your driver has arrived${_who(after)}',
          body: '$name — $vehicle'.trim(),
        );
      case RideStatus.inProgress:
        _announced.add(key);
        TripNotifier.instance.alert(
          id: (after.id.hashCode + 2) & 0x3fffffff,
          title: 'Safari imeanza · Trip started${_who(after)}',
          body: after.dropoffAddress ?? '',
        );
      case RideStatus.completed:
        _announced.add(key);
        TripNotifier.instance.alert(
          id: (after.id.hashCode + 3) & 0x3fffffff,
          title: 'Safari imekamilika · Trip complete${_who(after)}',
          body: '',
        );
      default:
        break;
    }
  }

  /// Applies a status change to one ride and alerts the rider.
  void _applyStatus(Ride current, Map<String, dynamic> data) {
    final status = data['status']?.toString();
    if (status == null) return;
    final updated = current.copyWith(
      status: RideStatus.fromWire(status),
      driver: data['driver'] is Map
          ? DriverProfile.fromJson(
              (data['driver'] as Map).cast<String, dynamic>())
          : null,
      vehicle: data['vehicle'] is Map
          ? VehicleInfo.fromJson(
              (data['vehicle'] as Map).cast<String, dynamic>())
          : null,
      etaSeconds: (data['etaSeconds'] as num?)?.toInt(),
      finalFareCents: (data['fareCents'] as num?)?.toInt(),
    );
    _put(updated);
    _announce(current, updated);
    state = state.copyWith(isRequesting: false);
    // The accepted event carries the driver; if it ever arrives without one
    // (a reconnect mid-flight), fetch the full picture straight away.
    if (updated.driver == null &&
        (updated.status == RideStatus.accepted ||
            updated.status == RideStatus.arrived ||
            updated.status == RideStatus.inProgress)) {
      unawaited(refreshTracking());
    }
  }

  /// Rebuilds every open ride from the server. Used at start-up, on a timer
  /// while rides are open, after a reconnect and when the app returns to the
  /// front.
  Future<void> refreshTracking() async {
    try {
      final res = await _api.get('/rides/tracking');
      if (res is! List) return;
      final seen = <String>{};
      for (final raw in res) {
        final j = (raw as Map).cast<String, dynamic>();
        final fresh = Ride.fromJson(j);
        if (fresh.id.isEmpty) continue;
        seen.add(fresh.id);
        // Closed on this device: only an open ride may come back (it was never
        // really closed, e.g. cancelled by mistake elsewhere).
        if (_dismissed.contains(fresh.id)) {
          if (fresh.status.isTerminal) continue;
          _dismissed.remove(fresh.id);
        }
        final old = state.rides[fresh.id];
        final merged = old == null
            ? fresh
            : fresh.copyWith(
                deliveryCode: old.deliveryCode,
                poolCoRiders: old.poolCoRiders,
                poolDiscountCents: old.poolDiscountCents,
                poolSharedWith: old.poolSharedWith,
                isPaid: old.isPaid || fresh.isPaid,
                etaSeconds: old.etaSeconds,
                finalFareCents: fresh.finalFareCents ?? old.finalFareCents,
              );
        // A ride discovered on a restart has not been announced as news.
        if (old == null) {
          _announced.add('${merged.id}:${merged.status.name}');
        }
        _put(merged);
        if (old != null) _announce(old, merged);

        final dp = j['driverPosition'];
        if (dp is Map && dp['lat'] is num && dp['lng'] is num &&
            !merged.status.isTerminal) {
          final pos = Map<String, LatLng>.of(state.driverPositions);
          // The live socket is fresher than a poll; only fill the gap.
          pos.putIfAbsent(merged.id,
              () => LatLng((dp['lat'] as num).toDouble(), (dp['lng'] as num).toDouble()));
          state = state.copyWith(driverPositions: pos);
        }
      }
      // A ride the server no longer lists as open was cancelled or expired
      // somewhere else. Give new rides a grace period before judging them.
      for (final r in state.rides.values.toList()) {
        if (r.status.isTerminal || seen.contains(r.id)) continue;
        final age = DateTime.now().difference(r.createdAt ?? DateTime.now());
        if (age > const Duration(seconds: 25)) {
          _put(r.copyWith(status: RideStatus.expired));
        }
      }
      // Nothing focused yet (fresh start): show the first open ride.
      if (state.focusId == null && state.rides.isNotEmpty) {
        final open = state.activeRides;
        state = state.copyWith(
            focusId: (open.isNotEmpty ? open.first : state.rides.values.first).id);
      }
    } catch (_) {
      // Offline: the socket and the next poll will catch up.
    }
  }

  void _listen() {
    _subs.add(_socket.rideStatus.listen((data) {
      final status = data['status']?.toString();

      // `ride:fare_ready` carries the settled fare and, for a shared ride,
      // what sharing saved. It has no status, so it is handled before the
      // status check below.
      if (status == null && data.containsKey('poolDiscountCents')) {
        final current = state.rides[data['rideId']?.toString()];
        if (current != null) {
          _put(current.copyWith(
            finalFareCents: (data['fareCents'] as num?)?.toInt(),
            poolDiscountCents: (data['poolDiscountCents'] as num?)?.toInt(),
            poolSharedWith: (data['poolSharedWith'] as num?)?.toInt(),
          ));
        }
        return;
      }
      if (status == null) return;

      final id = data['rideId']?.toString();
      final current = id == null ? state.ride : state.rides[id];
      if (current == null) {
        // A ride this device has not met yet (started on the web, say).
        if (id != null && id.isNotEmpty) unawaited(refreshTracking());
        return;
      }
      _applyStatus(current, data);
    }));

    _subs.add(_socket.connection.listen((connected) {
      if (connected) unawaited(refreshTracking());
    }));

    _subs.add(_socket.poolUpdates.listen((data) {
      final current = state.rides[data['rideId']?.toString()];
      if (current == null) return;
      _put(current.copyWith(
          poolCoRiders: (data['coRiders'] as num?)?.toInt() ?? 0));
    }));

    _subs.add(_socket.driverMoved.listen((data) {
      final la = data['la'], ln = data['ln'];
      if (la is! num || ln is! num) return;
      // `rid` says which ride this driver is on; older servers omit it and
      // then the focused ride is the only sensible owner.
      final id = data['rid']?.toString() ?? state.focusId;
      if (id == null) return;
      final pos = Map<String, LatLng>.of(state.driverPositions)
        ..[id] = LatLng(la / 1e6, ln / 1e6);
      state = state.copyWith(driverPositions: pos);
    }));

    _subs.add(_socket.payments.listen((data) {
      if (data['status'] == 'success' && state.ride != null) {
        _put(state.ride!.copyWith(isPaid: true));
      }
    }));
  }

  // -----------------------------------------------------------------
  // The rider's own position
  // -----------------------------------------------------------------

  Future<void> locateMe() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        state = state.copyWith(errorKey: 'error.gps_off');
        return;
      }
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        state = state.copyWith(errorKey: 'error.location_denied');
        return;
      }
      state = state.copyWith(locationGranted: true, clearError: true);
      _watchPosition();

      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
            accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 12)),
      );
      _onFix(pos, first: true);

      // Reverse geocode is a hint only. Large parts of many cities have no street
      // addresses in Google's data, so this often returns something as broad
      // as "Kinondoni" — useful to show, not to rely on.
      final res = await _api.get('/maps/reverse-geocode',
          query: {'lat': pos.latitude, 'lng': pos.longitude});
      final address = (res as Map)['address']?.toString();
      if (address != null && !_pickupChosenByRider) {
        state = state.copyWith(pickupLabel: address);
      }
    } catch (_) {
      // A missing pickup label is survivable; the map marker still works.
    }
  }

  /// Follows the rider as they walk or ride, so the map shows where they are
  /// now rather than where they were when the app opened.
  void _watchPosition() {
    if (_posSub != null) return;
    _posSub = Geolocator.getPositionStream(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: 4,
      ),
    ).listen(_onFix, onError: (Object e) {
      debugPrint('rider location stream error: $e');
    });
  }

  void _onFix(Position pos, {bool first = false}) {
    if (pos.accuracy > 150 && !first) return;
    final point = LatLng(pos.latitude, pos.longitude);
    // The pickup follows the rider until they choose one themselves or have
    // picked a destination (moving it then would silently re-price the trip).
    // A ride for someone else never follows the rider: its pickup is wherever
    // that person is.
    final followPickup = !_pickupChosenByRider &&
        state.dropoff == null &&
        !state.pickupIsPassengers;
    state = state.copyWith(
      myPosition: point,
      pickup: followPickup ? point : null,
      clearError: first,
    );
  }

  /// Asks for location again after the rider enabled it in settings.
  Future<void> retryLocation() => locateMe();

  void searchPlaces(String input) {
    _debounce?.cancel();
    if (input.trim().length < 2) {
      state = state.copyWith(suggestions: const []);
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 350), () async {
      try {
        final res = await _api.post('/maps/autocomplete', {
          'input': input,
          'sessionToken': _placesSession,
          if (state.pickup != null) 'lat': state.pickup!.latitude,
          if (state.pickup != null) 'lng': state.pickup!.longitude,
        });
        final list = (res as List)
            .map((e) => PlaceSuggestion.fromJson(
                (e as Map).cast<String, dynamic>()))
            .toList();
        state = state.copyWith(suggestions: list);
      } catch (_) {
        state = state.copyWith(suggestions: const []);
      }
    });
  }

  Future<void> chooseDestination(PlaceSuggestion suggestion) async {
    try {
      final res = await _api.get('/maps/place', query: {
        'placeId': suggestion.placeId,
        'sessionToken': _placesSession,
      });
      final map = (res as Map).cast<String, dynamic>();
      final point = (map['point'] as Map).cast<String, dynamic>();

      state = state.copyWith(
        dropoff: LatLng((point['lat'] as num).toDouble(),
            (point['lng'] as num).toDouble()),
        dropoffLabel: suggestion.primary,
        suggestions: const [],
      );

      // A new session token per completed selection: that is what closes the
      // billing session on Google's side.
      _placesSession = DateTime.now().millisecondsSinceEpoch.toString();
      await refreshQuote();
    } catch (_) {
      state = state.copyWith(errorKey: 'error.network');
    }
  }

  void setPickup(LatLng point) {
    _pickupChosenByRider = true;
    state = state.copyWith(pickup: point, pickupChosen: true);
  }

  /// Back to following the rider's own position.
  void useMyLocationAsPickup() {
    _pickupChosenByRider = false;
    final me = state.myPosition;
    state = state.copyWith(
      pickup: me,
      pickupChosen: false,
      pickingPickup: false,
      pickupSuggestions: const [],
    );
    if (me != null) unawaited(_labelPickup(me));
    if (state.dropoff != null) unawaited(refreshQuote());
  }

  Timer? _pickupDebounce;

  /// Autocomplete for the passenger's pickup, biased to where the rider is.
  void searchPickupPlaces(String input) {
    _pickupDebounce?.cancel();
    if (input.trim().length < 2) {
      state = state.copyWith(pickupSuggestions: const []);
      return;
    }
    _pickupDebounce = Timer(const Duration(milliseconds: 350), () async {
      try {
        final bias = state.myPosition ?? state.pickup;
        final res = await _api.post('/maps/autocomplete', {
          'input': input,
          'sessionToken': _placesSession,
          if (bias != null) 'lat': bias.latitude,
          if (bias != null) 'lng': bias.longitude,
        });
        final list = (res as List)
            .map((e) =>
                PlaceSuggestion.fromJson((e as Map).cast<String, dynamic>()))
            .toList();
        state = state.copyWith(pickupSuggestions: list);
      } catch (_) {
        state = state.copyWith(pickupSuggestions: const []);
      }
    });
  }

  /// The rider picked a place for the passenger's pickup from the list.
  Future<void> choosePickupSuggestion(PlaceSuggestion suggestion) async {
    try {
      final res = await _api.get('/maps/place', query: {
        'placeId': suggestion.placeId,
        'sessionToken': _placesSession,
      });
      final point =
          ((res as Map).cast<String, dynamic>()['point'] as Map).cast<String, dynamic>();
      _placesSession = DateTime.now().millisecondsSinceEpoch.toString();
      _pickupChosenByRider = true;
      state = state.copyWith(
        pickup: LatLng((point['lat'] as num).toDouble(),
            (point['lng'] as num).toDouble()),
        pickupLabel: suggestion.primary,
        pickupChosen: true,
        pickingPickup: false,
        pickupSuggestions: const [],
      );
      if (state.dropoff != null) await refreshQuote();
    } catch (_) {
      state = state.copyWith(errorKey: 'error.network');
    }
  }

  /// Turns map-tapping on or off for placing the pickup.
  void setPickingPickup(bool on) =>
      state = state.copyWith(pickingPickup: on, pickupSuggestions: const []);

  /// The rider tapped the map, or dragged the pickup pin, to say where the
  /// passenger is.
  Future<void> pinPickup(LatLng point) async {
    _pickupChosenByRider = true;
    state = state.copyWith(
      pickup: point,
      pickupLabel: 'Pin',
      pickupChosen: true,
      pickingPickup: false,
      pickupSuggestions: const [],
    );
    await _labelPickup(point, onlyIfStillHere: true);
    if (state.dropoff != null) await refreshQuote();
  }

  /// Reverse geocode is a hint for the label; the point itself is what counts.
  Future<void> _labelPickup(LatLng point, {bool onlyIfStillHere = false}) async {
    try {
      final res = await _api.get('/maps/reverse-geocode',
          query: {'lat': point.latitude, 'lng': point.longitude});
      final address = (res as Map)['address']?.toString();
      if (address == null) return;
      if (onlyIfStillHere && state.pickup != point) return;
      state = state.copyWith(pickupLabel: address);
    } catch (_) {}
  }

  // --- Booking more than one ride -----------------------------------

  /// Opens the booking panel on top of rides already in progress.
  void startAnotherRide() {
    state = state.copyWith(
      composing: true,
      clearDropoff: true,
      quotes: const [],
      poolMode: 'off',
      clearDelivery: true,
      clearError: true,
      pickingPickup: false,
      pickupSuggestions: const [],
    );
    // A second ride at the same time is for someone else; their pickup is
    // chosen, not assumed.
    if (state.pickupIsPassengers) {
      _pickupChosenByRider = false;
      state = state.copyWith(clearPickup: true, pickupChosen: false);
    } else {
      useMyLocationAsPickup();
    }
  }

  /// Leaves the booking panel and goes back to the rides in progress.
  void backToRides() => state = state.copyWith(composing: false);

  /// Switching to a ride for someone else clears the pickup: it must be
  /// where that person is, not where the rider happens to be.
  void setForOther(bool value) {
    state = state.copyWith(forOther: value);
    if (value) {
      _pickupChosenByRider = false;
      state = state.copyWith(
          clearPickup: true, pickupChosen: false, quotes: const []);
    } else if (!state.mustBookForOther) {
      useMyLocationAsPickup();
    }
  }

  void setPassenger({String? name, String? phone}) => state = state.copyWith(
      passengerName: name ?? state.passengerName,
      passengerPhone: phone ?? state.passengerPhone);

  void selectCategory(VehicleCategory category) {
    final match = state.quotes.where((q) => q.category == category);
    if (match.isNotEmpty) state = state.copyWith(selected: match.first);
  }

  void setPaymentMethod(String method) =>
      state = state.copyWith(paymentMethod: method);

  /// Switching product re-quotes, because each has its own rate card and the
  /// available vehicle tiers differ.
  Future<void> setService(ServiceType service) async {
    if (service == state.service) return;
    state = state.copyWith(
      service: service,
      quotes: const [],
      poolMode: 'off',
      poolTrips: const [],
      clearDelivery: service == ServiceType.ride,
    );
    await refreshQuote();
  }

  void setPoolMode(String mode) {
    state = state.copyWith(poolMode: mode, poolTrips: const []);
  }

  /// Shared trips going this rider's way, least detour first.
  Future<void> loadPoolTrips() async {
    final quote = state.selected;
    if (quote == null || state.pickup == null || state.dropoff == null) return;
    state = state.copyWith(isBrowsingPool: true, clearError: true);
    try {
      final res = await _api.get('/pool/trips', query: {
        'category': quote.category.wire,
        'pickupLat': state.pickup!.latitude,
        'pickupLng': state.pickup!.longitude,
        'dropoffLat': state.dropoff!.latitude,
        'dropoffLng': state.dropoff!.longitude,
      });
      final trips = ((res as Map)['trips'] as List)
          .map((e) => PoolTrip.fromJson((e as Map).cast<String, dynamic>()))
          .toList();
      state = state.copyWith(poolTrips: trips, isBrowsingPool: false);
    } on ApiException catch (e) {
      state = state.copyWith(isBrowsingPool: false, errorKey: e.message);
    }
  }

  /// Joins a shared trip from the browse list. Same quote, payment and
  /// receipt as any other ride; the server decides whether the seat is still
  /// there and asks the driver if the car is already on the road.
  Future<void> joinPoolTrip(PoolTrip trip) async {
    final quote = state.selected;
    if (quote == null || state.pickup == null || state.dropoff == null) return;
    if (quote.isExpired) {
      await refreshQuote();
      state = state.copyWith(errorKey: 'error.quote_expired');
      return;
    }
    state = state.copyWith(isRequesting: true, clearError: true);
    try {
      final res = await _api.post('/pool/trips/${trip.tripId}/join', {
        'clientGeneratedId': _uuid(),
        'quoteId': quote.quoteId,
        'category': quote.category.wire,
        'paymentMethod': state.paymentMethod,
        'pickup': {
          'lat': state.pickup!.latitude,
          'lng': state.pickup!.longitude,
          'address': state.pickupLabel,
        },
        'dropoff': {
          'lat': state.dropoff!.latitude,
          'lng': state.dropoff!.longitude,
          'address': state.dropoffLabel,
        },
      });
      _afterRequested(Ride.fromJson((res as Map).cast<String, dynamic>()).copyWith(
        pickupLatLng: state.pickup,
        dropoffLatLng: state.dropoff,
        pickupAddress: state.pickupLabel,
        dropoffAddress: state.dropoffLabel,
      ));
    } on ApiException catch (e) {
      state = state.copyWith(
          isRequesting: false,
          errorKey: e.message == 'trip_not_joinable'
              ? 'pool.gone'
              : e.message);
      await loadPoolTrips();
    }
  }

  void setDelivery(DeliveryDetails details) =>
      state = state.copyWith(delivery: details);

  Future<void> refreshQuote() async {
    if (state.pickup == null || state.dropoff == null) return;
    state = state.copyWith(isQuoting: true, clearError: true);

    try {
      final res = await _api.post('/pricing/quote', {
        'serviceType': state.service.wire,
        'pickupLat': state.pickup!.latitude,
        'pickupLng': state.pickup!.longitude,
        'dropoffLat': state.dropoff!.latitude,
        'dropoffLng': state.dropoff!.longitude,
        if (state.service == ServiceType.ride) 'pool': true,
      });
      final quotes = ((res as Map)['quotes'] as List)
          .map((e) => FareQuote.fromJson((e as Map).cast<String, dynamic>()))
          .toList();

      final keep = state.selected == null
          ? null
          : quotes.where((q) => q.category == state.selected!.category);

      state = state.copyWith(
        quotes: quotes,
        selected: (keep != null && keep.isNotEmpty)
            ? keep.first
            : quotes.where((q) => q.category == VehicleCategory.standard)
                .followedBy(quotes).first,
        isQuoting: false,
      );
    } on ApiException catch (e) {
      state = state.copyWith(isQuoting: false, errorKey: e.message);
    }
  }

  Future<void> requestRide() async {
    final quote = state.selected;
    if (quote == null || state.pickup == null || state.dropoff == null) return;

    // A stale quote is refused by the server, so re-quote rather than send it.
    if (quote.isExpired) {
      await refreshQuote();
      state = state.copyWith(errorKey: 'error.quote_expired');
      return;
    }

    state = state.copyWith(isRequesting: true, clearError: true);
    try {
      final res = await _api.post('/rides/request', {
        // Idempotency key: a retry after a dropped ack returns the same ride
        // rather than creating a second one.
        'clientGeneratedId': _uuid(),
        'serviceType': state.service.wire,
        if (state.delivery != null) 'delivery': state.delivery!.toJson(),
        'quoteId': quote.quoteId,
        'category': quote.category.wire,
        'paymentMethod': state.paymentMethod,
        if (state.isPooling) 'poolMode': state.poolMode,
        if (state.bookingForOther && !state.service.isDelivery) ...{
          'passengerName': state.passengerName.trim(),
          if (state.passengerPhone.trim().isNotEmpty)
            'passengerPhone': state.passengerPhone.trim(),
        },
        'pickup': {
          'lat': state.pickup!.latitude,
          'lng': state.pickup!.longitude,
          'address': state.pickupLabel,
        },
        'dropoff': {
          'lat': state.dropoff!.latitude,
          'lng': state.dropoff!.longitude,
          'address': state.dropoffLabel,
        },
      });
      var ride = Ride.fromJson((res as Map).cast<String, dynamic>());
      ride = ride.copyWith(
        passengerName: state.bookingForOther && !state.service.isDelivery
            ? state.passengerName.trim()
            : null,
        pickupLatLng: state.pickup,
        dropoffLatLng: state.dropoff,
        pickupAddress: state.pickupLabel,
        dropoffAddress: state.dropoffLabel,
      );
      _afterRequested(ride);
    } on ApiException catch (e) {
      state = state.copyWith(isRequesting: false, errorKey: e.message);
    }
  }

  /// A ride was created: show it, and clear the booking form so the next
  /// ride starts from a clean slate. The rider can book again immediately.
  void _afterRequested(Ride ride) {
    _announced.add('${ride.id}:${ride.status.name}');
    _put(ride, focus: true);
    state = state.copyWith(
      isRequesting: false,
      composing: false,
      clearDropoff: true,
      quotes: const [],
      poolMode: 'off',
      clearDelivery: true,
      forOther: false,
      passengerName: '',
      passengerPhone: '',
      pickupChosen: false,
      pickingPickup: false,
      pickupSuggestions: const [],
    );
    _pickupChosenByRider = false;
    final me = state.myPosition;
    if (me != null) state = state.copyWith(pickup: me);
    unawaited(refreshTracking());
  }

  Future<void> cancelRide() async {
    final ride = state.ride;
    if (ride == null) return;
    try {
      await _api.post('/rides/${ride.id}/cancel', {});
      _drop(ride.id);
    } on ApiException catch (e) {
      state = state.copyWith(errorKey: e.message);
    }
  }

  Future<String?> payNow({String mno = kDefaultWallet}) async {
    final ride = state.ride;
    if (ride == null) return null;
    try {
      if (state.paymentMethod == 'card') {
        final res = await _api.post('/payments/card/initiate', {'rideId': ride.id});
        // Returns a hosted checkout URL. Card fields are entered on the
        // provider's page in a WebView, never in this app.
        return (res as Map)['checkoutUrl']?.toString();
      }
      await _api.post('/payments/collect', {'rideId': ride.id, 'mno': mno});
      return null;
    } on ApiException catch (e) {
      state = state.copyWith(errorKey: e.message);
      return null;
    }
  }

  /// Closes a finished ride's card. The rider can already book again while
  /// it is open; this only tidies it away.
  void dismissRide() {
    final ride = state.ride;
    if (ride == null) return;
    _drop(ride.id);
    state = state.copyWith(composing: false);
  }

  /// Finished ride: close its card and start a new booking in one tap.
  void requestAnother() {
    final ride = state.ride;
    if (ride != null && ride.status.isTerminal) _drop(ride.id);
    startAnotherRide();
  }

  void clearError() => state = state.copyWith(clearError: true);

  /// RFC 4122 version 4 UUID.
  ///
  /// This must be a real UUID: the server stores it in a `uuid` column as the
  /// idempotency key, and anything else is rejected by Postgres before the
  /// ride is ever created.
  String _uuid() {
    final rnd = Random.secure();
    final bytes = List<int>.generate(16, (_) => rnd.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
        '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
  }

  @override
  void dispose() {
    _poll?.cancel();
    _pickupDebounce?.cancel();
    _posSub?.cancel();
    _debounce?.cancel();
    for (final s in _subs) {
      s.cancel();
    }
    super.dispose();
  }
}

final socketClientProvider = Provider<SocketClient>((ref) {
  final client = SocketClient(
      ref.watch(sessionStoreProvider), ref.watch(apiClientProvider));
  ref.onDispose(client.dispose);
  return client;
});

final riderControllerProvider =
    StateNotifierProvider<RiderController, RiderState>((ref) {
  return RiderController(
    ref.watch(apiClientProvider),
    ref.watch(socketClientProvider),
  );
});
