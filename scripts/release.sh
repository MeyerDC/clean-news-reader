#!/usr/bin/env bash
#
# Builds a signed release APK and proves it contains the web bundle that was
# just built.
#
# The step this exists to enforce is `cap sync`: the Angular build writes to
# www/, Gradle packages android/app/src/main/assets/public/, and only cap sync
# joins the two. Skip it and Gradle will happily ship yesterday's JavaScript
# inside today's APK — with the right version number, the right signature and
# every other check passing.
#
# Comparing chunk *names* is not enough: a rebuild can keep a chunk's name and
# change its contents, which is exactly how a fix went missing once. So every
# file is compared by hash.
#
# Usage:
#   scripts/release.sh              build, sync, assemble, verify
#   scripts/release.sh --verify     verify an existing APK against www/ only

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
APK="$ROOT/android/app/build/outputs/apk/release/app-release.apk"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[31mFAILED: %s\033[0m\n' "$1" >&2; exit 1; }

verify_assets() {
  [ -f "$APK" ] || die "no APK at $APK"
  command -v unzip >/dev/null || die "unzip not found"

  local checked=0 stale=0 missing=0

  # The APK's file list, read once. Membership is checked against this rather
  # than by letting unzip fail: unzip exits 11 for "not in archive", and under
  # `set -euo pipefail` that aborts the script silently — the guard would look
  # like it passed while never reporting the very thing it exists to catch.
  local listing
  listing=$(unzip -Z1 "$APK" 2>/dev/null || true)

  # Everything the browser actually loads. Assets referenced by these are
  # content-hashed by the build, so this set is what can go stale.
  while IFS= read -r file; do
    local rel="${file#"$ROOT"/www/}"
    checked=$((checked + 1))

    if ! grep -qxF "assets/public/$rel" <<<"$listing"; then
      printf '  MISSING from APK: %s\n' "$rel"
      missing=$((missing + 1))
      continue
    fi

    local want have
    want=$(shasum -a 256 "$file" | cut -d' ' -f1)
    have=$(unzip -p "$APK" "assets/public/$rel" 2>/dev/null | shasum -a 256 | cut -d' ' -f1)
    if [ "$want" != "$have" ]; then
      printf '  STALE in APK:     %s\n' "$rel"
      stale=$((stale + 1))
    fi
  done < <(find "$ROOT/www" -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' \))

  [ "$checked" -gt 0 ] || die "found nothing in www/ to compare — was the web build run?"

  if [ "$stale" -gt 0 ] || [ "$missing" -gt 0 ]; then
    die "$stale stale and $missing missing file(s). Run 'npx cap sync android', then rebuild."
  fi

  printf '  %s file(s) in the APK match the build in www/\n' "$checked"
}

report() {
  local signer
  signer=$(ls "$HOME"/Library/Android/sdk/build-tools/*/apksigner 2>/dev/null | tail -1 || true)

  say "Release"
  grep -E 'versionCode|versionName' android/app/build.gradle | sed 's/^ */  /'
  printf '  apk: %s (%s bytes)\n' "$APK" "$(wc -c < "$APK" | tr -d ' ')"
  if [ -n "$signer" ]; then
    "$signer" verify --print-certs "$APK" 2>/dev/null \
      | grep -i 'SHA-256 digest' | head -1 | sed 's/^/  /'
  fi
}

if [ "${1:-}" = "--verify" ]; then
  say "Verifying APK against www/"
  verify_assets
  report
  exit 0
fi

say "Building the web bundle"
npm run build

say "Syncing into Android (the step that is easy to forget)"
npx cap sync android

say "Assembling the signed release"
(cd android && ./gradlew :app:assembleRelease -q)

say "Verifying the APK carries this build"
verify_assets
report
