#!/bin/bash
# install.sh/uninstall.sh against fake Firefox folders: no mozilla.cfg yet, my-gnome-setup's
# older one (without the loader), and someone else's.
#   tests/install.test.sh
cd "$(dirname "$0")/.."
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0 fail=0
check() { if eval "$2"; then echo "PASS $1"; pass=$((pass + 1)); else echo "FAIL $1"; fail=$((fail + 1)); fi; }
fake() { rm -rf "$T/ff"; mkdir -p "$T/ff/defaults/pref"; }
run() { FIREFOX_DIR="$T/ff" bash "$1" > "$T/out" 2>&1; }

fake
run install.sh
check "no mozilla.cfg: ours installed" "grep -q '^// tiktok-pip' $T/ff/mozilla.cfg && grep -q tiktok-pip $T/ff/defaults/pref/autoconfig.js"
check "files in autoconfig.d/tiktok-pip" "test -f $T/ff/autoconfig.d/tiktok-pip/main.sys.mjs -a -f $T/ff/autoconfig.d/tiktok-pip/uninstall.sh"
run install.sh
check "second run: nothing to do" "grep -q 'up to date' $T/out"
echo "// changed" >> "$T/ff/autoconfig.d/tiktok-pip/player.css"
run install.sh
check "changed file: installed again" "grep -q Installed $T/out && cmp -s tiktok-pip/player.css $T/ff/autoconfig.d/tiktok-pip/player.css"
run "$T/ff/autoconfig.d/tiktok-pip/uninstall.sh"
check "uninstall: all gone" "test ! -e $T/ff/autoconfig.d -a ! -e $T/ff/mozilla.cfg -a ! -e $T/ff/defaults/pref/autoconfig.js"

fake
printf '// my-gnome-setup: Ctrl+1…9 switches Firefox tabs\ntry {} catch (e) {}\n' > "$T/ff/mozilla.cfg"
printf '// my-gnome-setup: load mozilla.cfg\n' > "$T/ff/defaults/pref/autoconfig.js"
run install.sh
check "my-gnome-setup's older mozilla.cfg: loader added, rest kept" \
    "grep -q '^// my-gnome-setup' $T/ff/mozilla.cfg && grep -q '^// >>> autoconfig.d' $T/ff/mozilla.cfg && grep -q '^// my-gnome-setup' $T/ff/defaults/pref/autoconfig.js"
run install.sh
check "…added once" "test \$(grep -c '>>> autoconfig.d' $T/ff/mozilla.cfg) = 1"
run uninstall.sh
check "uninstall keeps my-gnome-setup's files" "test -f $T/ff/mozilla.cfg -a -f $T/ff/defaults/pref/autoconfig.js -a ! -e $T/ff/autoconfig.d"

fake
printf '// corporate policy\n' > "$T/ff/mozilla.cfg"
run install.sh
check "someone else's mozilla.cfg: left alone" "test \"\$(cat $T/ff/mozilla.cfg)\" = '// corporate policy' && grep -q 'by hand' $T/out"

if [ -f ~/Projects/my-gnome-setup/files/firefox-tabs/mozilla.cfg ]; then
    check "my-gnome-setup's loader is the same as ours" \
        "diff <(sed -n '/>>> autoconfig.d/,\$p' mozilla.cfg) <(sed -n '/>>> autoconfig.d/,\$p' ~/Projects/my-gnome-setup/files/firefox-tabs/mozilla.cfg) >/dev/null"
fi
echo
echo "$pass/$((pass + fail)) passed"
[ $fail = 0 ]
