#!/bin/bash
# TikTok PiP when Firefox is on another desktop or covered, in a throwaway headless GNOME Shell
# (Wayland). Settings go to a keyfile in a temp folder, never to the real dconf. With
# ~/Projects/gnome-pip-everywhere present, PiP Everywhere is loaded and checked too.
#   tests/desktops.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
# Short: Wayland socket paths are limited to 108 bytes.
T="$(mktemp -d /tmp/tiktok-pip.XXXX)"
# The shell's document portal and gvfs can hold mounts in the runtime folder for a few seconds.
# Anything the test session started that's still around (its D-Bus services) is stopped too.
cleanup() {
    set +e
    for p in /proc/[0-9]*; do
        grep -qas "XDG_RUNTIME_DIR=$T/rt" "$p/environ" && kill "${p#/proc/}" 2>/dev/null
    done
    for _ in 1 2 3 4 5 6 7 8; do
        fusermount -uq "$T/rt/doc" 2>/dev/null
        fusermount -uq "$T/rt/gvfs" 2>/dev/null
        rm -rf "$T" 2>/dev/null && return
        sleep 1
    done
}
trap cleanup EXIT
mkdir -p "$T"/{home,config/glib-2.0/settings,data/gnome-shell/extensions,state,cache,rt,out}
chmod 700 "$T/rt"
cp -r "$HERE/desktops-test@tests" "$T/data/gnome-shell/extensions/"
EXTS="'desktops-test@tests'"
PIPE="$HOME/Projects/gnome-pip-everywhere/extension/pip-everywhere@aimanelahssini"
if [ -d "$PIPE" ]; then
    cp -r "$PIPE" "$T/data/gnome-shell/extensions/"
    EXTS="'pip-everywhere@aimanelahssini', $EXTS"
    export WITH_PIP_EVERYWHERE=1
fi
cat > "$T/config/glib-2.0/settings/keyfile" <<KF
[org/gnome/shell]
enabled-extensions=[$EXTS]
disable-user-extensions=false
welcome-dialog-last-shown-version='999'

[org/gnome/mutter]
dynamic-workspaces=false
num-workspaces=2
KF
read -r FIREFOX < <(SCRATCH="$T" node "$HERE/desktops.mjs" prepare)
dconf dump / > "$T/dconf-before.txt"
env -u WAYLAND_DISPLAY -u DISPLAY -u DBUS_SESSION_BUS_ADDRESS \
    HOME="$T/home" XDG_CONFIG_HOME="$T/config" XDG_DATA_HOME="$T/data" XDG_STATE_HOME="$T/state" \
    XDG_CACHE_HOME="$T/cache" XDG_RUNTIME_DIR="$T/rt" GSETTINGS_BACKEND=keyfile \
    TT_OUT="$T/out" TT_FIREFOX="$FIREFOX" TT_COVER="$HERE/cover.js" DEBUG="$DEBUG" \
    dbus-run-session -- timeout 150 gnome-shell --headless --wayland --virtual-monitor 1280x800 \
    > "$T/shell.log" 2>&1 &
SHELL_PID=$!
status=0
PORT=$(sed -E "s/.*--remote-debugging-port=([0-9]+).*/\1/" <<< "$FIREFOX")
node "$HERE/desktops.mjs" run "$PORT" "$T/out" || status=$?
# Stopping GNOME Shell itself lets dbus-run-session close its bus and services.
kill "$(cat "$T/out/shell.pid")" 2>/dev/null || true
wait "$SHELL_PID" 2>/dev/null || true
dconf dump / > "$T/dconf-after.txt"
if diff "$T/dconf-before.txt" "$T/dconf-after.txt" | grep -qiE 'enabled-extensions|workspaces'; then
    echo "REAL DCONF CHANGED"
    status=1
fi
grep -E 'JS ERROR|desktops-test' "$T/shell.log" | head -5 || true
[ -n "$DEBUG" ] && grep -E 'pip-everywhere|desktops-test' "$T/shell.log" | head -20
true
exit $status
