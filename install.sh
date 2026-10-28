#!/bin/bash
# Installs TikTok picture-in-picture into Firefox (the system package): tiktok-pip/ goes into
# Firefox's own folder (autoconfig.d/), where Firefox's autoconfig loads it at startup. Package
# updates leave it in place. Asks for your password (pkexec) only when something changed.
# An existing mozilla.cfg from my-gnome-setup gets the loader added; without any, a small one is
# installed. Someone else's mozilla.cfg is never touched.
set -e
cd "$(dirname "$(readlink -f "$0")")"
FF=${FIREFOX_DIR:-$(dirname "$(readlink -f /usr/lib64/firefox/firefox 2>/dev/null || readlink -f /usr/lib/firefox/firefox)")}
[ -d "$FF/defaults/pref" ] || { echo "Firefox (the system package) not found, skipping"; exit 0; }
DEST="$FF/autoconfig.d/tiktok-pip"

up_to_date() {
    for f in tiktok-pip/*; do cmp -s "$f" "$DEST/$(basename "$f")" || return 1; done
    cmp -s uninstall.sh "$DEST/uninstall.sh" && grep -qs '^// >>> autoconfig.d' "$FF/mozilla.cfg"
}
if up_to_date; then
    echo "TikTok picture-in-picture is installed and up to date"
    exit 0
fi
if [ ! -w "$FF" ]; then
    exec pkexec env FIREFOX_DIR="$FF" bash "$PWD/install.sh"
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp tiktok-pip/* uninstall.sh "$DEST/"
chmod -R a+rX "$FF/autoconfig.d"

if grep -qs '^// >>> autoconfig.d' "$FF/mozilla.cfg"; then
    :
elif grep -qsE '^// (my-gnome-setup|tiktok-pip)' "$FF/mozilla.cfg"; then
    { echo; sed -n '/^\/\/ >>> autoconfig.d/,/^\/\/ <<< autoconfig.d/p' mozilla.cfg; } >> "$FF/mozilla.cfg"
elif [ -e "$FF/mozilla.cfg" ] || [ -e "$FF/defaults/pref/autoconfig.js" ]; then
    echo "$FF/mozilla.cfg isn't ours: add the part between '>>> autoconfig.d' and '<<< autoconfig.d'"
    echo "of this folder's mozilla.cfg to it by hand"
    exit 0
else
    install -m644 mozilla.cfg "$FF/mozilla.cfg"
    install -m644 autoconfig.js "$FF/defaults/pref/autoconfig.js"
fi
echo "Installed. Restart Firefox for TikTok picture-in-picture"
