/// Live trip sharing.
///
/// Creates a tracking link for the current trip and sends it on WhatsApp or
/// by SMS. Whoever opens it watches the vehicle move on a map, with the
/// driver, car and plate, until the trip ends. No app or account needed on
/// their side.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/l10n/localization.dart';
import '../../core/network/api_client.dart';

class ShareTripButton extends ConsumerStatefulWidget {
  const ShareTripButton({super.key, required this.rideId});

  final String rideId;

  @override
  ConsumerState<ShareTripButton> createState() => _ShareTripButtonState();
}

class _ShareTripButtonState extends ConsumerState<ShareTripButton> {
  bool _loading = false;

  Future<void> _share() async {
    final l10n = AppLocalizations.of(context);
    setState(() => _loading = true);
    Map<String, dynamic>? link;
    try {
      final res = await ref.read(apiClientProvider).post('/rides/${widget.rideId}/share');
      link = Map<String, dynamic>.from(res as Map);
    } catch (_) {
      link = null;
    }
    if (!mounted) return;
    setState(() => _loading = false);

    if (link == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.translate('share.failed'))),
      );
      return;
    }
    final text = link['text']?.toString() ?? '';
    final url = link['url']?.toString() ?? '';
    final wa = link['whatsappUrl']?.toString() ?? '';
    final sms = link['smsUrl']?.toString() ?? '';

    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(l10n.translate('share.title'),
                  style: Theme.of(sheet).textTheme.titleLarge),
              const SizedBox(height: 6),
              Text(l10n.translate('share.body')),
              const SizedBox(height: 18),
              FilledButton.icon(
                icon: const Icon(Icons.chat),
                label: Text(l10n.translate('share.whatsapp')),
                onPressed: () async {
                  Navigator.pop(sheet);
                  final ok = await launchUrl(Uri.parse(wa), mode: LaunchMode.externalApplication);
                  if (!ok) await Clipboard.setData(ClipboardData(text: text));
                },
              ),
              const SizedBox(height: 10),
              OutlinedButton.icon(
                icon: const Icon(Icons.sms_outlined),
                label: Text(l10n.translate('share.sms')),
                onPressed: () async {
                  Navigator.pop(sheet);
                  await launchUrl(Uri.parse(sms));
                },
              ),
              const SizedBox(height: 10),
              TextButton.icon(
                icon: const Icon(Icons.link),
                label: Text(l10n.translate('share.copy')),
                onPressed: () async {
                  await Clipboard.setData(ClipboardData(text: url));
                  if (!sheet.mounted) return;
                  Navigator.pop(sheet);
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text(l10n.translate('share.copied'))),
                  );
                },
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return OutlinedButton.icon(
      onPressed: _loading ? null : _share,
      icon: _loading
          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
          : const Icon(Icons.share_location),
      label: Text(l10n.translate('share.btn')),
      style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
    );
  }
}
