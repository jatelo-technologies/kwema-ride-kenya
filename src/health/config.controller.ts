import { Controller, Get } from '@nestjs/common';
import { country } from '../common/country';
import { POOL, POOL_SEATS } from '../pool/pool.config';

/**
 * Public runtime configuration for the website.
 *
 * Only values that are safe in a browser. The Maps *browser* key is public by
 * design — it ships in every page that renders a map — but it must be
 * restricted by HTTP referrer in Google Cloud Console and must be a different
 * key from GOOGLE_MAPS_SERVER_KEY. The server key can call Directions and
 * Places and would be spent by anyone who viewed source.
 *
 * App store links are served rather than hardcoded so they can go live the
 * moment the apps are published, without a redeploy.
 */
@Controller('config')
export class ConfigController {
  @Get('public')
  publicConfig() {
    return {
      mapsBrowserKey: process.env.GOOGLE_MAPS_BROWSER_KEY ?? null,
      country: country.code,
      countryName: country.name,
      dialCode: country.dialCode,
      phoneDigits: country.phoneDigits,
      currency: country.currency,
      currencySymbol: country.currencySymbol,
      timezone: country.timezone,
      mapBounds: country.bounds,
      emergency: country.emergency,
      defaultLanguage: country.defaultLanguage,
      languages: country.languages,
      paymentMethods: ['mobile_money', 'card', 'cash'],
      mobileNetworks: country.mobileNetworks,
      pool: { enabled: POOL.enabled, seats: POOL_SEATS, discountBps: POOL.discountBps },
      apps: {
        rider: {
          ios: process.env.RIDER_IOS_URL ?? null,
          android: process.env.RIDER_ANDROID_URL ?? null,
          apk: process.env.RIDER_APK_URL ?? null,
        },
        driver: {
          ios: process.env.DRIVER_IOS_URL ?? null,
          android: process.env.DRIVER_ANDROID_URL ?? null,
          apk: process.env.DRIVER_APK_URL ?? null,
        },
      },
    };
  }
}
