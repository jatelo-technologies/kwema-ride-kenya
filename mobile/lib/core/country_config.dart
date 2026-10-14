/// Country configuration for this build — generated per country.
///
/// Everything that differs between Kwema Ride Kenya, Uganda and Rwanda and is
/// needed on the handset lives here, so no other Dart file mentions a country.
/// The server holds the authoritative copy (src/common/country.ts); keep the
/// two in step.

import 'package:google_maps_flutter/google_maps_flutter.dart';

/// Product name, e.g. "Kwema Ride Kenya".
const String kBrand = 'Kwema Ride Kenya';

/// Short name used in system notifications.
const String kAppName = 'Kwema Ride';

/// Driver app display name.
const String kDriverLabel = 'Kwema Driver';

/// Public website, shown where drivers are told where to register.
const String kDomain = 'kwemaride.co.ke';

/// ISO 3166-1 alpha-2 country code.
const String kCountryCode = 'KE';

/// Default API address when --dart-define=API_BASE_URL is not given.
/// PLACEHOLDER until the production API domain exists.
const String kDefaultApiUrl = 'https://kwema-ride-kenya-api.up.railway.app';

// ---- Phone numbers ---------------------------------------------------
const String kDialCode = '254';
const int kPhoneDigits = 9;

/// What the phone field starts with: "+254".
const String kPhonePrefix = '+254';

/// Placeholder text for phone fields: "+254XXXXXXXXX".
const String kPhoneFormat = '+254XXXXXXXXX';

/// Longest valid number including the "+".
const int kPhoneMaxLength = 13;

/// Full-number check, international format only.
final RegExp kPhonePattern = RegExp(r'^\+254[0-9]{9}$');

// ---- Money -----------------------------------------------------------
const String kCurrencyCode = 'KES';
const String kCurrencySymbol = 'KSh';
const bool kSymbolAfter = false;

// ---- Mobile money ----------------------------------------------------
class WalletOption {
  const WalletOption(this.wire, this.label, this.operator);

  /// Value sent to the API as `mno`.
  final String wire;
  final String label;
  final String operator;
}

/// Wallets offered for this country, in display order.
const List<WalletOption> kWallets = [
  WalletOption('mpesa', 'M-Pesa', 'Safaricom'),
  WalletOption('airtelmoney', 'Airtel Money', 'Airtel'),
];

const String kDefaultWallet = 'mpesa';

// ---- Safety ----------------------------------------------------------
/// National emergency number dialled from the SOS sheet. UNVERIFIED: the
/// client must confirm in writing before launch.
const String kEmergencyNumber = '999';

// ---- Maps ------------------------------------------------------------
/// Cold-start map centre: the city centre.
const LatLng kMapCenter = LatLng(-1.2864, 36.8172);

// ---- Languages -------------------------------------------------------
/// Language codes offered, in switcher order.
const List<String> kLanguageCodes = ['en', 'sw'];

/// Language used on first launch.
const String kDefaultLanguageCode = 'en';
