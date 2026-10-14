/**
 * Country profile.
 *
 * One deployment serves one country, selected by the COUNTRY env var
 * (ISO 3166-1 alpha-2). Everything that is country-specific —
 * phone format, currency, rounding, timezone, map bounds, emergency numbers,
 * VAT — comes from here, so adding a country is one entry, not a code hunt.
 *
 * Money convention (unchanged from the original platform): every amount is an
 * integer in "cents", where 1 currency unit = 100 cents, even for currencies
 * with no circulating subunit (UGX, RWF). That keeps all arithmetic integer
 * and lets per-km rates carry fractions. Display code divides by 100.
 */

export interface CountryProfile {
  code: string;
  name: string;
  /** Main city: default map-search area and admin default. */
  city: string;
  /** Product name for this country, used in SMS, receipts and the apps. */
  brand: string;
  dialCode: string; // without '+'
  /** Digits after the dial code. */
  phoneDigits: number;
  currency: string;
  currencySymbol: string;
  /** Customer-facing fare rounding step, in cents. */
  roundingStepCents: number;
  /** Standard VAT in basis points (1800 = 18%). Verify against current law. */
  vatBps: number;
  timezone: string;
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  emergency: { primary: string; ambulance: string; fire?: string; label: string };
  /** True when numbers still need written confirmation from the client. */
  emergencyUnverified: boolean;
  languages: string[];
  defaultLanguage: string;
  mobileNetworks: string[];
  /** Driver wallet floor / debt limits in cents. */
  walletFloorCents: number;
  cashDebtCeilingCents: number;
  cashDebtMaxCeilingCents: number;
  /** Smallest driver payout worth sending, in cents. */
  minPayoutCents: number;
}

const PROFILES: Record<string, CountryProfile> = {
  KE: {
    code: 'KE',
    name: 'Kenya',
    city: 'Nairobi',
    brand: 'Kwema Ride Kenya',
    dialCode: '254',
    phoneDigits: 9,
    currency: 'KES',
    currencySymbol: 'KSh',
    roundingStepCents: 1_000, // 10 KES
    vatBps: 1_600,
    timezone: 'Africa/Nairobi',
    bounds: { minLat: -4.7, maxLat: 5.1, minLng: 33.9, maxLng: 41.95 },
    emergency: { primary: '999', ambulance: '112', label: 'Kenya emergency services' },
    emergencyUnverified: true,
    languages: ['en', 'sw'],
    defaultLanguage: 'en',
    mobileNetworks: ['mpesa', 'airtelmoney'],
    walletFloorCents: -50_000, // -500 KES
    cashDebtCeilingCents: 150_000, // 1,500 KES
    cashDebtMaxCeilingCents: 750_000, // 7,500 KES
    minPayoutCents: 25_000, // 250 KES
  },
};

const DEFAULT_COUNTRY = 'KE';

const code = (process.env.COUNTRY ?? DEFAULT_COUNTRY).toUpperCase();
if (!PROFILES[code]) {
  throw new Error(`COUNTRY "${code}" is not configured. Known: ${Object.keys(PROFILES).join(', ')}`);
}

export const country: CountryProfile = PROFILES[code];

/** e.g. /^\+254[0-9]{9}$/ */
export const PHONE_REGEX = new RegExp(`^\\+${country.dialCode}[0-9]{${country.phoneDigits}}$`);

/** Human example for error messages: +254XXXXXXXXX */
export const PHONE_EXAMPLE = `+${country.dialCode}${'X'.repeat(country.phoneDigits)}`;

export const PHONE_MESSAGE = `phone must be ${PHONE_EXAMPLE}`;

export function isValidPhone(phone: string | undefined | null): boolean {
  return PHONE_REGEX.test(phone ?? '');
}

/** +254712345678 -> +254 71 *** 78 (keeps first/last digits for recognition). */
export function maskPhone(phone: string): string {
  const d = country.dialCode.length + 1;
  if (phone.length <= d + 4) return phone;
  const national = phone.slice(d);
  return `+${country.dialCode} ${national.slice(0, 2)} *** ${national.slice(-2)}`;
}
