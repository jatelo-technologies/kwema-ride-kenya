/// Rider home.
///
/// The map is the screen; everything else rises over it. Riders here are
/// often standing at a roadside in bright sun on a mid-range Android device,
/// so this commits to large tap targets, high contrast, and never blocking
/// the UI on a network call. A stale price renders at reduced opacity while
/// re-quoting rather than being replaced by a spinner — a number that dims
/// reads as "updating", a blank box reads as broken.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/format/money.dart';
import '../../core/maps/route_guide.dart';
import '../../core/l10n/language_controller.dart';
import '../../core/l10n/localization.dart';
import '../../core/models/models.dart';
import '../../core/theme/app_theme.dart';
import 'rider_controller.dart';
import 'ride_tracking_sheet.dart';
import 'delivery_form_sheet.dart';
import 'pool_section.dart';
import '../shared/sos_button.dart';
import '../shared/rating_sheet.dart';
import '../../core/country_config.dart';

class RiderHomeScreen extends ConsumerStatefulWidget {
  const RiderHomeScreen({super.key});

  @override
  ConsumerState<RiderHomeScreen> createState() => _RiderHomeScreenState();
}

class _RiderHomeScreenState extends ConsumerState<RiderHomeScreen>
    with WidgetsBindingObserver {
  GoogleMapController? _map;
  final _searchController = TextEditingController();
  DateTime _followPausedUntil = DateTime.fromMillisecondsSinceEpoch(0);
  DateTime _lastFit = DateTime.fromMillisecondsSinceEpoch(0);

  /// The stop the driver is heading for: the rider's pickup until they are
  /// aboard, then the drop-off.
  (LatLng, String, bool)? _target(RiderState s) {
    final ride = s.ride;
    final driver = s.driverPosition;
    if (ride == null || driver == null) return null;
    switch (ride.status) {
      case RideStatus.accepted:
        final p = ride.pickupLatLng;
        return p == null ? null : (p, 'pickup:${ride.id}', true);
      case RideStatus.inProgress:
        final d = ride.dropoffLatLng;
        return d == null ? null : (d, 'dropoff:${ride.id}', false);
      default:
        return null;
    }
  }

  void _guide(RiderState s) {
    final guide = ref.read(riderRouteGuideProvider.notifier);
    final target = _target(s);
    final driver = s.driverPosition;
    if (target == null || driver == null) {
      if (ref.read(riderRouteGuideProvider).legKey != null) guide.clear();
      return;
    }
    guide.follow(
      origin: driver,
      destination: target.$1,
      legKey: target.$2,
      // The route service knows the petrol tiers; electric ones route as the
      // matching petrol vehicle.
      category: const ['boda', 'bajaji', 'standard', 'xl', 'express']
              .contains(s.ride?.category.wire)
          ? s.ride!.category.wire
          : 'standard',
    );
    _fitCamera(driver, target.$1);
  }

  /// While nothing else is moving the camera, keep the rider's own position
  /// in view as they walk.
  void _followMe(RiderState s) {
    final me = s.myPosition;
    if (me == null || _map == null) return;
    if (DateTime.now().isBefore(_followPausedUntil)) return;
    // Placing a passenger's pickup: the camera belongs to the rider.
    if (s.pickupIsPassengers && !s.hasActiveRide && s.pickup != null) return;
    if (s.pickingPickup) return;
    // Choosing a destination or watching a trip has its own framing.
    if (s.dropoff != null || (s.hasActiveRide && s.driverPosition != null)) {
      return;
    }
    try {
      _map?.animateCamera(CameraUpdate.newLatLng(me));
    } catch (_) {}
  }

  void _recenter(RiderState s) {
    _followPausedUntil = DateTime.fromMillisecondsSinceEpoch(0);
    final me = s.myPosition;
    if (me == null) {
      ref.read(riderControllerProvider.notifier).retryLocation();
      return;
    }
    try {
      _map?.animateCamera(CameraUpdate.newCameraPosition(
          CameraPosition(target: me, zoom: 16.5)));
    } catch (_) {}
  }

  /// Keeps the vehicle and its next stop both in view as the trip moves.
  void _fitCamera(LatLng a, LatLng b) {
    final now = DateTime.now();
    if (now.isBefore(_followPausedUntil)) return;
    if (now.difference(_lastFit) < const Duration(seconds: 4)) return;
    _lastFit = now;
    final sw = LatLng(a.latitude < b.latitude ? a.latitude : b.latitude,
        a.longitude < b.longitude ? a.longitude : b.longitude);
    final ne = LatLng(a.latitude > b.latitude ? a.latitude : b.latitude,
        a.longitude > b.longitude ? a.longitude : b.longitude);
    try {
      _map?.animateCamera(
          CameraUpdate.newLatLngBounds(LatLngBounds(southwest: sw, northeast: ne), 90));
    } catch (_) {
      // newLatLngBounds throws before the map has a size; the next tick works.
    }
  }

  Set<Polyline> _polylines(RiderState s, RouteGuideState guide) {
    if (s.hasActiveRide) {
      if (!guide.hasRoute) return const {};
      return {
        Polyline(
          polylineId: const PolylineId('route'),
          points: guide.points,
          width: 7,
          color: const Color(0xFF3A4BB8),
          startCap: Cap.roundCap,
          endCap: Cap.roundCap,
          jointType: JointType.round,
        ),
      };
    }
    // While choosing a ride, preview the route the quote is for.
    final quote = s.selected;
    if (quote == null || quote.polyline.isEmpty) return const {};
    final pts = decodePolyline(quote.polyline);
    if (pts.length < 2) return const {};
    return {
      Polyline(
        polylineId: const PolylineId('preview'),
        points: pts,
        width: 6,
        color: const Color(0xFF3A4BB8),
        jointType: JointType.round,
      ),
    };
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState lifecycle) {
    // Back from the background: make sure the live connection is still up so
    // the driver's movement and any incoming call arrive.
    if (lifecycle == AppLifecycleState.resumed) {
      ref.read(socketClientProvider).ensureConnected();
      final rider = ref.read(riderControllerProvider.notifier);
      rider.refreshTracking();
      rider.retryLocation();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _map?.dispose();
    _searchController.dispose();
    super.dispose();
  }

  Set<Marker> _markers(RiderState s) {
    final markers = <Marker>{};
    if (s.hasActiveRide && s.myPosition != null) {
      markers.add(Marker(
        markerId: const MarkerId('me'),
        position: s.myPosition!,
        anchor: const Offset(0.5, 0.5),
        flat: true,
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueBlue),
      ));
    }
    final focus = s.hasActiveRide ? s.ride : null;
    final pickup = focus?.pickupLatLng ?? (focus == null ? s.pickup : null);
    final dropoff = focus?.dropoffLatLng ?? (focus == null ? s.dropoff : null);
    if (pickup != null && focus?.status != RideStatus.inProgress) {
      final movable = focus == null && s.pickupIsPassengers;
      markers.add(Marker(
        markerId: const MarkerId('pickup'),
        position: pickup,
        draggable: movable,
        onDragEnd: movable
            ? (p) => ref.read(riderControllerProvider.notifier).pinPickup(p)
            : null,
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueGreen),
      ));
    }
    if (dropoff != null) {
      markers.add(Marker(
        markerId: const MarkerId('dropoff'),
        position: dropoff,
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueRed),
      ));
    }
    // Every open ride shows its own driver, so a rider with several rides on
    // the road sees all the cars at once.
    for (final r in s.activeRides) {
      final at = s.driverPositions[r.id];
      if (at == null) continue;
      final isFocus = r.id == s.focusId;
      markers.add(Marker(
        markerId: MarkerId('driver:${r.id}'),
        position: at,
        infoWindow: InfoWindow(
          title: r.forOther ? r.passengerName : r.driver?.name,
          snippet: r.vehicle?.plate,
        ),
        icon: BitmapDescriptor.defaultMarkerWithHue(
            isFocus ? BitmapDescriptor.hueAzure : BitmapDescriptor.hueViolet),
      ));
    }
    // Other rides' pickup points, so the rider can trace where each is going.
    for (final r in s.activeRides) {
      if (r.id == s.focusId || r.pickupLatLng == null) continue;
      if (r.status == RideStatus.inProgress) continue;
      markers.add(Marker(
        markerId: MarkerId('pickup:${r.id}'),
        position: r.pickupLatLng!,
        infoWindow: InfoWindow(
            title: r.forOther ? r.passengerName : null, snippet: r.pickupAddress),
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueOrange),
      ));
    }
    return markers;
  }

  Set<Circle> _circles(RiderState s) {
    final me = s.myPosition;
    if (me == null) return const {};
    // A soft halo under Google's blue dot: visible at street zoom, and still
    // shows where the rider is if the dot layer is off.
    return {
      Circle(
        circleId: const CircleId('me-halo'),
        center: me,
        radius: 28,
        fillColor: const Color(0x223A4BB8),
        strokeColor: const Color(0x663A4BB8),
        strokeWidth: 1,
      ),
    };
  }

  /// Guards against the sheet reopening on every rebuild while the completed
  /// ride is still on screen.
  final Set<String> _ratedRideIds = {};

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(riderControllerProvider);
    final l10n = AppLocalizations.of(context);

    final guide = ref.watch(riderRouteGuideProvider);

    // Rating is offered once, when the trip closes.
    ref.listen<RiderState>(riderControllerProvider, (previous, next) {
      if (previous?.driverPosition != next.driverPosition ||
          previous?.focusId != next.focusId ||
          previous?.composing != next.composing ||
          previous?.ride?.status != next.ride?.status) {
        _guide(next);
      }
      if (previous?.dropoff != null && next.dropoff == null) {
        _searchController.clear();
      }
      // A pickup the rider just chose for someone else: show it.
      if (next.pickupIsPassengers &&
          next.pickupChosen &&
          next.pickup != null &&
          previous?.pickup != next.pickup &&
          !next.hasActiveRide &&
          next.dropoff == null) {
        try {
          _map?.animateCamera(CameraUpdate.newLatLngZoom(next.pickup!, 16.5));
        } catch (_) {}
      }
      if (previous?.myPosition != next.myPosition ||
          previous?.focusId != next.focusId ||
          previous?.composing != next.composing) {
        _followMe(next);
      }
      // Rating is offered once per ride, for any ride that just finished.
      for (final ride in next.rides.values) {
        if (ride.status != RideStatus.completed) continue;
        if (ride.driver == null) continue;
        if (_ratedRideIds.contains(ride.id)) continue;
        _ratedRideIds.add(ride.id);
        RatingSheet.show(
          context,
          rideId: ride.id,
          counterpartyName: ride.driver!.name,
        );
        break;
      }
    });

    return Scaffold(
      body: Stack(
        children: [
          Listener(
            onPointerDown: (_) => _followPausedUntil =
                DateTime.now().add(const Duration(seconds: 12)),
            child: GoogleMap(
              // Google only switches its blue dot on when the map is created,
              // so a map built before the location permission was granted
              // never showed the rider's position. Rebuilding it when the
              // permission arrives is what makes the dot appear and move.
              key: ValueKey('rider-map-${state.locationGranted}'),
              initialCameraPosition: CameraPosition(
                // City centre (kMapCenter): a sensible cold-start position.
                target: state.myPosition ??
                    state.pickup ??
                    kMapCenter,
                zoom: 16,
              ),
              onMapCreated: (c) {
                _map = c;
                _followMe(ref.read(riderControllerProvider));
              },
              onTap: state.pickingPickup && !state.hasActiveRide
                  ? (p) => ref.read(riderControllerProvider.notifier).pinPickup(p)
                  : null,
              markers: _markers(state),
              circles: _circles(state),
              polylines: _polylines(state, guide),
              myLocationEnabled: state.locationGranted,
              myLocationButtonEnabled: false,
              zoomControlsEnabled: false,
              compassEnabled: false,
              padding: EdgeInsets.only(
                  bottom: state.hasActiveRide ? 280 : 330, top: 100),
            ),
          ),

          if (guide.hasRoute && state.hasActiveRide && _target(state) != null)
            Positioned(
              left: 12,
              right: 12,
              top: MediaQuery.of(context).padding.top + 64,
              child: Material(
                color: Theme.of(context).colorScheme.surface,
                elevation: 4,
                borderRadius: BorderRadius.circular(16),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 14, vertical: 10),
                  child: Row(children: [
                    Icon(
                        _target(state)!.$3
                            ? Icons.directions_car
                            : Icons.flag,
                        color: Theme.of(context).colorScheme.primary),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        '${l10n.translate(_target(state)!.$3 ? 'nav.driver_arriving' : 'nav.arriving_dest')}'
                        ' · ${(guide.durationS / 60).ceil().clamp(1, 999)} min'
                        ' · ${guide.distanceM >= 1000 ? '${(guide.distanceM / 1000).toStringAsFixed(1)} km' : '${guide.distanceM} m'}',
                        style: Theme.of(context)
                            .textTheme
                            .titleSmall
                            ?.copyWith(fontWeight: FontWeight.w800),
                      ),
                    ),
                  ]),
                ),
              ),
            ),

          if (state.pickingPickup && !state.hasActiveRide)
            Positioned(
              left: 12,
              right: 12,
              top: MediaQuery.of(context).padding.top + 64,
              child: Material(
                color: Theme.of(context).colorScheme.primary,
                elevation: 4,
                borderRadius: BorderRadius.circular(16),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(14, 8, 6, 8),
                  child: Row(children: [
                    const Icon(Icons.touch_app, color: Colors.white),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(l10n.translate('ride.pickup_tap_map'),
                          style: const TextStyle(
                              color: Colors.white, fontWeight: FontWeight.w700)),
                    ),
                    TextButton(
                      onPressed: () => ref
                          .read(riderControllerProvider.notifier)
                          .setPickingPickup(false),
                      child: Text(l10n.translate('ride.pickup_cancel_pin'),
                          style: const TextStyle(color: Colors.white)),
                    ),
                  ]),
                ),
              ),
            ),

          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Row(children: [
                // Reachable at any time, not only once a trip is underway.
                // Someone walking to a pickup point is still a rider.
                const SosButton(compact: true),
                const Expanded(child: SizedBox()),
                const LanguagePill(),
                const SizedBox(width: 8),
                Material(
                  color: Theme.of(context).colorScheme.surface,
                  shape: const CircleBorder(),
                  child: IconButton(
                    icon: const Icon(Icons.logout, size: 20),
                    onPressed: () =>
                        ref.read(authControllerProvider.notifier).signOut(),
                  ),
                ),
              ]),
            ),
          ),

          Positioned(
            right: 12,
            bottom: (state.hasActiveRide ? 300 : 350),
            child: FloatingActionButton.small(
              heroTag: 'recenter',
              tooltip: l10n.translate('map.recenter'),
              onPressed: () => _recenter(state),
              child: const Icon(Icons.my_location),
            ),
          ),

          Align(
            alignment: Alignment.bottomCenter,
            child: state.hasActiveRide
                ? RideTrackingSheet(ride: state.ride!)
                // While the rider taps the map for the pickup, the sheet steps
                // aside so the whole map is available.
                : state.pickingPickup
                    ? const SizedBox.shrink()
                    : _BookingSheet(
                    state: state,
                    searchController: _searchController,
                  ),
          ),

          if (state.errorKey != null && !state.hasActiveRide)
            Positioned(
              left: 16, right: 16, bottom: 350,
              child: Material(
                color: Theme.of(context).colorScheme.error,
                borderRadius: BorderRadius.circular(12),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(14, 12, 6, 12),
                  child: Row(children: [
                    Expanded(
                      child: Text(l10n.translate(state.errorKey!),
                          style: const TextStyle(color: Colors.white)),
                    ),
                    IconButton(
                      icon: const Icon(Icons.close, color: Colors.white),
                      onPressed: () =>
                          ref.read(riderControllerProvider.notifier).clearError(),
                    ),
                  ]),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------

class _BookingSheet extends ConsumerWidget {
  const _BookingSheet({required this.state, required this.searchController});

  final RiderState state;
  final TextEditingController searchController;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final controller = ref.read(riderControllerProvider.notifier);

    return Container(
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
        boxShadow: const [
          BoxShadow(color: Color(0x1A000000), blurRadius: 24, offset: Offset(0, -4))
        ],
      ),
      child: SafeArea(
        top: false,
        child: ConstrainedBox(
         constraints: BoxConstraints(
             maxHeight: MediaQuery.of(context).size.height * 0.78),
         child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (state.rides.isNotEmpty)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    onPressed: controller.backToRides,
                    icon: const Icon(Icons.arrow_back, size: 18),
                    label: Text(l10n.translate('ride.back_to_rides')),
                  ),
                ),
              // Product switch. Three tabs rather than a menu: the choice is
              // made before anything else and must be visible, not hidden.
              _ServiceTabs(
                selected: state.service,
                onSelect: (s) => controller.setService(s),
              ),
              const SizedBox(height: 12),

              // Who is riding, and for someone else, where they are. This sits
              // above the destination, not behind the quotes: the quotes need
              // the pickup, so it has to be reachable before they exist.
              if (!state.service.isDelivery) ...[
                _ForWhom(state: state),
                const SizedBox(height: 12),
              ],

              TextField(
                controller: searchController,
                decoration: InputDecoration(
                  hintText: l10n.translate('rider.where_to'),
                  prefixIcon: const Icon(Icons.search),
                ),
                onChanged: controller.searchPlaces,
              ),

              if (state.suggestions.isNotEmpty)
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 220),
                  child: ListView.builder(
                    shrinkWrap: true,
                    itemCount: state.suggestions.length,
                    itemBuilder: (context, i) {
                      final s = state.suggestions[i];
                      return ListTile(
                        dense: true,
                        leading: const Icon(Icons.place_outlined, size: 20),
                        title: Text(s.primary,
                            maxLines: 1, overflow: TextOverflow.ellipsis),
                        subtitle: Text(s.secondary,
                            maxLines: 1, overflow: TextOverflow.ellipsis),
                        onTap: () {
                          searchController.text = s.primary;
                          FocusScope.of(context).unfocus();
                          controller.chooseDestination(s);
                        },
                      );
                    },
                  ),
                ),

              if (state.service.isDelivery) ...[
                const SizedBox(height: 10),
                InkWell(
                  borderRadius: BorderRadius.circular(12),
                  onTap: () => DeliveryFormSheet.show(context, state.service),
                  child: Container(
                    padding: const EdgeInsets.all(13),
                    decoration: BoxDecoration(
                      color: state.delivery == null
                          ? theme.colorScheme.errorContainer.withValues(alpha: 0.35)
                          : theme.colorScheme.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Row(children: [
                      Icon(state.delivery == null
                          ? Icons.assignment_late_outlined
                          : Icons.assignment_turned_in_outlined),
                      const SizedBox(width: 11),
                      Expanded(
                        child: state.delivery == null
                            ? Text(l10n.translate('delivery.recipient'),
                                style: const TextStyle(fontWeight: FontWeight.w600))
                            : Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(state.delivery!.recipientName,
                                      style: const TextStyle(
                                          fontWeight: FontWeight.w700)),
                                  Text(state.delivery!.description,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: theme.textTheme.bodySmall),
                                ],
                              ),
                      ),
                      const Icon(Icons.chevron_right),
                    ]),
                  ),
                ),
              ],

              // A destination without a pickup can never be priced; say why
              // instead of showing nothing.
              if (state.dropoff != null &&
                  state.pickup == null &&
                  state.quotes.isEmpty &&
                  !state.pickupIsPassengers) ...[
                const SizedBox(height: 12),
                InkWell(
                  borderRadius: BorderRadius.circular(12),
                  onTap: controller.retryLocation,
                  child: Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: theme.colorScheme.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Row(children: [
                      const Icon(Icons.my_location),
                      const SizedBox(width: 10),
                      Expanded(child: Text(l10n.translate('rider.no_pickup'))),
                    ]),
                  ),
                ),
              ],

              if (state.quotes.isNotEmpty) ...[
                const SizedBox(height: 12),
                SizedBox(
                  height: 128,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    itemCount: state.quotes.length,
                    separatorBuilder: (_, __) => const SizedBox(width: 10),
                    itemBuilder: (context, i) {
                      final quote = state.quotes[i];
                      return _CategoryCard(
                        quote: quote,
                        isSelected: state.selected?.category == quote.category,
                        isQuoting: state.isQuoting,
                        onTap: () => controller.selectCategory(quote.category),
                      );
                    },
                  ),
                ),

                const SizedBox(height: 12),
                _PaymentSelector(
                  selected: state.paymentMethod,
                  onSelect: controller.setPaymentMethod,
                ),

                PoolSection(state: state),

                const SizedBox(height: 12),
                Row(children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(l10n.translate('rider.estimated_fare'),
                            style: theme.textTheme.bodySmall),
                        AnimatedOpacity(
                          opacity: state.isQuoting ? 0.45 : 1,
                          duration: const Duration(milliseconds: 180),
                          child: Text(
                            state.selected == null
                                ? '—'
                                : formatMoney(state.selected!.totalFareCents),
                            style: theme.textTheme.headlineSmall
                                ?.copyWith(fontWeight: FontWeight.w800),
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (state.selected != null &&
                      state.selected!.fare.surgeMultiplier > 1)
                    _SurgeChip(
                        multiplier: state.selected!.fare.surgeMultiplier),
                ]),

                // Reusing the network-error string here was wrong: nothing is
                // offline, the server just could not route this leg and fell
                // back to a straight-line estimate. Say that instead.
                if (state.selected?.isEstimate == true) ...[
                  const SizedBox(height: 6),
                  Text(l10n.translate('rider.fare_approx'),
                      style: theme.textTheme.bodySmall
                          ?.copyWith(color: KwemaColors.marigold700)),
                ],

                if (state.pickupIsPassengers &&
                    state.passengerName.trim().length < 2) ...[
                  const SizedBox(height: 6),
                  Text(l10n.translate('ride.hint_name'),
                      style: theme.textTheme.bodySmall
                          ?.copyWith(color: KwemaColors.marigold700)),
                ],
                const SizedBox(height: 10),
                SizedBox(
                  height: 56,
                  child: FilledButton(
                    onPressed: state.canRequest && !state.isRequesting
                        ? controller.requestRide
                        : null,
                    child: state.isRequesting
                        ? const SizedBox(
                            width: 22, height: 22,
                            child: CircularProgressIndicator(
                                strokeWidth: 2.4, color: Colors.white))
                        : Text(
                            l10n.translate('rider.request_ride', params: {
                              'category': state.selected == null
                                  ? ''
                                  : l10n.categoryName(state.selected!.category),
                            }),
                            style: const TextStyle(fontSize: 16),
                          ),
                  ),
                ),
              ],
            ],
          ),
         ),
        ),
      ),
    );
  }
}

/// Who is taking this ride: the rider, or somebody they are booking for.
/// A rider already on a ride of their own can only book for someone else,
/// because that is what a second simultaneous ride means.
class _ForWhom extends ConsumerStatefulWidget {
  const _ForWhom({required this.state});
  final RiderState state;

  @override
  ConsumerState<_ForWhom> createState() => _ForWhomState();
}

class _ForWhomState extends ConsumerState<_ForWhom> {
  late final TextEditingController _name =
      TextEditingController(text: widget.state.passengerName);
  late final TextEditingController _phone =
      TextEditingController(text: widget.state.passengerPhone);
  final TextEditingController _pickupText = TextEditingController();

  bool _pickupTextReady = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // The sheet is rebuilt when the map takes over for pin placement; bring
    // the chosen pickup back into the box.
    if (_pickupTextReady) return;
    _pickupTextReady = true;
    final st = widget.state;
    if (st.pickupChosen && st.pickupLabel != null) {
      _pickupText.text = st.pickupLabel == 'Pin'
          ? AppLocalizations.of(context).translate('ride.pin_dropped')
          : st.pickupLabel!;
    }
  }

  @override
  void didUpdateWidget(covariant _ForWhom oldWidget) {
    super.didUpdateWidget(oldWidget);
    // The form is cleared after a ride is requested; keep the fields in step.
    if (oldWidget.state.passengerName.isNotEmpty &&
        widget.state.passengerName.isEmpty) {
      _name.clear();
      _phone.clear();
    }
    // Keep the box in step with what the controller chose (pin, search, reset).
    final label = widget.state.pickupChosen ? widget.state.pickupLabel : null;
    if (!widget.state.pickupChosen && _pickupText.text.isNotEmpty) {
      _pickupText.clear();
    } else if (label != null &&
        label != oldWidget.state.pickupLabel &&
        _pickupText.text != label) {
      _pickupText.text = label == 'Pin'
          ? AppLocalizations.of(context).translate('ride.pin_dropped')
          : label;
    }
  }

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _pickupText.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final s = widget.state;
    final controller = ref.read(riderControllerProvider.notifier);
    final other = s.bookingForOther;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(l10n.translate('ride.who'), style: theme.textTheme.bodySmall),
        const SizedBox(height: 6),
        Row(children: [
          Expanded(
            child: ChoiceChip(
              selected: !other,
              label: SizedBox(
                  width: double.infinity,
                  child: Text(l10n.translate('ride.for_me'),
                      textAlign: TextAlign.center)),
              onSelected: s.mustBookForOther
                  ? null
                  : (_) => controller.setForOther(false),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: ChoiceChip(
              selected: other,
              label: SizedBox(
                  width: double.infinity,
                  child: Text(l10n.translate('ride.for_other'),
                      textAlign: TextAlign.center)),
              onSelected: (_) => controller.setForOther(true),
            ),
          ),
        ]),
        if (s.mustBookForOther) ...[
          const SizedBox(height: 6),
          Text(l10n.translate('ride.own_active'),
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: KwemaColors.marigold700)),
        ],
        if (other) ...[
          const SizedBox(height: 8),
          TextField(
            controller: _name,
            textCapitalization: TextCapitalization.words,
            decoration: InputDecoration(
              labelText: l10n.translate('ride.passenger_name'),
              prefixIcon: const Icon(Icons.person_outline),
            ),
            onChanged: (v) => controller.setPassenger(name: v),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _phone,
            keyboardType: TextInputType.phone,
            decoration: InputDecoration(
              labelText: l10n.translate('ride.passenger_phone'),
              prefixIcon: const Icon(Icons.phone_outlined),
            ),
            onChanged: (v) => controller.setPassenger(phone: v),
          ),
          const SizedBox(height: 12),
          Text(l10n.translate('ride.pickup_for_other'),
              style: theme.textTheme.bodySmall),
          const SizedBox(height: 6),
          TextField(
            controller: _pickupText,
            decoration: InputDecoration(
              hintText: l10n.translate('ride.pickup_search'),
              prefixIcon: const Icon(Icons.trip_origin, color: Colors.green),
            ),
            onChanged: controller.searchPickupPlaces,
          ),
          if (s.pickupSuggestions.isNotEmpty)
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 200),
              child: ListView.builder(
                shrinkWrap: true,
                itemCount: s.pickupSuggestions.length,
                itemBuilder: (context, i) {
                  final p = s.pickupSuggestions[i];
                  return ListTile(
                    dense: true,
                    leading: const Icon(Icons.place_outlined, size: 20),
                    title: Text(p.primary,
                        maxLines: 1, overflow: TextOverflow.ellipsis),
                    subtitle: Text(p.secondary,
                        maxLines: 1, overflow: TextOverflow.ellipsis),
                    onTap: () {
                      _pickupText.text = p.primary;
                      FocusScope.of(context).unfocus();
                      controller.choosePickupSuggestion(p);
                    },
                  );
                },
              ),
            ),
          const SizedBox(height: 6),
          Align(
            alignment: Alignment.centerLeft,
            child: OutlinedButton.icon(
              style: OutlinedButton.styleFrom(minimumSize: const Size(0, 40)),
              onPressed: () {
                FocusScope.of(context).unfocus();
                controller.setPickingPickup(!s.pickingPickup);
              },
              icon: const Icon(Icons.push_pin_outlined, size: 18),
              label: Text(l10n.translate('ride.pickup_on_map')),
            ),
          ),
          if (s.pickupChosen) ...[
            const SizedBox(height: 4),
            Text(l10n.translate('ride.pickup_drag'),
                style: theme.textTheme.bodySmall),
          ] else ...[
            const SizedBox(height: 4),
            Text(l10n.translate('ride.pickup_needed'),
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: KwemaColors.marigold700)),
          ],
        ],
      ],
    );
  }
}

class _CategoryCard extends StatelessWidget {
  const _CategoryCard({
    required this.quote,
    required this.isSelected,
    required this.isQuoting,
    required this.onTap,
  });

  final FareQuote quote;
  final bool isSelected;
  final bool isQuoting;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);

    return Semantics(
      selected: isSelected,
      button: true,
      child: GestureDetector(
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          width: 116,
          padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 8),
          decoration: BoxDecoration(
            color: isSelected
                ? quote.category.colour.withValues(alpha: 0.10)
                : theme.colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
              color: isSelected ? quote.category.colour : Colors.transparent,
              width: 2,
            ),
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              // Tier colour bar rather than an icon: riders with limited
              // literacy recognise the tile by colour before reading it.
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Container(
                    width: quote.category.isElectric ? 20 : 28,
                    height: 5,
                    decoration: BoxDecoration(
                      color: quote.category.colour,
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
                  if (quote.category.isElectric) ...[
                    const SizedBox(width: 4),
                    Icon(Icons.bolt, size: 13, color: quote.category.colour),
                  ],
                ],
              ),
              const SizedBox(height: 10),
              Text(l10n.categoryName(quote.category),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelLarge?.copyWith(
                      fontWeight:
                          isSelected ? FontWeight.w800 : FontWeight.w500)),
              const SizedBox(height: 4),
              AnimatedOpacity(
                opacity: isQuoting ? 0.45 : 1,
                duration: const Duration(milliseconds: 180),
                child: Text(formatMoneyCompact(quote.totalFareCents),
                    style: theme.textTheme.bodyMedium
                        ?.copyWith(fontWeight: FontWeight.w700)),
              ),
              Text(
                l10n.translate('rider.eta_min',
                    params: {'min': '${(quote.etaSeconds / 60).ceil()}'}),
                style: theme.textTheme.bodySmall,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PaymentSelector extends StatelessWidget {
  const _PaymentSelector({required this.selected, required this.onSelect});
  final String selected;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    const methods = ['mobile_money', 'card', 'cash'];

    return Row(
      children: methods.map((m) {
        final on = m == selected;
        return Expanded(
          child: Padding(
            padding: const EdgeInsets.only(right: 8),
            child: GestureDetector(
              onTap: () => onSelect(m),
              child: Container(
                padding: const EdgeInsets.symmetric(vertical: 11),
                decoration: BoxDecoration(
                  color: on
                      ? theme.colorScheme.primaryContainer
                      : theme.colorScheme.surface,
                  border: Border.all(
                    color: on ? theme.colorScheme.primary : theme.colorScheme.outline,
                    width: on ? 2 : 1,
                  ),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Center(
                  child: Text(
                    l10n.translate('payment.$m'),
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: on ? FontWeight.w700 : FontWeight.w500,
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      }).toList(),
    );
  }
}

class _SurgeChip extends StatelessWidget {
  const _SurgeChip({required this.multiplier});
  final double multiplier;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: KwemaColors.marigold50,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        const Icon(Icons.trending_up, size: 16, color: KwemaColors.marigold700),
        const SizedBox(width: 6),
        // Stating the reason rather than a bare multiplier cuts complaints.
        Text(
          l10n.translate('rider.surge_active',
              params: {'x': multiplier.toStringAsFixed(1)}),
          style: const TextStyle(
              color: KwemaColors.marigold700,
              fontWeight: FontWeight.w600,
              fontSize: 13),
        ),
      ]),
    );
  }
}


/// Ride, parcel or food. Colour and icon carry the distinction as much as the
/// word does, for the same reason the vehicle tiers use coloured bars.
class _ServiceTabs extends StatelessWidget {
  const _ServiceTabs({required this.selected, required this.onSelect});

  final ServiceType selected;
  final ValueChanged<ServiceType> onSelect;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    return Row(
      children: ServiceType.values.map((service) {
        final on = service == selected;
        return Expanded(
          child: Padding(
            padding: const EdgeInsets.only(right: 8),
            child: GestureDetector(
              onTap: () => onSelect(service),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 150),
                padding: const EdgeInsets.symmetric(vertical: 11),
                decoration: BoxDecoration(
                  color: on
                      ? theme.colorScheme.primaryContainer
                      : theme.colorScheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                    color: on ? theme.colorScheme.primary : Colors.transparent,
                    width: 2,
                  ),
                ),
                child: Column(children: [
                  Icon(service.icon,
                      size: 21,
                      color: on
                          ? theme.colorScheme.primary
                          : theme.colorScheme.onSurfaceVariant),
                  const SizedBox(height: 3),
                  Text(
                    l10n.translate(service.labelKey),
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: on ? FontWeight.w800 : FontWeight.w500,
                      color: on ? theme.colorScheme.primary : null,
                    ),
                  ),
                ]),
              ),
            ),
          ),
        );
      }).toList(),
    );
  }
}
