/// Trip alerts: a notification (lock screen and heads-up), a vibration and a
/// sound, so a rider who has put the phone down still learns that the driver
/// was found or has arrived, and a driver is told they are at the pickup.

import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

class TripNotifier {
  TripNotifier._();
  static final TripNotifier instance = TripNotifier._();

  final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();
  bool _ready = false;

  Future<void> init() async {
    if (_ready) return;
    try {
      await _plugin.initialize(const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      ));
      final android = _plugin.resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin>();
      await android?.requestNotificationsPermission();
      _ready = true;
    } catch (e) {
      // Alerts are a convenience; the app works without them.
      debugPrint('notifications unavailable: $e');
    }
  }

  /// Shows a notification and buzzes the phone. Safe to call at any time.
  Future<void> alert({
    required int id,
    required String title,
    required String body,
  }) async {
    try {
      HapticFeedback.vibrate();
      SystemSound.play(SystemSoundType.alert);
    } catch (_) {}
    if (!_ready) await init();
    if (!_ready) return;
    try {
      await _plugin.show(
        id,
        title,
        body,
        const NotificationDetails(
          android: AndroidNotificationDetails(
            'kwema_trip',
            'Trip updates',
            channelDescription: 'Driver found, driver arrived, trip updates',
            importance: Importance.max,
            priority: Priority.high,
            playSound: true,
            enableVibration: true,
            category: AndroidNotificationCategory.status,
          ),
        ),
      );
    } catch (e) {
      debugPrint('notification failed: $e');
    }
  }

  static const int offerNotificationId = 7001;

  /// A new ride request for a driver. Built to interrupt: it lights the
  /// screen and opens over the lock screen (full-screen intent), plays an
  /// alarm-volume sound that repeats until it is answered or times out, and
  /// vibrates. Cancelled as soon as the offer is accepted, declined or gone.
  Future<void> offerAlert({
    required String title,
    required String body,
    int ttlSeconds = 15,
  }) async {
    try {
      HapticFeedback.vibrate();
    } catch (_) {}
    if (!_ready) await init();
    if (!_ready) return;
    try {
      await _plugin.show(
        offerNotificationId,
        title,
        body,
        NotificationDetails(
          android: AndroidNotificationDetails(
            'kwema_offers',
            'Ride requests',
            channelDescription: 'Incoming ride requests',
            importance: Importance.max,
            priority: Priority.max,
            category: AndroidNotificationCategory.call,
            fullScreenIntent: true,
            playSound: true,
            enableVibration: true,
            vibrationPattern: Int64List.fromList([0, 600, 300, 600, 300, 600]),
            audioAttributesUsage: AudioAttributesUsage.alarm,
            // FLAG_INSISTENT: keep ringing until answered.
            additionalFlags: Int32List.fromList([4]),
            timeoutAfter: ttlSeconds * 1000,
            autoCancel: true,
            visibility: NotificationVisibility.public,
          ),
        ),
      );
    } catch (e) {
      debugPrint('offer alert failed: $e');
    }
  }

  Future<void> cancelOfferAlert() async {
    try {
      await _plugin.cancel(offerNotificationId);
    } catch (_) {}
  }
}
