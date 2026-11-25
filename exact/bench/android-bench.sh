#!/usr/bin/env bash
# Android runtime bench for the Exact app's debug APK — the same logical
# scenarios as exact/bench/crossbench.ts (web), driven over adb against a
# headless x86_64 emulator. Method notes:
#
# - cold start / first render: `am start -W` TotalTime, force-stop before
#   each of 5 iterations, median reported.
# - memory: `dumpsys meminfo` TOTAL PSS after boot and after the huge PR.
# - scroll jank: `dumpsys gfxinfo <pkg> framestats` reset before each
#   scenario, swipe-driven scrolling, then the gfxinfo summary's janky-frame
#   percentage and p95 frame duration. Android renders at the display's vsync;
#   janky% is the platform's own jank measure.
# - open-pr / open-huge-pr: `uiautomator dump` locates the row by its text,
#   the tap lands at its center; wall time is tap-to-quiescent (gfxinfo frame
#   count stable for two consecutive 200ms polls) — coarse, documented as such.
# - type-filter and keyboard scenarios are not applicable: Android delivers
#   keys only to a focused field, and the fixture build has no hardware
#   keyboard; filtering is not part of the touch flow.
#
# Usage: exact/bench/android-bench.sh <apk-path>  (emulator already booted)
set -u
PKG=dev.experiment.exactreview
APK=${1:?apk path}
OUT=${2:-/tmp/android-bench.txt}
# adb comes from the Android SDK: $ADB wins, then the usual SDK env vars, then PATH.
ADB="${ADB:-${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}/platform-tools/adb}"
command -v "$ADB" >/dev/null 2>&1 || ADB=adb
export ADB

exec 3>"$OUT"
say() { echo "$@" | tee /dev/fd/3; }

say "android bench $(date -u +%FT%TZ)"
$ADB install -r "$APK" >/dev/null 2>&1 && say "install: ok" || say "install: FAILED"

# resolve launcher activity once
ACT=$($ADB shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER $PKG 2>/dev/null | tr -d '\r' | tail -1)
say "activity: $ACT"

# --- cold start, 5 iterations ---
times=()
for i in 1 2 3 4 5; do
  $ADB shell am force-stop $PKG
  sleep 1
  t=$($ADB shell am start -W -n "$ACT" 2>/dev/null | tr -d '\r' | grep '^TotalTime' | head -1 | awk '{print $2}')
  times+=("$t")
done
sorted=$(printf '%s\n' "${times[@]}" | sort -n)
median=$(printf '%s\n' "$sorted" | awk 'NR==3')
say "cold start TotalTime ms (5 runs): ${times[*]} median $median"
sleep 2

mem_total() { $ADB shell dumpsys meminfo $PKG 2>/dev/null | tr -d '\r' | grep -m1 'TOTAL PSS' | awk '{print $3}'; }
say "meminfo TOTAL PSS KB after cold start: $(mem_total)"

# helper: tap the node whose text matches exactly, using uiautomator bounds
tap_text() {
  local needle="$1"
  $ADB shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  $ADB pull /sdcard/ui.xml /tmp/ui.xml >/dev/null 2>&1
  python3 - "$needle" <<'PYEOF'
import os, re, sys, subprocess
xml = open('/tmp/ui.xml', encoding='utf-8', errors='replace').read()
needle = sys.argv[1]
best = None
for m in re.finditer(r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml):
    if needle in m.group(1):
        x = (int(m.group(2)) + int(m.group(4))) // 2
        y = (int(m.group(3)) + int(m.group(5))) // 2
        best = (x, y)
        break
if best:
    subprocess.run([os.environ['ADB'], 'shell', 'input', 'tap', str(best[0]), str(best[1])])
    print('tapped', best, file=sys.stderr)
else:
    print('NOT FOUND: ' + needle, file=sys.stderr)
    sys.exit(1)
PYEOF
}

frames() { $ADB shell dumpsys gfxinfo $PKG framestats 2>/dev/null | tr -d '\r' | grep -c 'IntendedVsync'; }
quiesce() { # wait until frame count stable across two 200ms polls, print wall ms
  local start=$(date +%s%3N) last count stable=0
  last=$(frames)
  for i in $(seq 1 75); do
    sleep 0.2
    count=$(frames)
    if [ "$count" = "$last" ]; then stable=$((stable+1)); else stable=0; fi
    last=$count
    [ $stable -ge 2 ] && break
  done
  echo $(( $(date +%s%3N) - start ))
}

jank() { # gfxinfo summary for the most recent window: janky% and p95
  $ADB shell dumpsys gfxinfo $PKG 2>/dev/null | tr -d '\r' | awk '/Janky frames:/{j=$0} /95th percentile:/{p=$0} END{print j" | "p}'
}

# --- navigate-list scroll jank: 20 fling swipes on the queue ---
$ADB shell am force-stop $PKG; sleep 1
$ADB shell am start -W -n "$ACT" >/dev/null 2>&1; sleep 3
$ADB shell dumpsys gfxinfo $PKG reset >/dev/null 2>&1
for i in $(seq 1 20); do $ADB shell input swipe 540 1400 540 700 150; sleep 0.15; done
sleep 1
say "navigate-list scroll: $(jank)"

# --- open-pr: tap row #40005, wall to quiescent ---
$ADB shell input swipe 540 700 540 1400 200; sleep 0.5  # scroll back to top
$ADB shell input keyevent KEYCODE_MOVE_HOME 2>/dev/null
tap_text '#40005' 2>/dev/null || tap_text '40005' 2>/dev/null
wall=$(quiesce)
$ADB shell dumpsys gfxinfo $PKG reset >/dev/null 2>&1
sleep 0.3
say "open-pr tap-to-quiescent ms: $wall"

# --- scroll-diff jank: 20 swipes inside the diff ---
for i in $(seq 1 20); do $ADB shell input swipe 540 1400 540 700 150; sleep 0.15; done
sleep 1
say "scroll-diff: $(jank)"

# --- back, open huge PR #40010, wall to quiescent + memory ---
$ADB shell input keyevent KEYCODE_BACK; sleep 1
tap_text '#40010' 2>/dev/null || tap_text '40010' 2>/dev/null
wall=$(quiesce)
say "open-huge-pr tap-to-quiescent ms: $wall"
sleep 1
say "meminfo TOTAL PSS KB after huge pr: $(mem_total)"
say "done"
exec 3>&-
cat "$OUT"
