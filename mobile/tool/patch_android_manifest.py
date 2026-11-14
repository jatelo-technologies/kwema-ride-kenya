#!/usr/bin/env python3
"""Inject the Maps SDK key and required permissions into AndroidManifest.xml.

Run after `flutter create` regenerates the android/ folder. Idempotent — safe
to run repeatedly, which matters because CI regenerates the platform files on
every build.

Usage: patch_android_manifest.py <manifest-path> <maps-api-key>

The key passed here is the *Android-restricted* Maps key (SHA-1 + package
name). The server key must never reach an APK: APKs get unpacked, and a
Directions-capable key inside one is someone else spending the Maps budget.
"""

import re
import sys

PERMISSIONS = [
    'android.permission.INTERNET',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    # Driver app: keeps GPS alive when the driver switches to WhatsApp or
    # navigation mid-trip. Without it the breadcrumb trail has holes, and the
    # fare is computed from that trail.
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_LOCATION',
    'android.permission.WAKE_LOCK',
    # Driver app: keep reporting position and receiving requests with the
    # screen off or another app (navigation, WhatsApp) in front.
    'android.permission.ACCESS_BACKGROUND_LOCATION',
    # Android 13+: required for the "You are online" notification that keeps
    # the background service visible and alive.
    'android.permission.POST_NOTIFICATIONS',
    # Lets the driver app ask to be exempt from battery optimisation, which
    # cheaper phones use to kill background apps.
    'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
    # In-app audio calls between rider and driver.
    'android.permission.RECORD_AUDIO',
    'android.permission.MODIFY_AUDIO_SETTINGS',
    'android.permission.BLUETOOTH_CONNECT',
    'android.permission.ACCESS_NETWORK_STATE',
    # Driver app: a ride request lights the screen and opens over the lock
    # screen.
    'android.permission.USE_FULL_SCREEN_INTENT',
    'android.permission.VIBRATE',
]


def main() -> int:
    if len(sys.argv) < 3:
        print('usage: patch_android_manifest.py <manifest> <maps-key>')
        return 1

    path, key = sys.argv[1], sys.argv[2]

    with open(path, encoding='utf-8') as handle:
        xml = handle.read()

    added_permissions = []
    block = ''
    for permission in PERMISSIONS:
        if permission not in xml:
            block += f'    <uses-permission android:name="{permission}"/>\n'
            added_permissions.append(permission.rsplit('.', 1)[-1])

    if block:
        xml = re.sub(r'(<manifest[^>]*>)', r'\1\n' + block.rstrip(), xml, count=1)

    # Package visibility (Android 11+): needed to hand a destination to Google
    # Maps for spoken navigation.
    if '<queries>' not in xml:
        queries = (
            '\n    <queries>\n'
            '        <intent><action android:name="android.intent.action.VIEW"/>'
            '<data android:scheme="https"/></intent>\n'
            '    </queries>'
        )
        xml = re.sub(r'(<application)', queries.lstrip('\n') + r'\n    \1', xml, count=1)

    if 'com.google.android.geo.API_KEY' in xml:
        # Replace the existing value rather than adding a second meta-data
        # element, which would make the merged manifest ambiguous.
        xml = re.sub(
            r'(<meta-data\s+android:name="com\.google\.android\.geo\.API_KEY"\s+'
            r'android:value=")[^"]*(")',
            r'\g<1>' + key + r'\g<2>',
            xml,
        )
        key_action = 'replaced'
    else:
        meta = (
            f'\n        <meta-data android:name="com.google.android.geo.API_KEY"\n'
            f'            android:value="{key}"/>'
        )
        xml = re.sub(r'(<application[^>]*>)', r'\1' + meta, xml, count=1)
        key_action = 'inserted'

    # Let the main activity show over the lock screen and switch the screen
    # on, which is what makes a ride request interrupt a sleeping phone.
    def _activity(match):
        tag = match.group(0)
        for attr in ('showWhenLocked', 'turnScreenOn'):
            if f'android:{attr}' not in tag:
                tag = tag.replace('<activity', f'<activity android:{attr}="true"', 1)
        return tag
    xml = re.sub(r'<activity\b[^>]*android:name="[^"]*MainActivity"[^>]*>', _activity, xml, count=1)

    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(xml)

    print(f'maps key {key_action}')
    print(f'permissions added: {", ".join(added_permissions) or "none (already present)"}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
