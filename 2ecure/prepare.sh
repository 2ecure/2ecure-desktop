#!/usr/bin/env bash
# 2ecure: puts Element Web into apps/desktop/webapp the way chat.2ecure.com serves it, before the app is packed.
#
#   bash 2ecure/prepare.sh            (from the repository root; macOS bash 3.2, Git Bash on Windows, Linux)
#
# 1. Downloads Element Web's release package of the pinned version (2ecure/UPSTREAM) and checks its SHA-256.
# 2. Applies the same 2ecure changes as the server (source: github.com/2ecure/2ecure-web and the 2ecure-messenger
#    project): brand.sh (page title), the runtime module 2ecure (welcome text, help links, «Who can find you?»), its
#    translations, the 2ecure icons over Element's, and config.json (2ecure/config.json: the server's with the
#    desktop app's differences, written by the project's desktop/make_config.py).
#
# Fails when anything does not fit the release (a renamed icon, a brand marker brand.sh cannot find), so a new
# Element release can never ship half-branded. Packing (pnpm run asar-webapp) and building come afterwards.
# Needs: curl, tar, jq, and sha256sum or shasum.
set -euo pipefail
cd "$(dirname "$0")/.."
. 2ecure/UPSTREAM
D=apps/desktop
mkdir -p "$D/packages"
TGZ="$D/packages/$(basename "$WEBAPP_URL")"
if [ ! -s "$TGZ" ]; then curl -fsSL --retry 3 -o "$TGZ.part" "$WEBAPP_URL" && mv "$TGZ.part" "$TGZ"; fi
if command -v sha256sum >/dev/null; then SUM=$(sha256sum "$TGZ" | cut -d' ' -f1); else SUM=$(shasum -a 256 "$TGZ" | cut -d' ' -f1); fi
[ "$SUM" = "$WEBAPP_SHA256" ] || { echo "prepare: $TGZ has SHA-256 $SUM, expected $WEBAPP_SHA256" >&2; exit 1; }

W="$D/webapp"
rm -rf "$W" && mkdir -p "$W"
tar xzf "$TGZ" -C "$W" --strip-components=1

# Page title and app names (the same script as the server's init container «brand»).
B=$(mktemp -d)
STRICT=1 sh 2ecure/web/brand.sh "$W" "$B"
cp "$B/index.html" "$W/index.html"; cp "$B/manifest.json" "$W/manifest.json"
cp "$B/mobile_guide.html" "$W/mobile_guide/index.html"; rm -rf "$B"

# The runtime module and its translations (config.json names modules/2ecure/index.js and translations.json).
mkdir -p "$W/modules/2ecure"
cp 2ecure/web/modules/2ecure/* "$W/modules/2ecure/"

# Icons: every file the server mounts over Element's (2ecure/web/icons.txt, from the project's 60-elementweb.yaml).
while read -r target source; do
  case "$target" in ''|'#'*) continue ;; esac
  [ -f "$W/$target" ] || { echo "prepare: Element Web has no $target any more: update the icon list" >&2; exit 1; }
  cp "2ecure/web/icons/$source" "$W/$target"
done < 2ecure/web/icons.txt
# ...and every icon index.html and manifest.json link is one of them.
for icon in $( (grep -o 'vector-icons/[^"]*' "$W/index.html"; jq -r '.icons[].src' "$W/manifest.json") | sed 's|^/||' | sort -u); do
  grep -q "^$icon " 2ecure/web/icons.txt || { echo "prepare: $icon is linked but not replaced" >&2; exit 1; }
done

cp 2ecure/config.json "$W/config.json"
if grep -rqE '"(https?://)?[a-z.]*element\.io' "$W/config.json"; then echo "prepare: element.io in config.json" >&2; exit 1; fi
echo "prepare: Element Web $(cat "$W/version") ready in $W with the 2ecure config, module and icons"
