/// Driver dashboard: map, online toggle, earnings, and the active trip.
///
/// Design constraints that are not negotiable here: the driver is often on a
/// motorcycle, sometimes in rain, wearing a helmet, and glancing at the phone
/// for under a second. Everything actionable is at least 56px tall, high
/// contrast, and reachable with a thumb.

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
import '../../core/country_config.dart';
import 'driver_controller.dart';
import 'incoming_ride_modal.dart';
import '../shared/contact_sheet.dart';
import '../shared/sos_button.dart';
import '../shared/rating_sheet.dart';
import 'handover_sheet.dart';
import 'pay_commission_sheet.dart';

class DriverHomeScreen extends ConsumerStatefulWidget {
  const DriverHomeScreen({super.key});

  @override
  ConsumerState<DriverHomeScreen> createState() => _DriverHomeScreenState();
}

class _DriverHomeScreenState extends ConsumerState<DriverHomeScreen>
    with WidgetsBindingObserver {
  GoogleMapController? _map;
  bool _modalOpen = false;
  String? _ratedRideId;

  /// Camera follows the vehicle during a trip, but backs off for a few
  /// seconds after the driver touches the map so they can look around.
  DateTime _followPausedUntil = DateTime.fromMillisecondsSinceEpoch(0);
  LatLng? _lastCameraPos;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _map?.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState lifecycle) {
    if (lifecycle == AppLifecycleState.resumed) {
      ref.read(driverControllerProvider.notifier).onAppResumed();
    }
  }

  /// Where the guidance line should run for the current state, or null.
  (LatLng, String)? _target(DriverState s) {
    final ride = s.activeRide;
    if (ride == null) return null;
    switch (ride.status) {
      case RideStatus.accepted:
        final p = ride.pickupLatLng;
        return p == null ? null : (p, 'pickup:${ride.id}');
      case RideStatus.inProgress:
        final d = ride.dropoffLatLng;
        return d == null ? null : (d, 'dropoff:${ride.id}');
      default:
        return null;
    }
  }

  void _guide(DriverState s) {
    final guide = ref.read(driverRouteGuideProvider.notifier);
    final target = _target(s);
    final pos = s.position;
    if (target == null || pos == null) {
      if (ref.read(driverRouteGuideProvider).legKey != null) guide.clear();
      return;
    }
    guide.follow(origin: pos, destination: target.$1, legKey: target.$2);
  }

  void _followCamera(DriverState s, LatLng pos) {
    if (DateTime.now().isBefore(_followPausedUntil)) return;
    final prev = _lastCameraPos;
    _lastCameraPos = pos;
    if (s.activeRide == null) {
      // Waiting for a job: keep the driver's own position centred as they
      // move, flat and not too close.
      try {
        _map?.animateCamera(CameraUpdate.newLatLng(pos));
      } catch (_) {}
      return;
    }
    final bearing =
        (prev == null || metresBetween(prev, pos) < 3) ? null : bearingBetween(prev, pos);
    try {
      _map?.animateCamera(CameraUpdate.newCameraPosition(CameraPosition(
        target: pos,
        zoom: 17,
        tilt: 40,
        bearing: bearing ?? 0,
      )));
    } catch (_) {}
  }

  void _recenter(DriverState s) {
    _followPausedUntil = DateTime.fromMillisecondsSinceEpoch(0);
    final pos = s.position;
    if (pos == null) return;
    try {
      _map?.animateCamera(CameraUpdate.newCameraPosition(
          CameraPosition(target: pos, zoom: 17)));
    } catch (_) {}
  }

  Set<Circle> _circles(DriverState s) {
    final pos = s.position;
    if (pos == null) return const {};
    return {
      Circle(
        circleId: const CircleId('me-halo'),
        center: pos,
        radius: 28,
        fillColor: const Color(0x223A4BB8),
        strokeColor: const Color(0x663A4BB8),
        strokeWidth: 1,
      ),
    };
  }

  Set<Marker> _markers(DriverState s) {
    final ride = s.activeRide;
    final out = <Marker>{};
    // The driver's own position, as a marker as well as Google's blue dot, so
    // it shows whichever of the two the phone manages to draw.
    if (s.position != null) {
      out.add(Marker(
        markerId: const MarkerId('me'),
        position: s.position!,
        anchor: const Offset(0.5, 0.5),
        flat: true,
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueBlue),
      ));
    }
    if (ride == null) return out;
    final p = ride.pickupLatLng, d = ride.dropoffLatLng;
    if (p != null && ride.status.index <= RideStatus.arrived.index) {
      out.add(Marker(
        markerId: const MarkerId('pickup'),
        position: p,
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueGreen),
      ));
    }
    if (d != null) {
      out.add(Marker(
        markerId: const MarkerId('dropoff'),
        position: d,
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueRed),
      ));
    }
    // Other passengers on the vehicle: where each is waiting.
    for (final r in s.otherRides) {
      final op = r.pickupLatLng;
      if (op != null && r.status.index <= RideStatus.arrived.index) {
        out.add(Marker(
          markerId: MarkerId('pickup:${r.id}'),
          position: op,
          infoWindow: InfoWindow(title: r.riderName),
          icon: BitmapDescriptor.defaultMarkerWithHue(
              BitmapDescriptor.hueOrange),
        ));
      }
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(driverControllerProvider);
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    // Offers arrive over the socket at any moment; showing the modal from a
    // listener keeps that out of the build method.
    final guide = ref.watch(driverRouteGuideProvider);

    ref.listen<DriverState>(driverControllerProvider, (previous, next) {
      if (previous?.position != next.position ||
          previous?.activeRide?.id != next.activeRide?.id ||
          previous?.activeRide?.status != next.activeRide?.status) {
        _guide(next);
        final pos = next.position;
        if (pos != null) _followCamera(next, pos);
      }
      final ride = next.activeRide;
      if (ride != null &&
          ride.status == RideStatus.completed &&
          _ratedRideId != ride.id) {
        _ratedRideId = ride.id;
        RatingSheet.show(
          context,
          rideId: ride.id,
          counterpartyName: l10n.translate('driver.rider_rating'),
          isRatingDriver: false,
        );
      }

      if (next.offer != null && !_modalOpen) {
        _modalOpen = true;
        IncomingRideModal.show(
          context,
          offer: next.offer!,
          onAccept: () => ref.read(driverControllerProvider.notifier).acceptOffer(),
          onDecline: (reason) =>
              ref.read(driverControllerProvider.notifier).declineOffer(reason),
          onExpire: () => ref.read(driverControllerProvider.notifier).offerExpired(),
        ).whenComplete(() => _modalOpen = false);
      }
    });

    return Scaffold(
      body: Stack(
        children: [
          Listener(
            onPointerDown: (_) => _followPausedUntil =
                DateTime.now().add(const Duration(seconds: 12)),
            child: GoogleMap(
              // Rebuilt when the location permission arrives: Google's blue
              // dot is only switched on at map creation.
              key: ValueKey('driver-map-${state.locationGranted}'),
              initialCameraPosition: CameraPosition(
                target: state.position ?? kMapCenter,
                zoom: 16,
              ),
              onMapCreated: (c) {
                _map = c;
                final p = ref.read(driverControllerProvider).position;
                if (p != null) _followCamera(ref.read(driverControllerProvider), p);
              },
              markers: _markers(state),
              circles: _circles(state),
              polylines: {
                if (guide.hasRoute)
                  Polyline(
                    polylineId: const PolylineId('route'),
                    points: guide.points,
                    width: 7,
                    color: const Color(0xFF3A4BB8),
                    startCap: Cap.roundCap,
                    endCap: Cap.roundCap,
                    jointType: JointType.round,
                  ),
              },
              myLocationEnabled: state.locationGranted,
              myLocationButtonEnabled: false,
              zoomControlsEnabled: false,
              compassEnabled: false,
              padding: const EdgeInsets.only(bottom: 260, top: 90),
            ),
          ),

          SafeArea(child: _StatusBar(state: state)),

          if (guide.hasRoute && state.activeRide != null)
            Positioned(
              left: 12,
              right: 12,
              top: MediaQuery.of(context).padding.top + 64,
              child: _GuidanceCard(
                guide: guide,
                toPickup: state.activeRide!.status == RideStatus.accepted,
                destination: _target(state)?.$1,
              ),
            ),

          Positioned(
            right: 12,
            bottom: 290,
            child: FloatingActionButton.small(
              heroTag: 'recenter-driver',
              tooltip: l10n.translate('map.recenter'),
              onPressed: () => _recenter(state),
              child: const Icon(Icons.my_location),
            ),
          ),

          // Raised when the driver is within reach of the pickup or the
          // drop-off, with the one action that is due.
          if (state.arrivalKind != null)
            Positioned(
              left: 12,
              right: 12,
              top: MediaQuery.of(context).padding.top + 64,
              child: _ArrivalBanner(state: state),
            ),

          Align(
            alignment: Alignment.bottomCenter,
            child: state.activeRide != null
                ? _ActiveTripPanel(
                    ride: state.activeRide!,
                    others: state.otherRides,
                    busy: state.busy)
                : _IdlePanel(state: state),
          ),

          if (state.errorKey != null)
            Positioned(
              left: 16, right: 16, bottom: 280,
              child: Material(
                color: theme.colorScheme.error,
                borderRadius: BorderRadius.circular(12),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(14, 12, 6, 12),
                  child: Row(children: [
                    Expanded(
                      child: Text(
                        l10n.translate(state.errorKey!, params: {
                          'amount': formatMoney(state.debtCents),
                        }),
                        style: const TextStyle(color: Colors.white),
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.close, color: Colors.white),
                      onPressed: () => ref
                          .read(driverControllerProvider.notifier)
                          .clearError(),
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

class _ArrivalBanner extends ConsumerWidget {
  const _ArrivalBanner({required this.state});
  final DriverState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final controller = ref.read(driverControllerProvider.notifier);
    final pickup = state.arrivalKind == 'pickup';
    final who = state.activeRide?.riderName;

    return Material(
      color: KwemaColors.go,
      elevation: 6,
      borderRadius: BorderRadius.circular(16),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 8, 12),
        child: Row(children: [
          const Icon(Icons.notifications_active, color: Colors.white),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  l10n.translate(pickup ? 'driver.at_pickup' : 'driver.at_dropoff'),
                  style: theme.textTheme.titleSmall?.copyWith(
                      color: Colors.white, fontWeight: FontWeight.w800),
                ),
                if (pickup && who != null && who.isNotEmpty)
                  Text(
                    l10n.translate('driver.pickup_for', params: {'name': who}),
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: Colors.white),
                  ),
              ],
            ),
          ),
          // At the pickup the one action due is confirming arrival (which
          // tells the rider). At the drop-off the trip panel below has the
          // completion controls, including parcel handover codes, so the
          // banner only announces it.
          if (pickup)
            FilledButton(
              style: FilledButton.styleFrom(
                  minimumSize: const Size(0, 40),
                  backgroundColor: Colors.white,
                  foregroundColor: KwemaColors.go),
              onPressed: state.busy ? null : controller.markArrived,
              child: Text(l10n.translate('driver.at_pickup_btn')),
            ),
          IconButton(
            icon: const Icon(Icons.close, color: Colors.white, size: 20),
            onPressed: controller.dismissArrival,
          ),
        ]),
      ),
    );
  }
}

class _StatusBar extends ConsumerWidget {
  const _StatusBar({required this.state});
  final DriverState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    return Padding(
      padding: const EdgeInsets.all(12),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: state.isOnline ? KwemaColors.go : theme.colorScheme.surface,
              borderRadius: BorderRadius.circular(999),
              boxShadow: const [
                BoxShadow(color: Color(0x1A000000), blurRadius: 10)
              ],
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Container(
                width: 9, height: 9,
                decoration: BoxDecoration(
                  color: state.isOnline ? Colors.white : theme.colorScheme.outline,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 8),
              Text(
                l10n.translate(
                    state.isOnline ? 'driver.online' : 'driver.offline'),
                style: TextStyle(
                  fontWeight: FontWeight.w700,
                  color: state.isOnline ? Colors.white : theme.colorScheme.onSurface,
                ),
              ),
            ]),
          ),
          const Spacer(),
          const LanguagePill(),
          const SizedBox(width: 8),
          Material(
            color: theme.colorScheme.surface,
            shape: const CircleBorder(),
            child: IconButton(
              icon: const Icon(Icons.logout, size: 20),
              onPressed: () =>
                  ref.read(authControllerProvider.notifier).signOut(),
            ),
          ),
        ],
      ),
    );
  }
}

/// Distance and time to the next stop, with a hand-off to Google Maps for
/// spoken turn-by-turn directions.
class _GuidanceCard extends StatelessWidget {
  const _GuidanceCard({
    required this.guide,
    required this.toPickup,
    required this.destination,
  });

  final RouteGuideState guide;
  final bool toPickup;
  final LatLng? destination;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final km = guide.distanceM >= 1000
        ? '${(guide.distanceM / 1000).toStringAsFixed(1)} km'
        : '${guide.distanceM} m';
    final mins = (guide.durationS / 60).ceil().clamp(1, 999);

    return Material(
      color: theme.colorScheme.surface,
      elevation: 4,
      borderRadius: BorderRadius.circular(16),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
        child: Row(children: [
          Icon(toPickup ? Icons.person_pin_circle : Icons.flag,
              color: toPickup ? KwemaColors.go : theme.colorScheme.error),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                    l10n.translate(
                        toPickup ? 'nav.to_pickup' : 'nav.to_dropoff'),
                    style: theme.textTheme.bodySmall),
                Text('$mins min · $km',
                    style: theme.textTheme.titleMedium
                        ?.copyWith(fontWeight: FontWeight.w800)),
              ],
            ),
          ),
          if (destination != null)
            FilledButton.icon(
              // The app theme makes buttons full-width; inside a Row that
              // squeezed the text beside it to nothing.
              style: FilledButton.styleFrom(minimumSize: const Size(0, 44)),
              onPressed: () => openExternalNavigation(destination!),
              icon: const Icon(Icons.navigation, size: 18),
              label: Text(l10n.translate('nav.navigate')),
            ),
        ]),
      ),
    );
  }
}

class _IdlePanel extends ConsumerWidget {
  const _IdlePanel({required this.state});
  final DriverState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

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
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceAround,
                children: [
                  _Stat(
                    value: '${state.tripsToday}',
                    label: l10n.translate('driver.trips'),
                  ),
                  _Stat(
                    value: formatMoney(state.earnedTodayCents),
                    label: l10n.translate('driver.earnings'),
                    highlight: true,
                  ),
                ],
              ),

              // Cash-commission debt. Shown whenever money is owed, not only
              // when blocked — a driver should see it building, not discover
              // it when offers stop.
              if (state.debtCents > 0) ...[
                const SizedBox(height: 14),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: state.isBlocked
                        ? theme.colorScheme.error.withValues(alpha: 0.10)
                        : KwemaColors.marigold50,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        l10n.translate('driver.debt_warning',
                            params: {'amount': formatMoney(state.debtCents)}),
                        style: TextStyle(
                          color: state.isBlocked
                              ? theme.colorScheme.error
                              : KwemaColors.marigold700,
                          fontSize: 13,
                        ),
                      ),
                      const SizedBox(height: 8),
                      SizedBox(
                        height: 44,
                        child: FilledButton.icon(
                          style: FilledButton.styleFrom(
                              minimumSize: const Size(0, 44)),
                          onPressed: () => PayCommissionSheet.show(context),
                          icon: const Icon(Icons.payments_outlined, size: 18),
                          label: Text(l10n.translate('commission.pay_now')),
                        ),
                      ),
                    ],
                  ),
                ),
              ],

              const SizedBox(height: 16),
              // Available whenever the driver is online, not only on a trip.
              // Waiting alone at night is exactly when this is needed.
              if (state.isOnline) ...[
                const SosButton(compact: true),
                const SizedBox(height: 10),
              ],
              SizedBox(
                width: double.infinity,
                height: 60,
                child: state.isOnline
                    ? OutlinedButton(
                        onPressed: state.busy
                            ? null
                            : () => ref
                                .read(driverControllerProvider.notifier)
                                .goOffline(),
                        child: Text(l10n.translate('driver.go_offline'),
                            style: const TextStyle(fontSize: 17)),
                      )
                    : FilledButton(
                        onPressed: state.busy
                            ? null
                            : () => ref
                                .read(driverControllerProvider.notifier)
                                .goOnline(),
                        style: FilledButton.styleFrom(
                            backgroundColor: KwemaColors.go),
                        child: state.busy
                            ? const CircularProgressIndicator(
                                color: Colors.white, strokeWidth: 2.4)
                            : Text(l10n.translate('driver.go_online'),
                                style: const TextStyle(fontSize: 17)),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ActiveTripPanel extends ConsumerWidget {
  const _ActiveTripPanel({
    required this.ride,
    required this.busy,
    this.others = const [],
  });
  final Ride ride;
  final bool busy;

  /// Other passengers on this vehicle (shared trips).
  final List<Ride> others;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final controller = ref.read(driverControllerProvider.notifier);

    late final String labelKey;
    late final VoidCallback? action;

    switch (ride.status) {
      case RideStatus.accepted:
        labelKey = 'driver.arrived_btn';
        action = controller.markArrived;
        break;
      case RideStatus.arrived:
        labelKey = 'driver.start_btn';
        action = controller.startTrip;
        break;
      case RideStatus.inProgress:
        if (ride.serviceType.isDelivery) {
          // A delivery ends with a handover, not simply with arriving. The
          // code check happens before the trip is closed and the fare settled.
          labelKey = 'delivery.confirm';
          action = () async {
            final handed = await HandoverSheet.show(context, ride.id);
            if (handed) await controller.completeTrip();
          };
        } else {
          labelKey = 'driver.complete_btn';
          action = controller.completeTrip;
        }
        break;
      case RideStatus.completed:
        // Cash trips need explicit confirmation that the money changed hands.
        labelKey = ride.paymentMethod == 'cash'
            ? 'driver.cash_collected'
            : 'common.close';
        action = ride.paymentMethod == 'cash'
            ? controller.confirmCashCollected
            : controller.dismissTrip;
        break;
      default:
        labelKey = 'common.close';
        action = controller.dismissTrip;
    }

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
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                Icon(ride.serviceType.icon, size: 18,
                    color: theme.colorScheme.onSurfaceVariant),
                const SizedBox(width: 7),
                Text(l10n.translate(ride.serviceType.labelKey),
                    style: theme.textTheme.bodySmall),
              ]),
              if (others.isNotEmpty) ...[
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  children: [
                    for (final r in others)
                      ActionChip(
                        avatar: const Icon(Icons.person_outline, size: 18),
                        label: Text(
                          '${(r.riderName == null || r.riderName!.isEmpty) ? l10n.translate('pool.rider') : r.riderName!}'
                          ' · ${l10n.translate(r.status.i18nKey)}',
                        ),
                        onPressed: () => controller.focusRide(r.id),
                      ),
                  ],
                ),
              ],
              if (ride.isPool &&
                  ((ride.riderName ?? '').isNotEmpty ||
                      (ride.dropoffAddress ?? '').isNotEmpty)) ...[
                const SizedBox(height: 6),
                Text(
                  [
                    if ((ride.riderName ?? '').isNotEmpty) ride.riderName!,
                    if ((ride.pickupAddress ?? '').isNotEmpty ||
                        (ride.dropoffAddress ?? '').isNotEmpty)
                      '${ride.pickupAddress ?? ''} → ${ride.dropoffAddress ?? ''}',
                  ].join(' · '),
                  style: theme.textTheme.bodySmall,
                ),
              ],
              const SizedBox(height: 2),
              Text(l10n.translate(ride.status.i18nKey),
                  style: theme.textTheme.titleMedium),
              const SizedBox(height: 4),
              Text(formatMoney(ride.payableCents),
                  style: theme.textTheme.headlineSmall
                      ?.copyWith(color: KwemaColors.marigold600)),
              const SizedBox(height: 6),
              Row(children: [
                Icon(
                  ride.paymentMethod == 'cash'
                      ? Icons.payments_outlined
                      : Icons.smartphone,
                  size: 18,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: 6),
                Text(l10n.translate('payment.${ride.paymentMethod}')),
              ]),
              const SizedBox(height: 12),
              if (ride.status == RideStatus.accepted ||
                  ride.status == RideStatus.arrived ||
                  ride.status == RideStatus.inProgress) ...[
                SizedBox(
                  width: double.infinity,
                  child: OutlinedButton.icon(
                    onPressed: () => ContactSheet.show(context, ride.id,
                        peerName: ride.riderName),
                    icon: const Icon(Icons.chat_bubble_outline, size: 20),
                    label: Text(l10n.translate('contact.talk_rider')),
                  ),
                ),
                const SizedBox(height: 10),
              ],
              SosButton(rideId: ride.id, compact: true),

              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                height: 60,
                child: FilledButton(
                  onPressed: busy ? null : action,
                  child: Text(l10n.translate(labelKey),
                      style: const TextStyle(fontSize: 17)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.value, required this.label, this.highlight = false});
  final String value;
  final String label;
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(children: [
      Text(value,
          style: theme.textTheme.headlineSmall?.copyWith(
            fontWeight: FontWeight.w800,
            color: highlight ? KwemaColors.marigold600 : null,
          )),
      Text(label, style: theme.textTheme.bodySmall),
    ]);
  }
}
