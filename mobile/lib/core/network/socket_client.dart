/// Realtime client.
///
/// Mirrors the gateway's contract: `session:ready` on connect,
/// `ride:status_change` / `ride:driver_moved` / `ride:request` inbound, and
/// an application heartbeat outbound every 20 seconds.
///
/// Why an app-level heartbeat on top of Socket.IO's own ping: on an East African
/// mobile network a socket routinely stays "open" while packets are being
/// dropped — a half-open TCP connection after a cell handover looks alive for
/// minutes. The server reaps sockets that go quiet, and this is what keeps a
/// working connection from being reaped.
///
/// Clock skew: the heartbeat ack carries server time. Handsets in the field
/// are often minutes off, which would corrupt trip timestamps and make the
/// driver's offer countdown wrong, so the offset is tracked and applied.

import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import 'api_client.dart';
import 'session_store.dart';

typedef JsonMap = Map<String, dynamic>;

class SocketClient {
  SocketClient(this._session, this._api);

  final SessionStore _session;
  final ApiClient _api;
  io.Socket? _socket;
  Timer? _heartbeat;
  Timer? _retry;
  bool _opening = false;
  bool _closedByUs = false;
  Duration _clockSkew = Duration.zero;

  final _status = StreamController<JsonMap>.broadcast();
  final _driverMoved = StreamController<JsonMap>.broadcast();
  final _offers = StreamController<JsonMap>.broadcast();
  final _payments = StreamController<JsonMap>.broadcast();
  final _poolUpdates = StreamController<JsonMap>.broadcast();
  final _poolRiders = StreamController<JsonMap>.broadcast();
  final _connection = StreamController<bool>.broadcast();
  final _messages = StreamController<JsonMap>.broadcast();
  final _callSignals = StreamController<JsonMap>.broadcast();

  Stream<JsonMap> get rideStatus => _status.stream;
  Stream<JsonMap> get driverMoved => _driverMoved.stream;
  Stream<JsonMap> get offers => _offers.stream;
  Stream<JsonMap> get payments => _payments.stream;
  /// `ride:pool_update`: how many other riders now share this rider's trip.
  Stream<JsonMap> get poolUpdates => _poolUpdates.stream;

  /// `pool:rider_added`: a passenger joined this driver's vehicle.
  Stream<JsonMap> get poolRiders => _poolRiders.stream;
  Stream<bool> get connection => _connection.stream;

  /// `ride:message`: a chat message on the rider's or driver's live trip.
  Stream<JsonMap> get messages => _messages.stream;

  /// `call:signal`: WebRTC call set-up from the other person on the trip.
  Stream<JsonMap> get callSignals => _callSignals.stream;

  bool get isConnected => _socket?.connected ?? false;

  /// Server time, corrected for handset clock drift.
  DateTime get serverNow => DateTime.now().add(_clockSkew);

  Future<void> connect() async {
    _closedByUs = false;
    if (_socket != null || _opening) return;
    _opening = true;
    try {
      // Always a fresh token: the one from the last connection may have
      // expired while the phone was offline.
      final token = await _api.freshAccessToken();
      if (token == null) return;
      if (_socket != null) return;
      _open(token);
    } finally {
      _opening = false;
    }
  }

  /// Tears the socket down and builds a new one with a renewed token. Called
  /// when the server refuses a connection (expired token) and from the
  /// retry timer when the network was away for a while.
  Future<void> reconnect() async {
    _retry?.cancel();
    final old = _socket;
    _socket = null;
    _heartbeat?.cancel();
    old?.dispose();
    await connect();
  }

  /// Safe to call at any time (app resumed, screen opened): reconnects only
  /// when there is no live connection.
  Future<void> ensureConnected() async {
    if (isConnected) return;
    await reconnect();
  }

  void _scheduleRetry() {
    if (_closedByUs) return;
    _retry?.cancel();
    _retry = Timer(const Duration(seconds: 4), () {
      if (!_closedByUs && !isConnected) unawaited(reconnect());
    });
  }

  void _open(String token) {
    final socket = io.io(
      '$kApiBaseUrl/rt',
      io.OptionBuilder()
          // WebSocket first, polling as fallback: some mobile proxies here
          // still break the upgrade, and polling keeps those users working
          // rather than showing a dead map.
          .setTransports(['websocket', 'polling'])
          .setAuth({'token': token})
          .enableReconnection()
          .setReconnectionDelay(1000)
          .setReconnectionDelayMax(8000)
          .setReconnectionAttempts(999999)
          .build(),
    );
    _socket = socket;

    socket.onConnect((_) {
      _connection.add(true);
      _startHeartbeat();
    });
    socket.onDisconnect((_) {
      _connection.add(false);
      _heartbeat?.cancel();
      // The built-in reconnect reuses the original token, which is refused
      // once it has expired. Rebuild with a renewed token instead.
      _scheduleRetry();
    });
    socket.onConnectError((e) {
      debugPrint('socket connect error: $e');
      _scheduleRetry();
    });

    socket.on('session:ready', (data) {
      if (data is Map) {
        final serverTime = data['serverTime'];
        if (serverTime is int) {
          _clockSkew = DateTime.fromMillisecondsSinceEpoch(serverTime)
              .difference(DateTime.now());
        }
        // Active rides arrive here, which is what makes a reconnect seamless:
        // the client does not re-subscribe, it just re-renders.
        _status.add(data.cast<String, dynamic>());
      }
    });

    socket.on('ride:status_change', (d) => _emit(_status, d));
    socket.on('ride:driver_moved', (d) => _emit(_driverMoved, d));
    socket.on('ride:request', (d) => _emit(_offers, d));
    socket.on('ride:offer_closed', (d) => _emit(_offers, d));
    socket.on('ride:fare_ready', (d) => _emit(_status, d));
    socket.on('payment:status', (d) => _emit(_payments, d));
    socket.on('ride:pool_update', (d) => _emit(_poolUpdates, d));
    socket.on('pool:rider_added', (d) => _emit(_poolRiders, d));
    socket.on('ride:message', (d) => _emit(_messages, d));
    socket.on('call:signal', (d) => _emit(_callSignals, d));

    socket.connect();
  }

  void _emit(StreamController<JsonMap> c, dynamic data) {
    if (data is Map) c.add(data.cast<String, dynamic>());
  }

  void _startHeartbeat() {
    _heartbeat?.cancel();
    _heartbeat = Timer.periodic(const Duration(seconds: 20), (_) {
      _socket?.emitWithAck('hb', {'t': DateTime.now().millisecondsSinceEpoch},
          ack: (dynamic reply) {
        if (reply is Map && reply['t'] is int) {
          _clockSkew = DateTime.fromMillisecondsSinceEpoch(reply['t'] as int)
              .difference(DateTime.now());
        }
      });
    });
  }

  /// Emits and waits for the server ack, or null on timeout. The location
  /// queue relies on this: a fix is only deleted from the device buffer once
  /// the server has acknowledged its sequence number.
  Future<dynamic> emitWithAck(
    String event,
    dynamic payload, {
    Duration timeout = const Duration(seconds: 8),
  }) {
    final socket = _socket;
    if (socket == null || !socket.connected) return Future.value(null);

    final completer = Completer<dynamic>();
    final timer = Timer(timeout, () {
      if (!completer.isCompleted) completer.complete(null);
    });
    socket.emitWithAck(event, payload, ack: (dynamic reply) {
      timer.cancel();
      if (!completer.isCompleted) completer.complete(reply);
    });
    return completer.future;
  }

  void emit(String event, dynamic payload) => _socket?.emit(event, payload);

  void reportDiagnostic(String kind, String detail) =>
      debugPrint('[$kind] $detail');

  Future<void> disconnect() async {
    _closedByUs = true;
    _retry?.cancel();
    _heartbeat?.cancel();
    _socket?.dispose();
    _socket = null;
    _connection.add(false);
  }

  void dispose() {
    _closedByUs = true;
    _retry?.cancel();
    _heartbeat?.cancel();
    _socket?.dispose();
    _status.close();
    _driverMoved.close();
    _offers.close();
    _payments.close();
    _messages.close();
    _callSignals.close();
    _connection.close();
  }
}
