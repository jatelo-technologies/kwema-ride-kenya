/// Car-pooling controls on the rider's booking sheet.
///
/// Pooling is an extra option beside riding alone, never a replacement: the
/// default is "alone", the solo price stays on screen, and the shared price is
/// shown as a range because the discount depends on how many people actually
/// end up in the car.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/l10n/localization.dart';
import '../../core/models/models.dart';
import '../../core/format/money.dart';
import 'rider_controller.dart';

class PoolSection extends ConsumerWidget {
  const PoolSection({super.key, required this.state});

  final RiderState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final preview = state.selected?.poolPreview;
    if (!state.canPool || preview == null) return const SizedBox.shrink();

    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final controller = ref.read(riderControllerProvider.notifier);

    Widget option(String mode, String labelKey) {
      final on = state.poolMode == mode;
      return Expanded(
        child: Padding(
          padding: const EdgeInsets.only(right: 8),
          child: GestureDetector(
            onTap: () => controller.setPoolMode(mode),
            child: Container(
              padding: const EdgeInsets.symmetric(vertical: 11, horizontal: 4),
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
                  l10n.translate(labelKey),
                  textAlign: TextAlign.center,
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
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 12),
        Text(l10n.translate('pool.title'),
            style: theme.textTheme.bodySmall
                ?.copyWith(fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        Row(children: [
          option('off', 'pool.alone'),
          option('match', 'pool.share'),
          option('host', 'pool.host'),
        ]),
        if (state.poolMode != 'off') ...[
          const SizedBox(height: 8),
          Text(
            l10n.translate('pool.price', params: {
              'shared': formatMoney(preview.sharedFareCents),
              'best': formatMoney(preview.bestFareCents),
              'solo': formatMoney(state.selected!.totalFareCents),
            }),
            style: theme.textTheme.bodyMedium
                ?.copyWith(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 4),
          Text(
            l10n.translate(
                state.poolMode == 'host' ? 'pool.note_host' : 'pool.note_match',
                params: {'seats': '${preview.seats}'}),
            style: theme.textTheme.bodySmall,
          ),
          const SizedBox(height: 4),
          Text(l10n.translate('pool.fair'), style: theme.textTheme.bodySmall),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: () {
              controller.loadPoolTrips();
              PoolBrowseSheet.show(context);
            },
            icon: const Icon(Icons.groups_outlined, size: 18),
            label: Text(l10n.translate('pool.browse')),
          ),
        ],
      ],
    );
  }
}

/// Shared trips going the same way. Joining one books the rider onto it with
/// the same quote and payment they already chose.
class PoolBrowseSheet extends ConsumerWidget {
  const PoolBrowseSheet({super.key});

  static Future<void> show(BuildContext context) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => const PoolBrowseSheet(),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final state = ref.watch(riderControllerProvider);
    final controller = ref.read(riderControllerProvider.notifier);

    // Once the ride exists the sheet has done its job.
    if (state.ride != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (context.mounted && Navigator.of(context).canPop()) {
          Navigator.of(context).pop();
        }
      });
    }

    Widget body;
    if (state.isBrowsingPool && state.poolTrips.isEmpty) {
      body = const Padding(
        padding: EdgeInsets.all(32),
        child: Center(child: CircularProgressIndicator()),
      );
    } else if (state.poolTrips.isEmpty) {
      body = Padding(
        padding: const EdgeInsets.all(24),
        child: Text(l10n.translate('pool.none'), textAlign: TextAlign.center),
      );
    } else {
      body = ListView.separated(
        shrinkWrap: true,
        itemCount: state.poolTrips.length,
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (context, i) {
          final t = state.poolTrips[i];
          return ListTile(
            leading: const Icon(Icons.groups_outlined),
            title: Text(
              '${t.hostFirstName} · ${t.fromArea} → ${t.toArea}',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
            subtitle: Text(
              '${l10n.translate('pool.seats_left', params: {'n': '${t.seatsLeft}'})}'
              ' · ${l10n.translate(t.hasDriver ? 'pool.on_road' : 'pool.waiting')}',
            ),
            trailing: FilledButton(
              onPressed: state.isRequesting
                  ? null
                  : () => controller.joinPoolTrip(t),
              child: Text(l10n.translate('pool.join')),
            ),
          );
        },
      );
    }

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
            maxHeight: MediaQuery.of(context).size.height * 0.7),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Text(l10n.translate('pool.browse'),
                  style: theme.textTheme.titleMedium),
            ),
            Flexible(child: body),
          ],
        ),
      ),
    );
  }
}
