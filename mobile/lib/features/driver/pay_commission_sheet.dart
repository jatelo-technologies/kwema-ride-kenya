/// Driver pays the commission owed on cash trips: mobile money prompt or
/// card checkout. The wallet is credited by the server only when the provider
/// confirms; this sheet just starts the payment and watches it.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/l10n/localization.dart';
import '../../core/network/api_client.dart';
import '../../core/theme/app_theme.dart';
import '../../core/format/money.dart';
import '../../core/country_config.dart';
import 'driver_controller.dart';

enum _Phase { form, starting, waiting, paid, failed, slow }

class PayCommissionSheet extends ConsumerStatefulWidget {
  const PayCommissionSheet({super.key});

  static Future<void> show(BuildContext context) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => const PayCommissionSheet(),
    );
  }

  @override
  ConsumerState<PayCommissionSheet> createState() => _PayCommissionSheetState();
}

class _PayCommissionSheetState extends ConsumerState<PayCommissionSheet> {
  static final _networks = <(String, String)>[
    for (final w in kWallets) (w.wire, w.label),
  ];

  late final TextEditingController _amount;
  final _phone = TextEditingController();
  String _method = 'mobile_money';
  String _mno = kDefaultWallet;
  _Phase _phase = _Phase.form;
  String? _error;
  String? _reference;
  String? _message;
  int _paidCents = 0;
  Timer? _poll;
  int _polls = 0;

  @override
  void initState() {
    super.initState();
    final debt = ref.read(driverControllerProvider).debtCents;
    _amount = TextEditingController(text: '${(debt / 100).round()}');
    // Fresh numbers: the debt may have moved since the screen last refreshed.
    unawaited(ref.read(driverControllerProvider.notifier).refreshWallet());
  }

  @override
  void dispose() {
    _poll?.cancel();
    _amount.dispose();
    _phone.dispose();
    super.dispose();
  }

  int get _amountCents => (int.tryParse(_amount.text.replaceAll(RegExp(r'[^0-9]'), '')) ?? 0) * 100;

  String _errorText(AppLocalizations l10n, String code) {
    final key = 'commission.err.$code';
    final text = l10n.translate(key);
    return text == key ? code : text;
  }

  Future<void> _pay() async {
    final l10n = AppLocalizations.of(context);
    final debt = ref.read(driverControllerProvider).debtCents;
    final cents = _amountCents;
    if (cents <= 0) {
      setState(() => _error = l10n.translate('commission.err.invalid_amount'));
      return;
    }
    setState(() {
      _phase = _Phase.starting;
      _error = null;
    });
    try {
      final phone = _phone.text.trim();
      final res = await ref.read(apiClientProvider).post('/payments/commission/pay', {
        'amountCents': cents > debt ? debt : cents,
        'method': _method,
        if (_method == 'mobile_money') 'mno': _mno,
        if (_method == 'mobile_money' && phone.isNotEmpty) 'payerPhone': phone,
      });
      final map = (res as Map).cast<String, dynamic>();
      _reference = map['reference']?.toString();
      _paidCents = (map['amountCents'] as num?)?.toInt() ?? cents;
      if (map['status'] == 'failed' || _reference == null) {
        setState(() {
          _phase = _Phase.failed;
          _message = map['message']?.toString();
        });
        return;
      }
      setState(() {
        _phase = _Phase.waiting;
        _message = map['message']?.toString();
      });
      if (_method == 'card') {
        final url = map['checkoutUrl']?.toString();
        if (url != null) {
          // Card details are entered on the provider's own page.
          await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
        }
      }
      _startPolling();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.form;
        _error = _errorText(l10n, e.message);
      });
    }
  }

  void _startPolling() {
    _poll?.cancel();
    _polls = 0;
    _poll = Timer.periodic(const Duration(seconds: 3), (_) => _check());
  }

  Future<void> _check() async {
    final ref0 = _reference;
    if (ref0 == null || !mounted) return;
    _polls++;
    try {
      final api = ref.read(apiClientProvider);
      String status;
      if (_method == 'card') {
        // The redirect is only a hint; the server confirms with the provider.
        final res = await api.post('/payments/card/verify', {'reference': ref0});
        status = ((res as Map)['status'] ?? 'processing').toString();
      } else {
        final res = await api.get('/payments/status/$ref0');
        status = ((res as Map)['status'] ?? 'processing').toString();
      }
      if (!mounted) return;
      if (status == 'success') {
        _poll?.cancel();
        await ref.read(driverControllerProvider.notifier).refreshWallet();
        if (mounted) setState(() => _phase = _Phase.paid);
        return;
      }
      if (status == 'failed' || status == 'timeout' || status == 'reversed') {
        _poll?.cancel();
        if (mounted) setState(() => _phase = _Phase.failed);
        return;
      }
    } catch (_) {
      // A dropped request is not a failed payment; keep watching.
    }
    // Two and a half minutes is long enough to type a PIN. Past that, stop
    // polling; the server keeps confirming and the balance updates itself.
    if (_polls >= 50) {
      _poll?.cancel();
      unawaited(ref.read(driverControllerProvider.notifier).refreshWallet());
      if (mounted) setState(() => _phase = _Phase.slow);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final wallet = ref.watch(driverControllerProvider);

    Widget body;
    switch (_phase) {
      case _Phase.starting:
        body = const _Centered(child: CircularProgressIndicator());
      case _Phase.waiting:
        body = _Centered(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const CircularProgressIndicator(),
            const SizedBox(height: 16),
            Text(
              _method == 'card'
                  ? l10n.translate('commission.finish_card')
                  : l10n.translate('commission.check_phone'),
              textAlign: TextAlign.center,
              style: theme.textTheme.titleSmall,
            ),
            const SizedBox(height: 6),
            Text(formatMoney(_paidCents),
                style: theme.textTheme.headlineSmall
                    ?.copyWith(fontWeight: FontWeight.w800)),
            if (_method == 'card') ...[
              const SizedBox(height: 14),
              OutlinedButton(
                style: OutlinedButton.styleFrom(minimumSize: const Size(0, 44)),
                onPressed: _check,
                child: Text(l10n.translate('commission.i_paid')),
              ),
            ],
          ]),
        );
      case _Phase.paid:
        body = _Centered(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.check_circle, color: KwemaColors.go, size: 56),
            const SizedBox(height: 10),
            Text(l10n.translate('commission.paid'),
                style: theme.textTheme.titleMedium
                    ?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: 4),
            Text(
              wallet.debtCents > 0
                  ? l10n.translate('commission.still_owed',
                      params: {'amount': formatMoney(wallet.debtCents)})
                  : l10n.translate('commission.cleared'),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              height: 52,
              child: FilledButton(
                onPressed: () => Navigator.of(context).pop(),
                child: Text(l10n.translate('common.close')),
              ),
            ),
          ]),
        );
      case _Phase.slow:
        body = _Centered(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.hourglass_bottom, size: 48),
            const SizedBox(height: 10),
            Text(l10n.translate('commission.slow'),
                textAlign: TextAlign.center),
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              height: 52,
              child: FilledButton(
                onPressed: () => Navigator.of(context).pop(),
                child: Text(l10n.translate('common.close')),
              ),
            ),
          ]),
        );
      case _Phase.failed:
        body = _Centered(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.error_outline,
                color: theme.colorScheme.error, size: 48),
            const SizedBox(height: 10),
            Text(_message ?? l10n.translate('commission.failed'),
                textAlign: TextAlign.center),
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              height: 52,
              child: FilledButton(
                onPressed: () => setState(() {
                  _phase = _Phase.form;
                  _error = null;
                }),
                child: Text(l10n.translate('commission.try_again')),
              ),
            ),
          ]),
        );
      case _Phase.form:
        body = _form(context, l10n, theme, wallet);
    }

    return Padding(
      padding: EdgeInsets.fromLTRB(
          20, 0, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(child: body),
    );
  }

  Widget _form(BuildContext context, AppLocalizations l10n, ThemeData theme,
      DriverState wallet) {
    final debt = wallet.debtCents;
    if (debt <= 0) {
      return _Centered(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Icon(Icons.check_circle, color: KwemaColors.go, size: 48),
          const SizedBox(height: 10),
          Text(l10n.translate('commission.nothing_owed'),
              textAlign: TextAlign.center),
        ]),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(l10n.translate('commission.title'),
            style: theme.textTheme.titleLarge
                ?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 4),
        Text(l10n.translate('account.commission_owed'),
            style: theme.textTheme.bodySmall),
        Text(formatMoney(debt),
            style: theme.textTheme.headlineMedium?.copyWith(
                fontWeight: FontWeight.w800,
                color: wallet.isBlocked
                    ? theme.colorScheme.error
                    : KwemaColors.marigold700)),
        if (wallet.isBlocked) ...[
          const SizedBox(height: 6),
          Text(l10n.translate('commission.blocked'),
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: theme.colorScheme.error)),
        ],
        const SizedBox(height: 16),
        TextField(
          controller: _amount,
          keyboardType: TextInputType.number,
          decoration: InputDecoration(
            labelText: l10n.translate('commission.amount'),
            prefixText: '$kCurrencySymbol ',
            suffix: TextButton(
              style: TextButton.styleFrom(
                  minimumSize: const Size(0, 32),
                  padding: const EdgeInsets.symmetric(horizontal: 8)),
              onPressed: () =>
                  setState(() => _amount.text = '${(debt / 100).round()}'),
              child: Text(l10n.translate('commission.pay_all')),
            ),
          ),
        ),
        const SizedBox(height: 14),
        Row(children: [
          Expanded(
            child: ChoiceChip(
              selected: _method == 'mobile_money',
              label: SizedBox(
                  width: double.infinity,
                  child: Text(l10n.translate('commission.mobile_money'),
                      textAlign: TextAlign.center)),
              onSelected: (_) => setState(() => _method = 'mobile_money'),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: ChoiceChip(
              selected: _method == 'card',
              label: SizedBox(
                  width: double.infinity,
                  child: Text(l10n.translate('commission.card'),
                      textAlign: TextAlign.center)),
              onSelected: (_) => setState(() => _method = 'card'),
            ),
          ),
        ]),
        if (_method == 'mobile_money') ...[
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 4,
            children: [
              for (final n in _networks)
                ChoiceChip(
                  selected: _mno == n.$1,
                  label: Text(n.$2),
                  onSelected: (_) => setState(() => _mno = n.$1),
                ),
            ],
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _phone,
            keyboardType: TextInputType.phone,
            decoration: InputDecoration(
              labelText: l10n.translate('commission.phone'),
              hintText: '$kPhonePrefix…',
              prefixIcon: const Icon(Icons.phone_outlined),
            ),
          ),
        ] else ...[
          const SizedBox(height: 8),
          Text(l10n.translate('commission.card_note'),
              style: theme.textTheme.bodySmall),
        ],
        if (_error != null) ...[
          const SizedBox(height: 10),
          Text(_error!, style: TextStyle(color: theme.colorScheme.error)),
        ],
        const SizedBox(height: 16),
        SizedBox(
          height: 56,
          child: FilledButton(
            onPressed: _pay,
            child: Text(
              l10n.translate('commission.pay_button', params: {
                'amount': formatMoney(_amountCents > debt ? debt : _amountCents),
              }),
              style: const TextStyle(fontSize: 16),
            ),
          ),
        ),
      ],
    );
  }
}

class _Centered extends StatelessWidget {
  const _Centered({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 28),
        child: Center(child: child),
      );
}
