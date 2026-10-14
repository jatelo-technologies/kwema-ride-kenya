/// Contact the other person on a trip: call, copy the number, or message.
///
/// Three ways, because people differ and networks differ:
///  * Call — opens the phone dialler with the real number (only returned by
///    the server for a live trip).
///  * Copy — puts the number on the clipboard to paste into the dialler,
///    WhatsApp or anywhere else.
///  * Message — in-app chat. Works on weak data where a call will not, and
///    leaves a record both sides can read back.
///
/// In-app voice calling (over the internet) needs a calling provider account
/// and is not part of this sheet; the Call button uses the normal network.
///
/// The thread refreshes every few seconds while the sheet is open. Polling is
/// deliberate: it needs no socket plumbing in this widget and costs a few
/// hundred bytes per tick.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/l10n/localization.dart';
import '../../core/network/api_client.dart';

class ContactSheet extends ConsumerStatefulWidget {
  const ContactSheet({super.key, required this.rideId});

  final String rideId;

  static Future<void> show(BuildContext context, String rideId) =>
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (_) => ContactSheet(rideId: rideId),
      );

  @override
  ConsumerState<ContactSheet> createState() => _ContactSheetState();
}

class _Msg {
  const _Msg(this.id, this.mine, this.body);
  final String id;
  final bool mine;
  final String body;
}

class _ContactSheetState extends ConsumerState<ContactSheet> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  List<_Msg> _messages = const [];
  String? _name;
  String? _phone;
  String? _error;
  bool _sending = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _loadContact();
    _refresh();
    _timer = Timer.periodic(const Duration(seconds: 4), (_) => _refresh());
  }

  @override
  void dispose() {
    _timer?.cancel();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _loadContact() async {
    try {
      final res = await ref
          .read(apiClientProvider)
          .get('/rides/${widget.rideId}/contact');
      if (!mounted) return;
      setState(() {
        _name = (res as Map)['name']?.toString();
        _phone = res['phone']?.toString();
      });
    } catch (_) {
      // Not available (trip not live yet). Messaging may still work.
    }
  }

  Future<void> _refresh() async {
    try {
      final res = await ref
          .read(apiClientProvider)
          .get('/rides/${widget.rideId}/messages');
      if (!mounted) return;
      final list = (res as List)
          .map((e) => _Msg(
                (e as Map)['id'].toString(),
                e['mine'] == true,
                e['body'].toString(),
              ))
          .toList();
      final grew = list.length != _messages.length;
      setState(() {
        _messages = list;
        _error = null;
      });
      if (grew) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (_scroll.hasClients) {
            _scroll.jumpTo(_scroll.position.maxScrollExtent);
          }
        });
      }
    } catch (_) {
      // Keep the last thread on screen; a blip should not blank the chat.
    }
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      await ref
          .read(apiClientProvider)
          .post('/rides/${widget.rideId}/messages', {'body': text});
      _input.clear();
      await _refresh();
    } catch (_) {
      if (mounted) setState(() => _error = 'contact.closed');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final insets = MediaQuery.of(context).viewInsets.bottom;

    return Padding(
      padding: EdgeInsets.only(bottom: insets),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.62,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
          child: Column(
            children: [
              Row(children: [
                Expanded(
                  child: Text(
                    _name ?? l10n.translate('contact.title'),
                    style: theme.textTheme.titleLarge
                        ?.copyWith(fontWeight: FontWeight.w700),
                  ),
                ),
                if (_phone != null) ...[
                  IconButton.filled(
                    tooltip: l10n.translate('contact.call'),
                    icon: const Icon(Icons.phone, size: 20),
                    onPressed: () => launchUrl(Uri.parse('tel:$_phone')),
                  ),
                  const SizedBox(width: 8),
                  IconButton.outlined(
                    tooltip: l10n.translate('contact.copy'),
                    icon: const Icon(Icons.copy, size: 20),
                    onPressed: () async {
                      await Clipboard.setData(ClipboardData(text: _phone!));
                      if (!context.mounted) return;
                      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                          content: Text(l10n.translate('contact.copied'))));
                    },
                  ),
                ],
              ]),
              const SizedBox(height: 8),
              Expanded(
                child: _messages.isEmpty
                    ? Center(
                        child: Text(l10n.translate('contact.empty'),
                            style: theme.textTheme.bodyMedium?.copyWith(
                                color: theme.colorScheme.onSurfaceVariant)))
                    : ListView.builder(
                        controller: _scroll,
                        itemCount: _messages.length,
                        itemBuilder: (_, i) {
                          final m = _messages[i];
                          return Align(
                            alignment: m.mine
                                ? Alignment.centerRight
                                : Alignment.centerLeft,
                            child: Container(
                              margin: const EdgeInsets.symmetric(vertical: 3),
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 14, vertical: 10),
                              constraints: BoxConstraints(
                                  maxWidth:
                                      MediaQuery.of(context).size.width * 0.75),
                              decoration: BoxDecoration(
                                color: m.mine
                                    ? theme.colorScheme.primary
                                    : theme.colorScheme.surfaceContainerHighest,
                                borderRadius: BorderRadius.circular(16),
                              ),
                              child: Text(
                                m.body,
                                style: TextStyle(
                                    color: m.mine
                                        ? theme.colorScheme.onPrimary
                                        : theme.colorScheme.onSurface),
                              ),
                            ),
                          );
                        },
                      ),
              ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Text(l10n.translate(_error!),
                      style: TextStyle(color: theme.colorScheme.error)),
                ),
              Row(children: [
                Expanded(
                  child: TextField(
                    controller: _input,
                    maxLength: 500,
                    maxLines: 1,
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) => _send(),
                    decoration: InputDecoration(
                      counterText: '',
                      hintText: l10n.translate('contact.message_hint'),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton.filled(
                  tooltip: l10n.translate('contact.send'),
                  icon: const Icon(Icons.send, size: 20),
                  onPressed: _sending ? null : _send,
                ),
              ]),
            ],
          ),
        ),
      ),
    );
  }
}
