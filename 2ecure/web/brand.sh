#!/bin/sh
# 2ecure: branded copies of Element Web's index.html and manifest.json, and 2ecure's own mobile guide.
#
# Runs as the init container «brand» (deploy/ess/values/99-local.template.yaml) on the same image as Element Web,
# so the copies keep that release's bundle names; 60-elementweb.yaml mounts them over the originals. Link previews
# of shared links (https://chat.2ecure.com/#/room/...: messengers and mail clients read this page's meta tags),
# the browser tab before the app has loaded and installed web apps then say 2ecure instead of Element.
#
#   sh brand.sh [source dir] [output dir]      (default /app /branded; busybox sed and jq, as in the image)
#
# A marker that is not found (a new Element Web changed its index.html) is reported. STRICT=1 makes that fatal
# (scripts/check-ess-render.sh, against the release of the chart's Element Web); in the pod it only warns, because
# an unbranded page is better than no web client.
set -eu
SRC=${1:-/app}; OUT=${2:-/branded}

# Same wording and preview image as the website's home page (website/public/index.html).
DESC='2ecure ist ein geschlossener Messenger nur auf Einladung: Ende-zu-Ende-verschlüsselte Chats und Anrufe, betrieben in der Schweiz.'
META="<meta name=\"description\" content=\"$DESC\">\
<meta property=\"og:type\" content=\"website\">\
<meta property=\"og:site_name\" content=\"2ecure\">\
<meta property=\"og:title\" content=\"2ecure Messenger\">\
<meta property=\"og:description\" content=\"$DESC\">\
<meta property=\"og:locale\" content=\"de_CH\">\
<meta property=\"og:image\" content=\"https://2ecure.com/og-image.png\">\
<meta property=\"og:image:width\" content=\"1200\">\
<meta property=\"og:image:height\" content=\"630\">\
<meta property=\"og:image:alt\" content=\"2ecure\">\
<meta name=\"twitter:card\" content=\"summary_large_image\">"

sed -e 's|<title>Element</title>|<title>2ecure</title>|' \
    -e 's|<meta name="apple-mobile-web-app-title" content="Element">|<meta name="apple-mobile-web-app-title" content="2ecure">|' \
    -e 's|<meta name="application-name" content="Element">|<meta name="application-name" content="2ecure">|' \
    -e "s|<meta property=\"og:image\" content=\"[^\"]*\" */*>|$META|" \
    -e 's|Sorry, Element requires JavaScript|Sorry, 2ecure requires JavaScript|' \
    "$SRC/index.html" > "$OUT/index.html"
# related_applications: Element's own apps (Play, F-Droid, App Store); 2ecure's can go here once they are public.
jq '.name = "2ecure" | .short_name = "2ecure" | .theme_color = "#ffffff" | del(.related_applications)' "$SRC/manifest.json" > "$OUT/manifest.json"
# Element's mobile guide (/mobile_guide/, where phones without a room link land) offers only Element's apps:
# 2ecure's own page instead. Without it (an older ConfigMap) Element's page, so the mounted file always exists.
GUIDE="$(dirname "$0")/mobile_guide.html"
if [ -f "$GUIDE" ]; then cp "$GUIDE" "$OUT/mobile_guide.html"; else cp "$SRC/mobile_guide/index.html" "$OUT/mobile_guide.html"; fi

missing=
for marker in '<title>2ecure</title>' 'apple-mobile-web-app-title" content="2ecure"' 'application-name" content="2ecure"' \
              'og:image" content="https://2ecure.com/og-image.png"' 'og:title" content="2ecure Messenger"' 'Sorry, 2ecure requires'; do
  grep -qF "$marker" "$OUT/index.html" || missing="$missing [$marker]"
done
if grep -qE '<title>Element|content="Element|app\.element\.io' "$OUT/index.html"; then missing="$missing [Element left in index.html]"; fi
[ "$(jq -r '.name + "/" + .short_name' "$OUT/manifest.json")" = 2ecure/2ecure ] || missing="$missing [manifest.json name]"
if grep -qE 'im\.vector|/app/vector/' "$OUT/manifest.json"; then missing="$missing [Element apps left in manifest.json]"; fi
grep -qF 'skip_mobile_redirect' "$OUT/mobile_guide.html" && ! grep -qF 'io.element' "$OUT/mobile_guide.html" \
  || missing="$missing [mobile_guide.html]"

if [ -n "$missing" ]; then
  echo "brand.sh: not branded:$missing" >&2
  if [ "${STRICT:-0}" = 1 ]; then exit 1; fi
else
  echo "brand.sh: index.html, manifest.json and the mobile guide branded"
fi
