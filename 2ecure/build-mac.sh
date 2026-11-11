#!/bin/bash
# 2ecure: build the macOS app (one app for Intel and Apple silicon), the same steps on any Mac.
#
#   bash 2ecure/build-mac.sh <version> [unsigned]          from the repository root; result in apps/desktop/dist
#
# <version>: 1.12.<Element patch × 100 + 2ecure build>, e.g. 1.12.3301 = Element 1.12.33, 2ecure build 1.
# Signed (the default): a «Developer ID Application» identity in the keychain list, APPLE_TEAM_ID, and for
# notarisation APPLE_API_KEY (path of the App Store Connect .p8), APPLE_API_KEY_ID and APPLE_API_ISSUER.
# Needs node 24 and pnpm 12 on PATH, Xcode 26 (actool compiles build/icon.icon), python3 with pyobjc Quartz (DMG
# badge), jq. In the 2ecure project the build Mac runs this through scripts/mac/desktop-mac.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=${1:?version, e.g. 1.12.3301}; MODE=${2:-signed}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be X.Y.Z" >&2; exit 1; }
echo "node $(node --version), pnpm $(pnpm --version), $(xcodebuild -version | head -1), $(sysctl -n hw.ncpu) CPUs"

bash 2ecure/prepare.sh
# Both architectures' prebuilt search index libraries (seshat) for the universal app, as Element's own CI does.
grep -q '^supportedArchitectures:' pnpm-workspace.yaml || printf '\nsupportedArchitectures:\n    os: [current]\n    cpu: [x64, arm64]\n' >> pnpm-workspace.yaml

cd apps/desktop
pnpm install --frozen-lockfile --filter element-desktop
pnpm run asar-webapp
rm -rf dist
export VARIANT_PATH=../../2ecure/variant.json VERSION
# Nx caches the «build» target by its source files only: a new VERSION or signing mode would get the previous
# build's dist back. Every release build packs afresh.
export NX_SKIP_NX_CACHE=true NX_DAEMON=false
if [ "$MODE" = unsigned ]; then
  CSC_IDENTITY_AUTO_DISCOVERY=false pnpm run build:universal --publish never -m dmg zip
else
  : "${APPLE_TEAM_ID:?}" "${APPLE_API_KEY:?}" "${APPLE_API_KEY_ID:?}" "${APPLE_API_ISSUER:?}"
  pnpm run build:universal --publish never -m dmg zip
fi

APP=dist/mac-universal/2ecure.app
ls -la dist
echo "architectures: $(lipo -archs "$APP/Contents/MacOS/2ecure")"
[ "$(lipo -archs "$APP/Contents/MacOS/2ecure")" = "x86_64 arm64" ] || { echo "not a universal app" >&2; exit 1; }
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' -c 'Print :CFBundleShortVersionString' \
  -c 'Print :CFBundleURLTypes:0:CFBundleURLSchemes' "$APP/Contents/Info.plist"
if [ "$MODE" != unsigned ]; then
  codesign --verify --deep --strict --verbose=2 "$APP"
  codesign -dv --verbose=4 "$APP" 2>&1 | grep -E '^(Authority|TeamIdentifier|Runtime|Identifier)'
  xcrun stapler validate "$APP"
  spctl -a -t exec -vv "$APP"
  # The app as users get it: from the DMG.
  MNT=$(mktemp -d)
  trap 'hdiutil detach "$MNT" >/dev/null 2>&1 || true; rmdir "$MNT" 2>/dev/null || true' EXIT
  hdiutil attach -nobrowse -readonly -mountpoint "$MNT" dist/*.dmg >/dev/null
  spctl -a -t exec -vv "$MNT/2ecure.app"
  codesign -d --entitlements :- "$MNT/2ecure.app" 2>/dev/null | grep -o 'com\.apple\.security\.[a-z.-]*' | sort -u
fi
shasum -a 256 dist/*.dmg dist/*.zip
echo "RESULT=ok $VERSION $MODE"
