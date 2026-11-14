/// Call banner shown above whichever screen the person is on: an incoming
/// call to answer or decline, a call being placed, and the in-call controls.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/comms/call_controller.dart';
import '../../core/l10n/localization.dart';

class CallOverlay extends ConsumerWidget {
  const CallOverlay({super.key});

  String _clock(int s) =>
      '${(s ~/ 60).toString().padLeft(2, '0')}:${(s % 60).toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final call = ref.watch(callControllerProvider);
    final c = ref.read(callControllerProvider.notifier);
    final l10n = AppLocalizations.of(context);
    final name = call.peerName ?? l10n.translate('contact.title');

    Widget? body;
    Color colour = const Color(0xFF1E7A4C);

    switch (call.phase) {
      case CallPhase.idle:
        if (call.errorKey != null) {
          colour = const Color(0xFFB3261E);
          body = Row(children: [
            Expanded(
              child: Text(l10n.translate(call.errorKey!),
                  style: const TextStyle(color: Colors.white)),
            ),
            IconButton(
                icon: const Icon(Icons.close, color: Colors.white),
                onPressed: c.clearError),
          ]);
        }
        break;
      case CallPhase.ringing:
        body = Row(children: [
          const Icon(Icons.call, color: Colors.white),
          const SizedBox(width: 10),
          Expanded(
            child: Text('${l10n.translate('call.incoming')}\n$name',
                style: const TextStyle(
                    color: Colors.white, fontWeight: FontWeight.w700)),
          ),
          IconButton.filled(
            style: IconButton.styleFrom(backgroundColor: const Color(0xFFB3261E)),
            icon: const Icon(Icons.call_end),
            onPressed: c.reject,
          ),
          const SizedBox(width: 8),
          IconButton.filled(
            style: IconButton.styleFrom(backgroundColor: Colors.white),
            icon: const Icon(Icons.call, color: Color(0xFF1E7A4C)),
            onPressed: c.accept,
          ),
        ]);
        break;
      case CallPhase.calling:
      case CallPhase.connecting:
        body = Row(children: [
          const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(
                  strokeWidth: 2, color: Colors.white)),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
                '${l10n.translate(call.phase == CallPhase.calling ? 'call.calling' : 'call.connecting')} · $name',
                style: const TextStyle(color: Colors.white)),
          ),
          IconButton.filled(
            style: IconButton.styleFrom(backgroundColor: const Color(0xFFB3261E)),
            icon: const Icon(Icons.call_end),
            onPressed: c.hangUp,
          ),
        ]);
        break;
      case CallPhase.active:
        body = Row(children: [
          Expanded(
            child: Text('$name · ${_clock(call.seconds)}',
                style: const TextStyle(
                    color: Colors.white, fontWeight: FontWeight.w700)),
          ),
          IconButton(
            icon: Icon(call.muted ? Icons.mic_off : Icons.mic,
                color: Colors.white),
            onPressed: c.toggleMute,
          ),
          IconButton(
            icon: Icon(call.speaker ? Icons.volume_up : Icons.volume_down,
                color: Colors.white),
            onPressed: c.toggleSpeaker,
          ),
          IconButton.filled(
            style: IconButton.styleFrom(backgroundColor: const Color(0xFFB3261E)),
            icon: const Icon(Icons.call_end),
            onPressed: c.hangUp,
          ),
        ]);
        break;
    }

    if (body == null) return const SizedBox.shrink();

    return SafeArea(
      child: Material(
        color: colour,
        borderRadius: BorderRadius.circular(16),
        elevation: 6,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          child: body,
        ),
      ),
    );
  }
}
