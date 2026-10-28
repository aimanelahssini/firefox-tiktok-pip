#!/bin/bash
# Removes TikTok picture-in-picture from Firefox, and our mozilla.cfg if nothing else uses it.
# Asks for your password (pkexec). Also installed into Firefox's autoconfig.d/tiktok-pip/.
FF=${FIREFOX_DIR:-$(dirname "$(readlink -f /usr/lib64/firefox/firefox 2>/dev/null || readlink -f /usr/lib/firefox/firefox)")}
[ -d "$FF/autoconfig.d/tiktok-pip" ] || exit 0
if [ ! -w "$FF" ]; then
    exec pkexec env FIREFOX_DIR="$FF" bash "$(readlink -f "$0")"
fi
rm -rf "$FF/autoconfig.d/tiktok-pip"
rmdir "$FF/autoconfig.d" 2>/dev/null || true
if [ ! -d "$FF/autoconfig.d" ]; then
    for f in "$FF/mozilla.cfg" "$FF/defaults/pref/autoconfig.js"; do
        grep -qs '^// tiktok-pip' "$f" && rm -f "$f"
    done
fi
echo "Removed. Restart Firefox"
