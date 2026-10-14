import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../network/api_client.dart';
import 'push_service.dart';

/// Registers for push once the user is signed in. Wraps the signed-in UI and
/// renders it unchanged.
class PushBootstrap extends ConsumerStatefulWidget {
  const PushBootstrap({super.key, required this.app, required this.child});

  /// 'rider' or 'driver'.
  final String app;
  final Widget child;

  @override
  ConsumerState<PushBootstrap> createState() => _PushBootstrapState();
}

class _PushBootstrapState extends ConsumerState<PushBootstrap> {
  @override
  void initState() {
    super.initState();
    PushService.init(ref.read(apiClientProvider), widget.app);
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
