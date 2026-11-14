/// Driver state: online/offline, offers, trip lifecycle, earnings.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../core/location/offline_location_queue.dart';
import '../../core/models/models.dart';
import '../../core/notify/trip_notifier.dart';
import '../../core/network/api_client.dart';
import '../../core/network/session_store.dart';
import '../../core/network/socket_client.dart';
import '../rider/rider_controller.dart' show socketClientProvider;

class DriverState {
  const DriverState({
    this.isOnline = false,
    this.position,
    this.offer,
    this.activeRide,
    this.otherRides = const [],
    this.tripsToday = 0,
    this.earnedTodayCents = 0,
    this.walletBalanceCents = 0,
    this.debtCeilingCents = 3000000,
    this.isBlocked = false,
    this.busy = false,
    this.errorKey,
    this.locationGranted = false,
    this.arrivalPrompt,
  });

  final bool isOnline;
  final LatLng? position;
  final RideOffer? offer;
  /// The passenger the driver is currently working with.
  final Ride? activeRide;

  /// Other passengers on the same vehicle (shared trips). Empty for a solo
  /// ride, which is the common case.
  final List<Ride> otherRides;
  final int tripsToday;
  final int earnedTodayCents;

  /// Negative means commission owed on cash trips.
  final int walletBalanceCents;
  final int debtCeilingCents;

  /// True when unsettled cash commission has hit the ceiling; dispatch stops
  /// sending offers until it is cleared.
  final bool isBlocked;

  final bool busy;
  final String? errorKey;

  /// True once the OS has granted location; the map is rebuilt when it flips
  /// so Google's blue dot appears (it is only switched on at map creation).
  final bool locationGranted;

  /// `<rideId>:pickup` or `<rideId>:dropoff` while the driver is within
  /// reach of that stop and has not yet confirmed.
  final String? arrivalPrompt;

  /// What the driver should be asked right now: 'pickup', 'dropoff' or null.
  String? get arrivalKind {
    final ride = activeRide;
    final key = arrivalPrompt;
    if (ride == null || key == null) return null;
    if (key == '${ride.id}:pickup' && ride.status == RideStatus.accepted) {
      return 'pickup';
    }
    if (key == '${ride.id}:dropoff' && ride.status == RideStatus.inProgress) {
      return 'dropoff';
    }
    return null;
  }

  int get debtCents => walletBalanceCents < 0 ? -walletBalanceCents : 0;

  DriverState copyWith({
    bool? isOnline, LatLng? position, RideOffer? offer, Ride? activeRide,
    int? tripsToday, int? earnedTodayCents, int? walletBalanceCents,
    int? debtCeilingCents, bool? isBlocked, bool? busy, String? errorKey,
    List<Ride>? otherRides, bool? locationGranted, String? arrivalPrompt,
    bool clearOffer = false, bool clearRide = false, bool clearError = false,
    bool clearArrival = false,
  }) => DriverState(
        locationGranted: locationGranted ?? this.locationGranted,
        arrivalPrompt: clearArrival ? null : (arrivalPrompt ?? this.arrivalPrompt),
        isOnline: isOnline ?? this.isOnline,
        position: position ?? this.position,
        offer: clearOffer ? null : (offer ?? this.offer),
        activeRide: clearRide ? null : (activeRide ?? this.activeRide),
        otherRides: otherRides ?? this.otherRides,
        tripsToday: tripsToday ?? this.tripsToday,
        earnedTodayCents: earnedTodayCents ?? this.earnedTodayCents,
        walletBalanceCents: walletBalanceCents ?? this.walletBalanceCents,
        debtCeilingCents: debtCeilingCents ?? this.debtCeilingCents,
        isBlocked: isBlocked ?? this.isBlocked,
        busy: busy ?? this.busy,
        errorKey: clearError ? null : (errorKey ?? this.errorKey),
      );
}

class DriverController extends StateNotifier<DriverState> {
  DriverController(this._api, this._socket, this._session)
      : super(const DriverState()) {
    _listen();
    unawaited(TripNotifier.instance.init());
    unawaited(_start());
  }

  final ApiClient _api;
  final SocketClient _socket;
  final SessionStore _session;
  final List<StreamSubscription<dynamic>> _subs = [];
  OfflineLocationQueue? _queue;
  StreamSubscription<Position>? _positionSub;

  /// App start: reconnect, pick up any trip in progress, and go back online
  /// by itself if the driver was online when the app last ran.
  Future<void> _start() async {
    await _socket.connect();
    unawaited(refreshWallet());
    await restoreActiveRides();
    if (_session.driverWantsOnline) await goOnline(auto: true);
  }

  void _listen() {
    _subs.add(_socket.offers.listen((data) {
      // ride:offer_closed arrives when another driver won the race.
      if (data.containsKey('reason')) {
        state = state.copyWith(clearOffer: true);
        TripNotifier.instance.cancelOfferAlert();
        return;
      }
      if (data['rideId'] == null) return;
      // One offer at a time. A second one arriving while the first is on
      // screen must not silently swap what the Accept button claims.
      final current = state.offer;
      if (current != null &&
          current.rideId != data['rideId'].toString() &&
          current.expiresAt.isAfter(DateTime.now())) {
        return;
      }
      final offer = RideOffer.fromJson(data);
      state = state.copyWith(offer: offer);
      // Interrupt whatever the driver is doing: screen on, sound, banner.
      TripNotifier.instance.offerAlert(
        title: 'Ombi la safari · New ride request',
        body: '${offer.pickupAddress} → ${offer.dropoffAddress}',
        ttlSeconds: offer.ttlSeconds,
      );
    }));

    // After any reconnect (a tunnel, a dead zone, the app returning from the
    // background) re-sync with the server and push the buffered location
    // fixes straight away rather than waiting for the next timer tick.
    _subs.add(_socket.connection.listen((connected) {
      if (!connected) return;
      unawaited(restoreActiveRides());
      unawaited(_queue?.flush(includeBackfill: true));
    }));

    _subs.add(_socket.rideStatus.listen((data) {
      final status = data['status']?.toString();
      if (status == null) return;
      final id = data['rideId']?.toString();
      final newStatus = RideStatus.fromWire(status);

      // With shared trips several rides are live at once, so the update is
      // matched to its ride rather than assumed to be the one in focus.
      final others = state.otherRides;
      final otherIdx = id == null ? -1 : others.indexWhere((r) => r.id == id);
      if (otherIdx >= 0) {
        final next = List<Ride>.of(others);
        next[otherIdx] = next[otherIdx].copyWith(status: newStatus);
        state = state.copyWith(otherRides: next);
        return;
      }

      final ride = state.activeRide;
      if (ride == null) return;
      if (id != null && ride.id != id) return;
      state = state.copyWith(activeRide: ride.copyWith(status: newStatus));

      // A finished trip that was not paid in cash needs nothing more from the
      // driver. Clear it shortly after, so the screen is free for the next
      // request instead of waiting for a tap.
      if (newStatus == RideStatus.completed && ride.paymentMethod != 'cash') {
        Timer(const Duration(seconds: 8), () {
          final now = state.activeRide;
          if (mounted && now != null && now.id == ride.id &&
              now.status == RideStatus.completed) {
            _closeFocusedRide();
          }
        });
      }
    }));

    // A passenger was added to this vehicle: either a live match the driver
    // just accepted, or a rider who was waiting on a shared trip and has now
    // been given this driver. Nothing to accept; the driver is told who and
    // where.
    _subs.add(_socket.poolRiders.listen((data) {
      final id = data['rideId']?.toString();
      if (id == null || id.isEmpty) return;
      if (state.activeRide?.id == id ||
          state.otherRides.any((r) => r.id == id)) {
        return;
      }
      final rider = Ride.fromPoolRider(data);
      if (state.activeRide == null) {
        state = state.copyWith(activeRide: rider);
      } else {
        state = state.copyWith(otherRides: [...state.otherRides, rider]);
      }
    }));
  }

  // -----------------------------------------------------------------
  // Going online
  // -----------------------------------------------------------------

  /// Asks for everything the app needs to keep working with the screen off or
  /// another app in front: precise location, "allow all the time" location,
  /// the notification that keeps the background service alive, and exemption
  /// from battery optimisation (cheaper phones kill background apps without it).
  Future<void> _requestBackgroundAccess() async {
    try {
      await Permission.notification.request();
      if (await Permission.location.isGranted) {
        if (!await Permission.locationAlways.isGranted) {
          await Permission.locationAlways.request();
        }
      }
      if (!await Permission.ignoreBatteryOptimizations.isGranted) {
        await Permission.ignoreBatteryOptimizations.request();
      }
    } catch (e) {
      debugPrint('background access request failed: $e');
    }
  }

  Future<void> goOnline({bool auto = false}) async {
    if (state.isBlocked) {
      state = state.copyWith(errorKey: 'driver.debt_warning');
      return;
    }
    if (_queue != null) return; // already online
    state = state.copyWith(busy: true, clearError: true);

    try {
      final db = await OfflineLocationQueue.openBuffer();
      final queue = OfflineLocationQueue(_socket, db);
      // Permissions first when the driver tapped the button; an automatic
      // resume must not pop dialogs at someone who just opened the app.
      if (!auto) await _requestBackgroundAccess();
      await queue.start();
      _queue = queue;

      // The queue's fixes also drive the map marker, so the screen shows
      // what the server is being told rather than a separate reading.
      _positionSub?.cancel();
      _positionSub = queue.positions.listen((pos) {
        final here = LatLng(pos.latitude, pos.longitude);
        state = state.copyWith(position: here);
        _checkArrival(here);
      });

      await _session.setDriverWantsOnline(true);
      state = state.copyWith(
          isOnline: true, busy: false, locationGranted: true);
    } catch (e) {
      _queue = null;
      state = state.copyWith(
        busy: false,
        errorKey: e.toString().contains('permission')
            ? 'error.location_denied'
            : 'error.gps_off',
      );
    }
  }

  // -----------------------------------------------------------------
  // Arrival detection
  // -----------------------------------------------------------------

  /// Stops already announced, so each is raised once per ride.
  final Set<String> _arrivalRaised = {};

  /// How close counts as "there", in metres. GPS in a street canyon drifts
  /// by tens of metres, so this is generous; the driver still confirms.
  static const double _arrivalRadiusM = 90;

  /// Watches the distance to the pickup (before the rider is aboard) and to
  /// the drop-off (after), and tells the driver when they get there.
  void _checkArrival(LatLng here) {
    final ride = state.activeRide;
    if (ride == null) return;

    LatLng? stop;
    String? kind;
    if (ride.status == RideStatus.accepted && ride.pickupLatLng != null) {
      stop = ride.pickupLatLng;
      kind = 'pickup';
    } else if (ride.status == RideStatus.inProgress &&
        ride.dropoffLatLng != null) {
      stop = ride.dropoffLatLng;
      kind = 'dropoff';
    }
    if (stop == null || kind == null) return;

    final metres = Geolocator.distanceBetween(
        here.latitude, here.longitude, stop.latitude, stop.longitude);
    final key = '${ride.id}:$kind';
    if (metres <= _arrivalRadiusM && !_arrivalRaised.contains(key)) {
      _arrivalRaised.add(key);
      state = state.copyWith(arrivalPrompt: key);
      final who = ride.riderName ?? '';
      TripNotifier.instance.alert(
        id: (ride.id.hashCode + (kind == 'pickup' ? 11 : 12)) & 0x3fffffff,
        title: kind == 'pickup'
            ? 'Umefika · You are at the pickup'
            : 'Umefika · You have reached the drop-off',
        body: who,
      );
    }
  }

  /// Hides the arrival banner without acting on it.
  void dismissArrival() => state = state.copyWith(clearArrival: true);

  Future<void> goOffline() async {
    await _session.setDriverWantsOnline(false);
    // Tell the server now; otherwise the driver would keep being offered
    // rides for another minute and a half.
    await _socket.emitWithAck('driver:go_offline', {});
    await _positionSub?.cancel();
    _positionSub = null;
    await _queue?.stop();
    _queue = null;
    state = state.copyWith(isOnline: false, clearOffer: true);
  }

  /// Called when the app returns to the foreground. Phones suspend and kill
  /// background work unpredictably; this makes sure the driver is still
  /// connected, still reporting position, and still sees their current trip.
  Future<void> onAppResumed() async {
    await _socket.ensureConnected();
    if (_session.driverWantsOnline && _queue == null) {
      await goOnline(auto: true);
    }
    unawaited(_queue?.flush(includeBackfill: true));
    await restoreActiveRides();
  }

  /// Reloads the rides this driver is carrying from the server. A restart or
  /// a lost connection must not strand a rider with a driver whose app shows
  /// nothing.
  Future<void> restoreActiveRides() async {
    try {
      final res = await _api.get('/rides/driver/active');
      final rides = (res as List)
          .map((e) => Ride.fromPoolRider((e as Map).cast<String, dynamic>()))
          .toList();
      if (rides.isEmpty) return;

      final current = state.activeRide;
      // Keep the passenger in focus if they are still on the trip.
      Ride focus = rides.first;
      if (current != null) {
        for (final r in rides) {
          if (r.id == current.id) focus = r;
        }
      }
      // Preserve fields the server's summary does not carry.
      if (current != null && current.id == focus.id) {
        focus = Ride(
          id: focus.id,
          reference: current.reference,
          status: focus.status,
          category: current.category,
          quotedFareCents: focus.quotedFareCents,
          finalFareCents: current.finalFareCents,
          paymentMethod: focus.paymentMethod,
          isPaid: current.isPaid,
          serviceType: current.serviceType,
          deliveryCode: current.deliveryCode,
          poolMode: current.poolMode ?? focus.poolMode,
          poolCoRiders: current.poolCoRiders,
          riderName: focus.riderName ?? current.riderName,
          pickupAddress: focus.pickupAddress ?? current.pickupAddress,
          dropoffAddress: focus.dropoffAddress ?? current.dropoffAddress,
          pickupLatLng: focus.pickupLatLng,
          dropoffLatLng: focus.dropoffLatLng,
        );
      }
      state = state.copyWith(
        activeRide: focus,
        otherRides: rides.where((r) => r.id != focus.id).toList(),
      );
    } catch (_) {
      // Offline or not signed in yet: the socket reconnect will retry.
    }
  }

  // -----------------------------------------------------------------
  // Offers
  // -----------------------------------------------------------------

  /// Returns true if this driver won the ride. False means another driver
  /// accepted first — a routine race, not an error.
  Future<bool> acceptOffer() async {
    final offer = state.offer;
    if (offer == null) return false;

    TripNotifier.instance.cancelOfferAlert();
    final reply = await _socket.emitWithAck('ride:accept', {
      'rideId': offer.rideId,
      // The offer token proves this driver was actually offered the ride;
      // without it, a replayed ride id would be enough to claim one.
      'offerToken': offer.offerToken,
    });

    final won = reply is Map && reply['ok'] == true;
    if (won) {
      final accepted = Ride(
        id: offer.rideId,
        reference: '',
        status: RideStatus.accepted,
        category: VehicleCategory.standard,
        quotedFareCents: offer.fareCents,
        paymentMethod: offer.paymentMethod,
        isPaid: false,
        poolMode: offer.isPool ? 'join' : null,
        riderName: offer.riderName,
        pickupAddress: offer.pickupAddress,
        dropoffAddress: offer.dropoffAddress,
        pickupLatLng: offer.pickupLatLng,
        dropoffLatLng: offer.dropoffLatLng,
      );
      if (state.activeRide != null && offer.isPool) {
        // A rider added to a trip already under way: the driver keeps the
        // passenger they are with and this one joins the list.
        final known = state.activeRide?.id == accepted.id ||
            state.otherRides.any((r) => r.id == accepted.id);
        state = state.copyWith(
          clearOffer: true,
          otherRides: known ? null : [...state.otherRides, accepted],
        );
      } else {
        state = state.copyWith(clearOffer: true, activeRide: accepted);
      }
    } else {
      state = state.copyWith(clearOffer: true);
    }
    return won;
  }

  Future<void> declineOffer([String? reason]) async {
    final offer = state.offer;
    if (offer == null) return;
    TripNotifier.instance.cancelOfferAlert();
    _socket.emit('ride:decline', {'rideId': offer.rideId, 'reason': reason});
    state = state.copyWith(clearOffer: true);
  }

  void offerExpired() {
    TripNotifier.instance.cancelOfferAlert();
    state = state.copyWith(clearOffer: true);
  }

  // -----------------------------------------------------------------
  // Trip lifecycle
  // -----------------------------------------------------------------

  Future<void> markArrived() => _transition('arrived');
  Future<void> startTrip() => _transition('in_progress');
  Future<void> completeTrip() => _transition('completed');

  Future<void> _transition(String status) async {
    final ride = state.activeRide;
    if (ride == null) return;
    state = state.copyWith(busy: true, clearArrival: true);

    // Sent over the socket so the rider's app updates immediately; the
    // server validates the transition and computes the fare itself.
    _socket.emit('ride:status_change', {
      'rideId': ride.id,
      'status': status,
      'at': DateTime.now().millisecondsSinceEpoch,
    });

    if (status == 'in_progress') _queue?.setActiveRide(ride.id);
    if (status == 'completed') {
      // Another passenger may still be aboard; location pings stay tagged to
      // a ride that is actually in progress.
      final aboard = state.otherRides
          .where((r) => r.status == RideStatus.inProgress)
          .toList();
      _queue?.setActiveRide(aboard.isEmpty ? null : aboard.first.id);
      state = state.copyWith(
        tripsToday: state.tripsToday + 1,
        earnedTodayCents: state.earnedTodayCents + ride.payableCents,
      );
      await refreshWallet();
    }
    state = state.copyWith(busy: false);
  }

  /// Cash trips only. Commission is booked against the wallet at this point,
  /// not automatically on completion — a rider who leaves without paying is
  /// a real occurrence, and auto-booking would bill the driver for money
  /// they never received.
  Future<void> confirmCashCollected() async {
    final ride = state.activeRide;
    if (ride == null) return;
    try {
      await _api.post('/payments/cash/confirm', {'rideId': ride.id});
      _closeFocusedRide();
      await refreshWallet();
    } on ApiException catch (e) {
      state = state.copyWith(errorKey: e.message);
    }
  }

  void dismissTrip() => _closeFocusedRide();

  /// Finishes with the passenger in focus and moves on to the next one on
  /// the vehicle, if there is one.
  void _closeFocusedRide() {
    final rest = state.otherRides;
    if (rest.isEmpty) {
      state = state.copyWith(clearRide: true);
      return;
    }
    // Prefer someone already aboard, then someone being collected.
    final next = rest.firstWhere(
      (r) => r.status == RideStatus.inProgress,
      orElse: () => rest.first,
    );
    state = DriverState(
      isOnline: state.isOnline,
      position: state.position,
      offer: state.offer,
      activeRide: next,
      otherRides: rest.where((r) => r.id != next.id).toList(),
      tripsToday: state.tripsToday,
      earnedTodayCents: state.earnedTodayCents,
      walletBalanceCents: state.walletBalanceCents,
      debtCeilingCents: state.debtCeilingCents,
      isBlocked: state.isBlocked,
      busy: state.busy,
      errorKey: state.errorKey,
      locationGranted: state.locationGranted,
    );
  }

  /// Brings another passenger on the vehicle into focus.
  void focusRide(String rideId) {
    final target = state.otherRides.where((r) => r.id == rideId);
    final current = state.activeRide;
    if (target.isEmpty || current == null) return;
    state = state.copyWith(
      activeRide: target.first,
      otherRides: [
        for (final r in state.otherRides)
          if (r.id != rideId) r,
        current,
      ],
    );
  }

  Future<void> refreshWallet() async {
    try {
      final res = await _api.get('/payments/cash/balance');
      final map = (res as Map).cast<String, dynamic>();
      state = state.copyWith(
        walletBalanceCents: (map['balanceCents'] as num?)?.toInt() ?? 0,
        debtCeilingCents: (map['ceilingCents'] as num?)?.toInt() ?? 3000000,
        isBlocked: map['isBlocked'] == true,
      );
    } catch (_) {
      // Wallet is informational here; a failed refresh must not block work.
    }
  }

  void clearError() => state = state.copyWith(clearError: true);

  @override
  void dispose() {
    unawaited(_positionSub?.cancel());
    unawaited(_queue?.stop());
    for (final s in _subs) {
      s.cancel();
    }
    super.dispose();
  }
}

final driverControllerProvider =
    StateNotifierProvider<DriverController, DriverState>((ref) {
  return DriverController(
    ref.watch(apiClientProvider),
    ref.watch(socketClientProvider),
    ref.watch(sessionStoreProvider),
  );
});
