/**
 * Server-side message catalogue.
 *
 * Only strings the server itself produces live here: OTP text messages, push
 * notifications and a few payment prompts. The apps and the website carry
 * their own dictionaries.
 *
 * Lookup order: the user's language, the country's default language, then
 * English. Kinyarwanda (rw) and Luganda (lg) are starter translations and
 * must be reviewed by a native speaker before launch. OTP wording is kept
 * short: SMS gateways bill per 160-character segment.
 */

import { country } from './country';

export type MsgKey =
  | 'pay.check_phone' | 'pay.not_started' | 'pay.confirming' | 'pay.already_active'
  | 'sms.otp'
  | 'push.ride_request.t' | 'push.ride_request.b'
  | 'push.message.t'
  | 'push.accepted.t' | 'push.accepted.b'
  | 'push.arrived.t' | 'push.arrived.b'
  | 'push.completed.t' | 'push.completed.b';

type Catalogue = Record<MsgKey, string>;

const en: Catalogue = {
  'pay.check_phone': 'Check your phone and enter your PIN.',
  'pay.not_started': 'The payment did not start. Please try again.',
  'pay.confirming': 'We are confirming your payment...',
  'pay.already_active': 'A payment prompt is already active on your phone.',
  'sms.otp': 'Your {brand} code is {code}. Do not share it with anyone.',
  'push.ride_request.t': 'New ride request',
  'push.ride_request.b': 'A ride is available near you.',
  'push.message.t': 'New message',
  'push.accepted.t': 'Driver found',
  'push.accepted.b': 'Your driver is on the way.',
  'push.arrived.t': 'Your driver has arrived',
  'push.arrived.b': 'They are waiting at the pickup point.',
  'push.completed.t': 'Trip complete',
  'push.completed.b': 'Thank you for riding with {brand}.',
};

const sw: Catalogue = {
  'pay.check_phone': 'Angalia simu yako na uweke PIN yako.',
  'pay.not_started': 'Malipo hayakuanza. Jaribu tena.',
  'pay.confirming': 'Tunathibitisha malipo yako...',
  'pay.already_active': 'Ombi la malipo tayari lipo kwenye simu yako.',
  'sms.otp': 'Nambari yako ya {brand} ni {code}. Usimpe mtu yeyote.',
  'push.ride_request.t': 'Ombi jipya la safari',
  'push.ride_request.b': 'Kuna safari karibu nawe.',
  'push.message.t': 'Ujumbe mpya',
  'push.accepted.t': 'Dereva amepatikana',
  'push.accepted.b': 'Dereva wako yuko njiani.',
  'push.arrived.t': 'Dereva wako amefika',
  'push.arrived.b': 'Anakusubiri mahali pa kukuchukua.',
  'push.completed.t': 'Safari imekamilika',
  'push.completed.b': 'Asante kwa kusafiri na {brand}.',
};

const fr: Catalogue = {
  'pay.check_phone': 'Vérifiez votre téléphone et saisissez votre code PIN.',
  'pay.not_started': "Le paiement n'a pas démarré. Réessayez.",
  'pay.confirming': 'Nous confirmons votre paiement...',
  'pay.already_active': 'Une demande de paiement est déjà active sur votre téléphone.',
  'sms.otp': 'Votre code {brand} est {code}. Ne le partagez avec personne.',
  'push.ride_request.t': 'Nouvelle course',
  'push.ride_request.b': 'Une course est disponible près de vous.',
  'push.message.t': 'Nouveau message',
  'push.accepted.t': 'Chauffeur trouvé',
  'push.accepted.b': 'Votre chauffeur est en route.',
  'push.arrived.t': 'Votre chauffeur est arrivé',
  'push.arrived.b': 'Il vous attend au point de départ.',
  'push.completed.t': 'Course terminée',
  'push.completed.b': 'Merci d’avoir voyagé avec {brand}.',
};

const rw: Catalogue = {
  'pay.check_phone': 'Reba kuri telefone yawe maze ushyiremo PIN yawe.',
  'pay.not_started': 'Kwishyura ntibyatangiye. Ongera ugerageze.',
  'pay.confirming': 'Turimo kwemeza kwishyura kwawe...',
  'pay.already_active': 'Ubusabe bwo kwishyura buri kuri telefone yawe.',
  'sms.otp': 'Kode yawe ya {brand} ni {code}. Ntugire uwo uyiha.',
  'push.ride_request.t': 'Ubusabe bushya bw’urugendo',
  'push.ride_request.b': 'Hari urugendo ruri hafi yawe.',
  'push.message.t': 'Ubutumwa bushya',
  'push.accepted.t': 'Umushoferi yabonetse',
  'push.accepted.b': 'Umushoferi wawe ari mu nzira.',
  'push.arrived.t': 'Umushoferi wawe yageze',
  'push.arrived.b': 'Aragutegereje aho agomba kugufatira.',
  'push.completed.t': 'Urugendo rurarangiye',
  'push.completed.b': 'Murakoze gutwarwa na {brand}.',
};

const lg: Catalogue = {
  'pay.check_phone': 'Tunuulira essimu yo oteekemu PIN yo.',
  'pay.not_started': 'Okusasula tekutandise. Ddamu ogezeko.',
  'pay.confirming': 'Tukakasa okusasula kwo...',
  'pay.already_active': 'Okusaba okusasula kuli ku ssimu yo.',
  'sms.otp': 'Koodi yo eya {brand} ye {code}. Tagiwa muntu yenna.',
  'push.ride_request.t': 'Okusaba okupya okw’olugendo',
  'push.ride_request.b': 'Waliwo olugendo okumpi naawe.',
  'push.message.t': 'Obubaka obupya',
  'push.accepted.t': 'Omuvuzi alabise',
  'push.accepted.b': 'Omuvuzi wo ali mu kkubo.',
  'push.arrived.t': 'Omuvuzi wo atuuse',
  'push.arrived.b': 'Akulindirira w’onoomuggyiramu.',
  'push.completed.t': 'Olugendo luwedde',
  'push.completed.b': 'Webale okutambula ne {brand}.',
};

const CATALOGUES: Record<string, Catalogue> = { en, sw, fr, rw, lg };

export function msg(key: MsgKey, lang?: string | null, params: Record<string, string> = {}): string {
  const l = (lang ?? '').trim().toLowerCase();
  let text =
    CATALOGUES[l]?.[key] ??
    CATALOGUES[country.defaultLanguage]?.[key] ??
    en[key];
  const all = { brand: country.brand, ...params };
  for (const [k, v] of Object.entries(all)) text = text.split(`{${k}}`).join(v);
  return text;
}
