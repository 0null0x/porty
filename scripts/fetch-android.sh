#!/usr/bin/env bash
# Download the official Android-x86 ISO and verify it against the SHA-1
# published in the Android-x86 release note.  Fails loudly on any mismatch.
#
# usage: scripts/fetch-android.sh <output-dir>
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=../build/versions.env
source "$here/../build/versions.env"

out_dir="${1:?usage: fetch-android.sh <output-dir>}"
mkdir -p "$out_dir"
iso="$out_dir/$ANDROID_ISO_NAME"

verify() {
    local file="$1" size sum
    size="$(stat -c %s "$file")"
    if (( size < ANDROID_ISO_MIN_BYTES || size > ANDROID_ISO_MAX_BYTES )); then
        echo "::error::$file is $size bytes, expected between $ANDROID_ISO_MIN_BYTES and $ANDROID_ISO_MAX_BYTES" >&2
        return 1
    fi
    sum="$(sha1sum "$file" | cut -d' ' -f1)"
    if [[ "$sum" != "$ANDROID_ISO_SHA1" ]]; then
        echo "::error::SHA-1 mismatch for $file: got $sum, want $ANDROID_ISO_SHA1" >&2
        return 1
    fi
    echo "verified $file: $size bytes, sha1 $sum"
}

if [[ -f "$iso" ]]; then
    if verify "$iso"; then
        exit 0
    fi
    echo "cached ISO is bad, downloading again" >&2
    rm -f -- "$iso"
fi

read -r -a urls <<< "$ANDROID_ISO_URLS"
for url in "${urls[@]}"; do
    echo "downloading $url"
    if curl --fail --location --silent --show-error \
            --retry 4 --retry-delay 5 --retry-all-errors \
            --connect-timeout 30 --max-time 3600 \
            --user-agent "curl (porty build)" \
            --output "$iso.part" "$url"; then
        if verify "$iso.part"; then
            mv -- "$iso.part" "$iso"
            exit 0
        fi
    else
        echo "download failed: $url" >&2
    fi
    rm -f -- "$iso.part"
done

echo "::error::could not download a verified $ANDROID_ISO_NAME from any mirror" >&2
exit 1
