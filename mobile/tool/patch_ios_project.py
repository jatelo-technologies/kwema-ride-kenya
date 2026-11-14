#!/usr/bin/env python3
"""Sets the iOS bundle id, display name, privacy strings and Maps key.

Run after `flutter create --platforms=ios`, before `flutter build ios`.

Usage: patch_ios_project.py <rider|driver> [maps_api_key]
"""

import re
import sys
from pathlib import Path

IDENTITY = {
    'rider': ('com.jatelo.kwema.ke.rider', 'Kwema Ride'),
    'driver': ('com.jatelo.kwema.ke.driver', 'Kwema Driver'),
}

PLIST_KEYS = {
    'NSLocationWhenInUseUsageDescription':
        'Kwema Ride uses your location to find your pickup point and nearby drivers.',
    'NSLocationAlwaysAndWhenInUseUsageDescription':
        'Kwema Ride uses your location so drivers can reach you and trips are tracked.',
    'NSCameraUsageDescription': 'Kwema Ride uses the camera for your profile photo.',
    'NSPhotoLibraryUsageDescription': 'Kwema Ride uses your photos for your profile picture.',
    # In-app audio calls between rider and driver.
    'NSMicrophoneUsageDescription': 'Kwema Ride uses the microphone for calls with your driver or rider.',
}

# permission_handler compiles each iOS permission in only when its macro is
# set in the Podfile; without them every request comes back "denied".
PERMISSION_MACROS = [
    'PERMISSION_LOCATION=1',
    'PERMISSION_LOCATION_WHENINUSE=0',
    'PERMISSION_MICROPHONE=1',
    'PERMISSION_NOTIFICATIONS=1',
]


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in IDENTITY:
        print('usage: patch_ios_project.py <rider|driver> [maps_key]')
        return 1
    bundle_id, name = IDENTITY[sys.argv[1]]
    maps_key = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else 'MISSING_KEY'

    pbx = Path('ios/Runner.xcodeproj/project.pbxproj')
    text = pbx.read_text(encoding='utf-8')
    # Only the app target (ends in the base id), not RunnerTests (.RunnerTests).
    text, n = re.subn(r'PRODUCT_BUNDLE_IDENTIFIER = [^;]*\.kwema;',
                      f'PRODUCT_BUNDLE_IDENTIFIER = {bundle_id};', text)
    pbx.write_text(text, encoding='utf-8')
    print(f'  bundle id -> {bundle_id} ({n} configs)')

    plist = Path('ios/Runner/Info.plist')
    p = plist.read_text(encoding='utf-8')
    p = re.sub(r'(<key>CFBundleDisplayName</key>\s*<string>)[^<]*(</string>)',
               rf'\g<1>{name}\g<2>', p)
    add = ''
    for k, v in PLIST_KEYS.items():
        if k not in p:
            add += f'\t<key>{k}</key>\n\t<string>{v}</string>\n'
    if add:
        p = p.replace('</dict>\n</plist>', add + '</dict>\n</plist>')
    plist.write_text(p, encoding='utf-8')
    print('  Info.plist updated')

    podfile = Path('ios/Podfile')
    if podfile.exists():
        pf = podfile.read_text(encoding='utf-8')
        if 'PERMISSION_MICROPHONE' not in pf:
            macros = ', '.join(f"'{m}'" for m in PERMISSION_MACROS)
            hook = (
                "    target.build_configurations.each do |config|\n"
                "      config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] ||= ['$(inherited)']\n"
                f"      config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] += [{macros}]\n"
                "    end\n"
            )
            pf, k = re.subn(r'(flutter_additional_ios_build_settings\(target\)\n)', r'\1' + hook.replace('\\', '\\\\'), pf, count=1)
            podfile.write_text(pf, encoding='utf-8')
            print(f'  Podfile permission macros added ({k})')

    # Maps SDK key. Insert at the top of didFinishLaunchingWithOptions so it
    # works with both the classic and the implicit-engine AppDelegate.
    delegate = Path('ios/Runner/AppDelegate.swift')
    d = delegate.read_text(encoding='utf-8')
    if 'GMSServices' not in d:
        d = d.replace('import Flutter', 'import Flutter\nimport GoogleMaps', 1)
        d, m = re.subn(r'(didFinishLaunchingWithOptions[^{]*\{)',
                       rf'\1\n    GMSServices.provideAPIKey("{maps_key}")', d, count=1)
        delegate.write_text(d, encoding='utf-8')
        print(f'  Maps key inserted ({m})')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
