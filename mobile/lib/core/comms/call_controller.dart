/// In-app audio calls between a rider and their driver.
///
/// The only voice channel between the two people is this one: no phone
/// numbers are exchanged and nothing is dialled over the mobile network. The
/// call is peer-to-peer WebRTC audio; the server only relays the small
/// set-up messages ("signals") and only while the trip is live.
///
/// Protocol (identical on the web booking page):
///   caller  -> invite
///   callee  -> accept | reject | busy
///   caller  -> offer          (after accept)
///   callee  -> answer
///   both    -> ice            (as candidates are found)
///   either  -> end

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:permission_handler/permission_handler.dart';

import '../network/api_client.dart';
import '../network/socket_client.dart';
import '../../features/rider/rider_controller.dart' show socketClientProvider;

enum CallPhase { idle, calling, ringing, connecting, active }

class CallState {
  const CallState({
    this.phase = CallPhase.idle,
    this.rideId,
    this.peerName,
    this.muted = false,
    this.speaker = false,
    this.seconds = 0,
    this.errorKey,
  });

  final CallPhase phase;
  final String? rideId;
  final String? peerName;
  final bool muted;
  final bool speaker;
  final int seconds;
  final String? errorKey;

  bool get busy => phase != CallPhase.idle;

  CallState copyWith({
    CallPhase? phase, String? rideId, String? peerName, bool? muted,
    bool? speaker, int? seconds, String? errorKey, bool clearError = false,
  }) => CallState(
        phase: phase ?? this.phase,
        rideId: rideId ?? this.rideId,
        peerName: peerName ?? this.peerName,
        muted: muted ?? this.muted,
        speaker: speaker ?? this.speaker,
        seconds: seconds ?? this.seconds,
        errorKey: clearError ? null : (errorKey ?? this.errorKey),
      );
}

class CallController extends StateNotifier<CallState> {
  CallController(this._api, this._socket) : super(const CallState()) {
    _sub = _socket.callSignals.listen(_onSignal);
  }

  final ApiClient _api;
  final SocketClient _socket;
  StreamSubscription<Map<String, dynamic>>? _sub;

  RTCPeerConnection? _pc;
  MediaStream? _local;
  final List<RTCIceCandidate> _pendingIce = [];
  bool _remoteSet = false;
  Timer? _ringTimer;
  Timer? _clock;
  Timer? _alert;

  // -----------------------------------------------------------------
  // Outgoing
  // -----------------------------------------------------------------

  Future<void> start(String rideId, {String? peerName}) async {
    if (state.busy) return;
    state = CallState(
        phase: CallPhase.calling, rideId: rideId, peerName: peerName);
    try {
      await _preparePeer(rideId);
      await _signal('invite');
      _ringTimer = Timer(const Duration(seconds: 45), () {
        if (state.phase == CallPhase.calling) hangUp();
      });
    } catch (e) {
      debugPrint('call start failed: $e');
      await _teardown(errorKey: 'call.failed');
    }
  }

  // -----------------------------------------------------------------
  // Incoming
  // -----------------------------------------------------------------

  Future<void> accept() async {
    final rideId = state.rideId;
    if (state.phase != CallPhase.ringing || rideId == null) return;
    _stopAlert();
    state = state.copyWith(phase: CallPhase.connecting);
    try {
      await _preparePeer(rideId);
      await _signal('accept');
    } catch (e) {
      debugPrint('call accept failed: $e');
      await _signal('reject');
      await _teardown(errorKey: 'call.failed');
    }
  }

  Future<void> reject() async {
    if (state.phase != CallPhase.ringing) return;
    await _signal('reject');
    await _teardown();
  }

  Future<void> hangUp() async {
    if (!state.busy) return;
    await _signal('end');
    await _teardown();
  }

  // -----------------------------------------------------------------
  // In-call controls
  // -----------------------------------------------------------------

  void toggleMute() {
    final next = !state.muted;
    for (final t in _local?.getAudioTracks() ?? <MediaStreamTrack>[]) {
      t.enabled = !next;
    }
    state = state.copyWith(muted: next);
  }

  Future<void> toggleSpeaker() async {
    final next = !state.speaker;
    try {
      await Helper.setSpeakerphoneOn(next);
    } catch (_) {}
    state = state.copyWith(speaker: next);
  }

  void clearError() => state = state.copyWith(clearError: true);

  // -----------------------------------------------------------------
  // Signalling
  // -----------------------------------------------------------------

  Future<void> _signal(String type, [Object? data]) async {
    final rideId = state.rideId;
    if (rideId == null) return;
    await _socket.emitWithAck('call:signal', {
      'rideId': rideId,
      'type': type,
      if (data != null) 'data': data,
    });
  }

  Future<void> _onSignal(Map<String, dynamic> m) async {
    final type = m['type']?.toString();
    final rideId = m['rideId']?.toString();
    if (type == null || rideId == null) return;

    if (type == 'invite') {
      if (state.busy) {
        // Already on a call: tell the other side rather than leave it ringing.
        await _socket.emitWithAck(
            'call:signal', {'rideId': rideId, 'type': 'busy'});
        return;
      }
      String? name;
      try {
        final res = await _api.get('/rides/$rideId/counterpart');
        name = (res as Map)['name']?.toString();
      } catch (_) {}
      state = CallState(
          phase: CallPhase.ringing, rideId: rideId, peerName: name);
      _startAlert();
      _ringTimer = Timer(const Duration(seconds: 45), () {
        if (state.phase == CallPhase.ringing) _teardown();
      });
      return;
    }

    if (rideId != state.rideId) return;

    switch (type) {
      case 'accept':
        final pc = _pc;
        if (pc == null) return;
        _ringTimer?.cancel();
        state = state.copyWith(phase: CallPhase.connecting);
        final offer = await pc.createOffer({'offerToReceiveAudio': 1});
        await pc.setLocalDescription(offer);
        await _signal('offer', {'sdp': offer.sdp, 'type': offer.type});
        break;
      case 'offer':
        final pc = _pc;
        final d = m['data'];
        if (pc == null || d is! Map) return;
        await pc.setRemoteDescription(
            RTCSessionDescription(d['sdp']?.toString(), d['type']?.toString()));
        await _flushIce();
        final answer = await pc.createAnswer({'offerToReceiveAudio': 1});
        await pc.setLocalDescription(answer);
        await _signal('answer', {'sdp': answer.sdp, 'type': answer.type});
        break;
      case 'answer':
        final pc = _pc;
        final d = m['data'];
        if (pc == null || d is! Map) return;
        await pc.setRemoteDescription(
            RTCSessionDescription(d['sdp']?.toString(), d['type']?.toString()));
        await _flushIce();
        break;
      case 'ice':
        final d = m['data'];
        if (d is! Map) return;
        final c = RTCIceCandidate(d['candidate']?.toString(),
            d['sdpMid']?.toString(), (d['sdpMLineIndex'] as num?)?.toInt());
        if (_pc != null && _remoteSet) {
          await _pc!.addCandidate(c);
        } else {
          _pendingIce.add(c);
        }
        break;
      case 'reject':
      case 'busy':
        await _teardown(
            errorKey: type == 'busy' ? 'call.busy' : 'call.declined');
        break;
      case 'end':
        await _teardown();
        break;
    }
  }

  Future<void> _flushIce() async {
    _remoteSet = true;
    final pc = _pc;
    if (pc == null) return;
    for (final c in _pendingIce) {
      await pc.addCandidate(c);
    }
    _pendingIce.clear();
  }

  // -----------------------------------------------------------------
  // Peer connection
  // -----------------------------------------------------------------

  Future<void> _preparePeer(String rideId) async {
    final mic = await Permission.microphone.request();
    if (!mic.isGranted) throw Exception('microphone_denied');

    final cfg = await _api.get('/rides/$rideId/call-config');
    final servers = ((cfg as Map)['iceServers'] as List)
        .map((e) => (e as Map).cast<String, dynamic>())
        .toList();

    final pc = await createPeerConnection({
      'iceServers': servers,
      'sdpSemantics': 'unified-plan',
    });
    _pc = pc;
    _remoteSet = false;
    _pendingIce.clear();

    _local = await navigator.mediaDevices
        .getUserMedia({'audio': true, 'video': false});
    for (final t in _local!.getAudioTracks()) {
      await pc.addTrack(t, _local!);
    }

    pc.onIceCandidate = (RTCIceCandidate c) {
      if (c.candidate == null) return;
      unawaited(_signal('ice', {
        'candidate': c.candidate,
        'sdpMid': c.sdpMid,
        'sdpMLineIndex': c.sdpMLineIndex,
      }));
    };
    pc.onConnectionState = (RTCPeerConnectionState s) {
      if (s == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _ringTimer?.cancel();
        if (state.phase != CallPhase.active) {
          state = state.copyWith(phase: CallPhase.active, seconds: 0);
          _clock?.cancel();
          _clock = Timer.periodic(const Duration(seconds: 1),
              (_) => state = state.copyWith(seconds: state.seconds + 1));
        }
      } else if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
          s == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
        if (state.busy) unawaited(_teardown(errorKey: 'call.failed'));
      }
    };
  }

  Future<void> _teardown({String? errorKey}) async {
    _ringTimer?.cancel();
    _clock?.cancel();
    _stopAlert();
    try {
      for (final t in _local?.getTracks() ?? <MediaStreamTrack>[]) {
        await t.stop();
      }
      await _local?.dispose();
    } catch (_) {}
    try {
      await _pc?.close();
    } catch (_) {}
    try {
      await Helper.setSpeakerphoneOn(false);
    } catch (_) {}
    _pc = null;
    _local = null;
    _pendingIce.clear();
    _remoteSet = false;
    state = CallState(errorKey: errorKey);
  }

  // Audible/haptic alert while a call is ringing.
  void _startAlert() {
    _alert?.cancel();
    void ping() {
      SystemSound.play(SystemSoundType.alert);
      HapticFeedback.heavyImpact();
    }

    ping();
    _alert = Timer.periodic(const Duration(seconds: 2), (_) => ping());
  }

  void _stopAlert() {
    _alert?.cancel();
    _alert = null;
  }

  @override
  void dispose() {
    _sub?.cancel();
    _ringTimer?.cancel();
    _clock?.cancel();
    _alert?.cancel();
    unawaited(_pc?.close());
    super.dispose();
  }
}

final callControllerProvider =
    StateNotifierProvider<CallController, CallState>((ref) {
  return CallController(
    ref.watch(apiClientProvider),
    ref.watch(socketClientProvider),
  );
});
