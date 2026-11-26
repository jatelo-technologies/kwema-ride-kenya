/// Live trip panel: status, driver details, and payment on completion.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:geolocator/geolocator.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/format/money.dart';
import '../shared/contact_sheet.dart';
import '../../core/l10n/localization.dart';
import '../../core/models/models.dart';
import '../../core/theme/app_theme.dart';
import 'rider_controller.dart';
import '../shared/sos_button.dart';
import '../shared/share_trip_button.dart';
import '../shared/profile_photo.dart';
import '../../core/country_config.dart';

class RideTrackingSheet extends ConsumerWidget {
  const RideTrackingSheet({super.key, required this.ride});
  final Ride ride;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final controller = ref.read(riderControllerProvider.notifier);
    final rs = ref.watch(riderControllerProvider);
    final searching = ride.status == RideStatus.searching ||
        ride.status == RideStatus.requested;
    final open = rs.activeRides;
    final driverAt = rs.driverPositions[ride.id];
    final target = ride.status == RideStatus.inProgress
        ? ride.dropoffLatLng
        : ride.pickupLatLng;
    final awayM = (driverAt != null &&
            target != null &&
            (ride.status == RideStatus.accepted ||
                ride.status == RideStatus.inProgress))
        ? Geolocator.distanceBetween(driverAt.latitude, driverAt.longitude,
                target.latitude, target.longitude)
            .round()
        : null;

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
             maxHeight: MediaQuery.of(context).size.height * 0.62),
         child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Several rides at once: switch between them here.
              if (rs.rides.length > 1) ...[
                SizedBox(
                  height: 44,
                  child: ListView(
                    scrollDirection: Axis.horizontal,
                    children: [
                      for (final r in rs.rides.values)
                        Padding(
                          padding: const EdgeInsets.only(right: 8),
                          child: ChoiceChip(
                            selected: r.id == ride.id,
                            avatar: Icon(
                                r.status.isTerminal
                                    ? Icons.check_circle_outline
                                    : Icons.directions_car,
                                size: 16),
                            label: Text(
                              '${r.forOther ? r.passengerName : l10n.translate('ride.me')}'
                              ' · ${l10n.translate(r.status.i18nKey)}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            onSelected: (_) => controller.focusRide(r.id),
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 10),
              ],

              if (ride.forOther) ...[
                Row(children: [
                  Icon(Icons.person_pin_circle_outlined, size: 18,
                      color: theme.colorScheme.primary),
                  const SizedBox(width: 6),
                  Text(
                    l10n.translate('ride.for_name',
                        params: {'name': ride.passengerName ?? ''}),
                    style: theme.textTheme.bodyMedium
                        ?.copyWith(fontWeight: FontWeight.w700),
                  ),
                ]),
                const SizedBox(height: 6),
              ],

              Row(children: [
                if (searching)
                  const SizedBox(
                    width: 20, height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2.4),
                  ),
                if (searching) const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    l10n.translate(ride.status.i18nKey),
                    style: theme.textTheme.titleLarge
                        ?.copyWith(fontWeight: FontWeight.w700),
                  ),
                ),
                if (ride.etaSeconds != null && ride.etaSeconds! > 0)
                  Text(
                    l10n.translate('rider.eta_min',
                        params: {'min': '${(ride.etaSeconds! / 60).ceil()}'}),
                    style: theme.textTheme.titleMedium
                        ?.copyWith(color: theme.colorScheme.primary),
                  ),
              ]),

              if (ride.status == RideStatus.arrived) ...[
                const SizedBox(height: 12),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: KwemaColors.go.withValues(alpha: 0.14),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Row(children: [
                    const Icon(Icons.notifications_active,
                        color: KwemaColors.go),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        l10n.translate('ride.driver_here'),
                        style: theme.textTheme.titleSmall
                            ?.copyWith(fontWeight: FontWeight.w800),
                      ),
                    ),
                  ]),
                ),
              ] else if (awayM != null) ...[
                const SizedBox(height: 6),
                Text(
                  l10n.translate(
                      ride.status == RideStatus.inProgress
                          ? 'ride.to_destination'
                          : 'ride.driver_away',
                      params: {
                        'dist': awayM >= 1000
                            ? '${(awayM / 1000).toStringAsFixed(1)} km'
                            : '$awayM m'
                      }),
                  style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.primary,
                      fontWeight: FontWeight.w700),
                ),
              ],

              // The sender reads this to the recipient, who quotes it to the
              // courier. Shown prominently because it is useless if missed.
              if (ride.deliveryCode != null && !ride.status.isTerminal) ...[
                const SizedBox(height: 14),
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: KwemaColors.marigold50,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: KwemaColors.marigold300),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(l10n.translate('delivery.code'),
                          style: theme.textTheme.bodySmall
                              ?.copyWith(color: KwemaColors.marigold700)),
                      Text(
                        ride.deliveryCode!,
                        style: theme.textTheme.headlineMedium?.copyWith(
                          fontWeight: FontWeight.w800,
                          letterSpacing: 8,
                          color: KwemaColors.marigold700,
                        ),
                      ),
                      Text(l10n.translate('delivery.code_hint'),
                          style: theme.textTheme.bodySmall
                              ?.copyWith(color: KwemaColors.marigold700)),
                    ],
                  ),
                ),
              ],

              if (ride.reference.isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(ride.reference, style: theme.textTheme.bodySmall),
              ],

              if (ride.isPool && !ride.status.isTerminal) ...[
                const SizedBox(height: 10),
                Row(children: [
                  Icon(Icons.groups_outlined, size: 18,
                      color: theme.colorScheme.primary),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      ride.poolCoRiders > 0
                          ? l10n.translate('pool.sharing',
                              params: {'n': '${ride.poolCoRiders}'})
                          : l10n.translate('pool.waiting_riders'),
                      style: theme.textTheme.bodyMedium
                          ?.copyWith(fontWeight: FontWeight.w600),
                    ),
                  ),
                ]),
              ],

              if (ride.driver != null) ...[
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.primaryContainer,
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Row(children: [
                    ProfilePhoto(
                      name: ride.driver!.name,
                      photoUrl: ride.driver!.photoUrl,
                      radius: 30,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(ride.driver!.name,
                              style: theme.textTheme.titleMedium
                                  ?.copyWith(fontWeight: FontWeight.w800)),
                          Text(
                            '★ ${ride.driver!.rating.toStringAsFixed(1)}'
                            '${ride.driver!.trips > 0 ? ' · ${l10n.translate('ride.trips', params: {'n': '${ride.driver!.trips}'})}' : ''}',
                            style: theme.textTheme.bodySmall,
                          ),
                          if (ride.vehicle != null) ...[
                            const SizedBox(height: 4),
                            Text(
                              '${ride.vehicle!.colour} ${ride.vehicle!.make} '
                              '${ride.vehicle!.model}',
                              style: theme.textTheme.bodyMedium
                                  ?.copyWith(fontWeight: FontWeight.w600),
                            ),
                            const SizedBox(height: 4),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 10, vertical: 3),
                              decoration: BoxDecoration(
                                color: theme.colorScheme.surface,
                                border: Border.all(
                                    color: theme.colorScheme.onSurface,
                                    width: 1.6),
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: Text(
                                ride.vehicle!.plate,
                                style: theme.textTheme.titleMedium?.copyWith(
                                    fontWeight: FontWeight.w900,
                                    letterSpacing: 1.5),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    // Talk to the driver inside the app (messages or an
                    // audio call). The driver's phone number is never shown.
                    if (ride.status == RideStatus.accepted ||
                        ride.status == RideStatus.arrived ||
                        ride.status == RideStatus.inProgress)
                      IconButton.filled(
                        tooltip: l10n.translate('contact.talk_driver'),
                        icon: const Icon(Icons.chat_bubble_outline, size: 20),
                        onPressed: () => ContactSheet.show(context, ride.id,
                            peerName: ride.driver!.name),
                      ),
                  ]),
                ),
              ],

              const SizedBox(height: 16),
              Row(children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(l10n.translate('rider.estimated_fare'),
                          style: theme.textTheme.bodySmall),
                      Text(formatMoney(ride.payableCents),
                          style: theme.textTheme.headlineSmall
                              ?.copyWith(fontWeight: FontWeight.w800)),
                    ],
                  ),
                ),
                Chip(label: Text(l10n.translate('payment.${ride.paymentMethod}'))),
              ]),

              if (ride.status == RideStatus.completed &&
                  ride.poolDiscountCents > 0) ...[
                const SizedBox(height: 8),
                Text(
                  l10n.translate('pool.saved',
                      params: {'amount': formatMoney(ride.poolDiscountCents)}),
                  style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.primary,
                      fontWeight: FontWeight.w700),
                ),
              ],

              // Available for the whole trip, not only when something has
              // already gone wrong.
              if (!ride.status.isTerminal) ...[
                const SizedBox(height: 12),
                ShareTripButton(rideId: ride.id),
                const SizedBox(height: 10),
                Row(children: [
                  Expanded(child: SosButton(rideId: ride.id, compact: true)),
                ]),
              ],

              const SizedBox(height: 14),

              if (ride.status == RideStatus.completed && !ride.isPaid &&
                  ride.paymentMethod != 'cash')
                SizedBox(
                  width: double.infinity, height: 56,
                  child: FilledButton(
                    onPressed: () async {
                      // Mobile money needs a wallet choice; card goes straight
                      // to the hosted page.
                      String? wallet;
                      if (ride.paymentMethod != 'card') {
                        wallet = await _pickWallet(context, l10n);
                        if (wallet == null) return;
                      }
                      final url = await controller.payNow(
                          mno: wallet ?? kDefaultWallet);
                      // Card payments open the provider's hosted 3-D Secure
                      // page. Card fields are never rendered by this app,
                      // which is what keeps it out of PCI scope.
                      if (url != null) {
                        await launchUrl(Uri.parse(url),
                            mode: LaunchMode.externalApplication);
                      }
                    },
                    child: Text(l10n.translate('rider.pay_now')),
                  ),
                )
              else if (ride.status.isTerminal || ride.isPaid)
                SizedBox(
                  width: double.infinity, height: 56,
                  child: FilledButton(
                    onPressed: controller.dismissRide,
                    child: Text(l10n.translate('common.close')),
                  ),
                )
              else
                SizedBox(
                  width: double.infinity, height: 52,
                  child: OutlinedButton(
                    onPressed: () => _confirmCancel(context, ref, l10n),
                    style: OutlinedButton.styleFrom(
                        foregroundColor: theme.colorScheme.error),
                    child: Text(l10n.translate('rider.cancel')),
                  ),
                ),

              if (ride.isPaid) ...[
                const SizedBox(height: 8),
                Row(children: [
                  const Icon(Icons.check_circle, color: KwemaColors.go, size: 18),
                  const SizedBox(width: 6),
                  Text(l10n.translate('payment.success'),
                      style: const TextStyle(color: KwemaColors.go)),
                ]),
              ],

              // Booking again never waits for anything: not for payment, not
              // for the rating, not for another ride to finish.
              const SizedBox(height: 10),
              SizedBox(
                width: double.infinity, height: 48,
                child: OutlinedButton.icon(
                  icon: const Icon(Icons.add_road),
                  onPressed: ride.status.isTerminal
                      ? controller.requestAnother
                      : controller.startAnotherRide,
                  label: Text(l10n.translate('ride.another')),
                ),
              ),
              if (open.length > 1 || (open.isNotEmpty && ride.status.isTerminal))
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    l10n.translate('ride.open_count',
                        params: {'n': '${open.length}'}),
                    style: theme.textTheme.bodySmall,
                    textAlign: TextAlign.center,
                  ),
                ),
            ],
          ),
         ),
        ),
      ),
    );
  }

  /// Cancelling after a driver has committed time may carry a fee, so it
  /// asks first rather than firing on a mis-tap.
  Future<void> _confirmCancel(
      BuildContext context, WidgetRef ref, AppLocalizations l10n) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l10n.translate('rider.cancel')),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(l10n.translate('common.close')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(l10n.translate('rider.cancel')),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await ref.read(riderControllerProvider.notifier).cancelRide();
    }
  }
}

/// Asks which mobile money wallet to charge. Returns the wire value
/// (one of [kWallets]), or null if the rider dismisses the sheet.
Future<String?> _pickWallet(BuildContext context, AppLocalizations l10n) {
  return showModalBottomSheet<String>(
    context: context,
    showDragHandle: true,
    builder: (ctx) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l10n.translate('payment.select_network'),
                style: Theme.of(ctx)
                    .textTheme
                    .titleLarge
                    ?.copyWith(fontWeight: FontWeight.w700)),
            const SizedBox(height: 12),
            for (final w in kWallets)
              ListTile(
                leading: const Icon(Icons.account_balance_wallet_outlined),
                title: Text(w.label),
                subtitle: Text(w.operator),
                onTap: () => Navigator.of(ctx).pop(w.wire),
              ),
          ],
        ),
      ),
    ),
  );
}
