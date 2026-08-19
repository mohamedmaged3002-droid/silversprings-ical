#!/usr/bin/env bash
# publish-ota-pack.sh — rebuild the OTA pack and push it to the same Drive folder
# the OTA team already uses for the photos, so the link they have never changes.
#
# Needs NO email secrets. This is the delivery route that works today; the email
# attachment in send-alert.js is the same file, sent rather than fetched.
#
# Drive account: `bluekeys:` == maged@bluekeys.co (NOT `gdrive:`).
# Uploading to the SAME path each time keeps the file id, and therefore the share
# link, stable — the OTA team can bookmark it. Do not rename or re-create it.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PACK="/Users/MAGED/inv/Silver Springs OTA Listing Pack.xlsx"
DEST="bluekeys:BlueKeys Photos/Silver Springs Unit Photos"

echo "==> rebuilding the pack from live Supabase rows"
python3 "$HERE/scripts/build-ota-xlsx.py"

echo "==> uploading to Drive (same path => same share link)"
rclone copyto "$PACK" "$DEST/$(basename "$PACK")"

echo "==> verifying"
rclone lsl "$DEST/$(basename "$PACK")"

echo
echo "OTA team folder (photos + this pack):"
rclone link "$DEST"
echo
echo "Pack direct link:"
rclone link "$DEST/$(basename "$PACK")"
