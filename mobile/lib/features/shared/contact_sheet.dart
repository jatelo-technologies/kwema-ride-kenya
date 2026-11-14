/// Talk to the other person on a live trip, inside the app.
///
/// Text messages and an audio call, and nothing else: no phone numbers are
/// shown or exchanged, and both stop being available when the trip ends. The
/// thread updates live over the realtime socket, with a slow poll underneath
/// so a missed socket event never leaves the chat stale.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/comms/call_controller.dart';
import '../../core/l10n/localization.dart';
import '../../core/network/api_client.dart';
import '../rider/rider_controller.dart' show socketClientProvider;

class ContactSheet extends ConsumerStatefulWidget {
  const ContactSheet({super.key, required this.rideId, this.peerName});

  final String rideId;
  final String? peerName;

  static Future<void> show(BuildContext context, String rideId,
          {String? peerName}) =>
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (_) => ContactSheet(rideId: rideId, peerName: peerName),
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
  String? _error;
  bool _sending = false;
  bool _live = true;
  Timer? _timer;
  StreamSubscription<Map<String, dynamic>>? _sub;

  @override
  void initState() {
    super.initState();
    _name = widget.peerName;
    _loadPeer();
    _refresh();
    _timer = Timer.periodic(const Duration(seconds: 8), (_) => _refresh());
    _sub = ref.read(socketClientProvider).messages.listen((m) {
      if (m['rideId']?.toString() == widget.rideId) _refresh();
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _sub?.cancel();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _loadPeer() async {
    try {
      final res = await ref
          .read(apiClientProvider)
          .get('/rides/${widget.rideId}/counterpart');
      if (!mounted) return;
      setState(() {
        _name = (res as Map)['name']?.toString() ?? _name;
        _live = res['live'] == true;
      });
    } catch (_) {}
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
    // The auth provider is watched so the sheet closes with a sign-out.
    ref.watch(authControllerProvider);
    final call = ref.watch(callControllerProvider);

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
                IconButton.filled(
                  tooltip: l10n.translate('contact.call'),
                  icon: const Icon(Icons.call, size: 20),
                  onPressed: (!_live || call.busy)
                      ? null
                      : () {
                          ref
                              .read(callControllerProvider.notifier)
                              .start(widget.rideId, peerName: _name);
                          Navigator.of(context).pop();
                        },
                ),
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
                    enabled: _live,
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
                  onPressed: (_sending || !_live) ? null : _send,
                ),
              ]),
            ],
          ),
        ),
      ),
    );
  }
}
