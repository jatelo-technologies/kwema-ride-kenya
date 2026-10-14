/// Push notifications (Firebase Cloud Messaging).
///
/// Optional by design: the app works fully over sockets without it. Push only
/// matters when the app is backgrounded (a driver offer, "your driver has
/// arrived", a new chat message).
///
/// Configuration comes from build-time defines so no Firebase file has to be
/// committed and the build never fails when push is not set up yet:
///
///   --dart-define=FIREBASE_API_KEY=...
///   --dart-define=FIREBASE_APP_ID=...            (the *Android* app id)
///   --dart-define=FIREBASE_MESSAGING_SENDER_ID=...
///   --dart-define=FIREBASE_PROJECT_ID=...
///
/// All four come from the client's Firebase project. If any is missing, init
/// does nothing.

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import '../network/api_client.dart';

class PushService {
  PushService._();

  static bool _started = false;

  static const _apiKey = String.fromEnvironment('FIREBASE_API_KEY');
  static const _appId = String.fromEnvironment('FIREBASE_APP_ID');
  static const _senderId = String.fromEnvironment('FIREBASE_MESSAGING_SENDER_ID');
  static const _projectId = String.fromEnvironment('FIREBASE_PROJECT_ID');

  static bool get configured =>
      _apiKey.isNotEmpty &&
      _appId.isNotEmpty &&
      _senderId.isNotEmpty &&
      _projectId.isNotEmpty;

  /// Registers this device with the server. [app] is 'rider' or 'driver'.
  /// Safe to call repeatedly and never throws.
  static Future<void> init(ApiClient api, String app) async {
    if (_started || !configured) return;
    _started = true;
    try {
      if (Firebase.apps.isEmpty) {
        await Firebase.initializeApp(
          options: const FirebaseOptions(
            apiKey: _apiKey,
            appId: _appId,
            messagingSenderId: _senderId,
            projectId: _projectId,
          ),
        );
      }
      final messaging = FirebaseMessaging.instance;
      await messaging.requestPermission();

      final platform =
          defaultTargetPlatform == TargetPlatform.iOS ? 'ios' : 'android';

      Future<void> register(String? token) async {
        if (token == null || token.length < 20) return;
        try {
          await api.post(
              '/devices', {'token': token, 'platform': platform, 'app': app});
        } catch (_) {
          // Retried on the next launch; not worth surfacing to the user.
        }
      }

      await register(await messaging.getToken());
      messaging.onTokenRefresh.listen(register);
    } catch (_) {
      _started = false; // allow a later retry
    }
  }
}
