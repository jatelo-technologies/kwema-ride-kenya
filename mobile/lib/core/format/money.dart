/// Money formatting for the country this build serves.
///
///  * The currency symbol, its position and the rounding come from
///    core/country_config.dart (generated per country).
///  * No circulating subunit is shown: "KSh 1,250", never "KSh 1,250.00".
///  * Amounts are integer cents internally (1 unit = 100 cents); division
///    happens only at the edge.
///  * The number format does not change with language, so only the words
///    around an amount are translated.

import '../country_config.dart';

/// "KSh 1,250" or "1,500 RF", depending on the country.
String formatMoney(int cents) {
  final n = _group((cents / 100).round());
  return kSymbolAfter ? '$n $kCurrencySymbol' : '$kCurrencySymbol $n';
}

/// Compact form for tight spaces such as the category carousel. Below
/// 10,000 units the full number fits and is clearer than an abbreviation.
String formatMoneyCompact(int cents) {
  final units = (cents / 100).round();
  if (units < 10000) return _group(units);
  return '${(units / 1000).toStringAsFixed(1)}K';
}

/// Tolerant of "3 450", "3,450", "3450", "KSh 3450".
int? parseMoneyToCents(String input) {
  final cleaned = input.replaceAll(RegExp(r'[^0-9]'), '');
  return cleaned.isEmpty ? null : int.parse(cleaned) * 100;
}

/// "1.4 km" / "600 m"
String formatDistance(int metres) =>
    metres < 1000 ? '$metres m' : '${(metres / 1000).toStringAsFixed(1)} km';

/// Groups digits in threes with a comma: 1234567 -> "1,234,567".
String _group(int n) {
  final s = n.abs().toString();
  final b = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
    b.write(s[i]);
  }
  return n < 0 ? '-$b' : b.toString();
}
