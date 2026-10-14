# Kwema Ride Kenya — mobile apps

One Flutter project, two entry points. The rider and driver apps share the
theme, localization, API client, session store and socket layer; maintaining
two projects would guarantee those drift apart.

```
lib/
├── main_rider.dart          rider entry point
├── main_driver.dart         driver entry point
├── core/
│   ├── country_config.dart  everything that differs by country (generated)
│   ├── auth/                phone + OTP, token lifecycle
│   ├── format/money.dart    KES formatting (no subunit, comma-grouped: "KSh 1,250")
│   ├── l10n/                English, Swahili (default English)
│   ├── location/            offline-first GPS buffer (SQLite, ack-driven)
│   ├── models/              wire models, null-tolerant parsing
│   ├── network/             Dio client, secure session store, Socket.IO
│   └── theme/               tanzanite + marigold palette
└── features/
    ├── auth/                shared login screen
    ├── rider/               home, quoting, live tracking
    └── driver/              dashboard, offer modal, trip lifecycle
```

## First run

```bash
flutter pub get
flutter analyze          # do this first — see the note below
```

Then run whichever app:

```bash
flutter run -t lib/main_rider.dart \
  --dart-define=API_BASE_URL=https://kwema-ride-kenya-api.up.railway.app

flutter run -t lib/main_driver.dart \
  --dart-define=API_BASE_URL=https://kwema-ride-kenya-api.up.railway.app
```

`API_BASE_URL` defaults to `kDefaultApiUrl` in `core/country_config.dart`,
which is a placeholder until the production API domain exists.

**This code has not been compiled.** Every other part of this project was
typechecked and boot-tested before delivery; the Flutter apps were not,
because the build environment had no Flutter SDK. Expect `flutter analyze` to
surface issues on the first pass — send them over and they get fixed. What
has been verified: balanced delimiters, every relative import resolves, and
every referenced class and provider is defined somewhere in the tree. The
Firebase packages are the most likely source of first-build trouble.

## Platform setup

### Android

`android/app/src/main/AndroidManifest.xml` — inside `<application>`:

```xml
<meta-data android:name="com.google.android.geo.API_KEY"
           android:value="YOUR_ANDROID_MAPS_KEY"/>
```

CI does this for you (`tool/patch_android_manifest.py`). `minSdkVersion 21` or
higher in `android/app/build.gradle`.

Application ids: `com.jatelo.kwema.ke.rider` and `com.jatelo.kwema.ke.driver`, set by
`tool/set_app_identity.py` so both apps can be installed on one handset.

### iOS

`tool/patch_ios_project.py` sets the bundle id, display name, privacy strings
and the Maps key after `flutter create --platforms=ios`. The `ios-build.yml`
workflow runs it and produces unsigned builds.

### Maps keys

Three separate keys, all from the same Google Cloud project:

| Key | Restriction | Used by |
|---|---|---|
| Android | SHA-1 + package name | `google_maps_flutter` on Android |
| iOS | Bundle id | `google_maps_flutter` on iOS |
| Server | API restrictions only | Backend routing, Places, Geocoding |

The apps never call Directions, Places or Geocoding directly — those go
through the backend proxy, so the server key never ships in an APK.

## Building the APKs without installing Flutter

`.github/workflows/mobile-release.yml` builds both APKs on GitHub's runners
and attaches them to a Release (`kwema-rider.apk`, `kwema-driver.apk`). Push a
tag, or run it from the Actions tab. It also runs `flutter analyze` and uploads
the report as an artifact, so the analyzer output is available even on a green
build.

The `android/` folder is not committed. CI runs `flutter create --platforms=
android` to generate it, then patches in the Maps key and the location
permissions.

Required repository secret: `ANDROID_MAPS_API_KEY`. Without it the build still
succeeds and maps render blank.

## Design decisions worth keeping

**The default language is the country default, not the device locale.** Nearly
every handset sold here ships with an English system locale regardless of what
its owner speaks. Another supported language on the device is honoured;
English is treated as a factory setting.


**Tokens live in the platform keystore**, not shared preferences. A refresh
token is valid for sixty days and is enough to impersonate the account.

**The driver's offer countdown is derived from the server's absolute expiry**,
not a local fifteen-second tick.

**Location fixes are deleted only after the server acknowledges the sequence
number**, so a dead zone does not put holes in the trip trace.

**Card fields are never rendered by these apps.** Card payment opens the
provider's hosted 3-D Secure page, which keeps the platform out of PCI DSS
SAQ-D.
