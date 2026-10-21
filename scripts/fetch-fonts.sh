#!/usr/bin/env bash
# Fetch Switzer (ITF Free Font License) from Fontshare into apps/dashboard/public/fonts/.
# The FFL allows self-hosting on our own server but forbids redistribution, including a
# public repo, so the files are gitignored and every builder gets their own copy here.
# Files are copied unmodified (the FFL also forbids subsetting or conversion).
# Without them the dashboard still works and falls back to system fonts.
set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)/apps/dashboard/public/fonts"
URL="https://api.fontshare.com/v2/fonts/download/switzer"
WEB="Switzer_Complete/Fonts/WEB/fonts"

mkdir -p "$DEST"
if [ -s "$DEST/Switzer-Variable.woff2" ] && [ -s "$DEST/Switzer-VariableItalic.woff2" ]; then
  echo "fonts: Switzer already present in $DEST"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/switzer.zip" "$URL"

# extract <zip member> <output file>; unzip if present, else python3 (both stock on Ubuntu images)
extract() {
  if command -v unzip >/dev/null; then
    unzip -p "$TMP/switzer.zip" "$1" > "$2"
  else
    python3 -c 'import sys, zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))' \
      "$TMP/switzer.zip" "$1" > "$2"
  fi
  [ -s "$2" ] || { echo "fonts: $1 missing from the Fontshare zip" >&2; rm -f "$2"; exit 1; }
}

extract "$WEB/Switzer-Variable.woff2" "$DEST/Switzer-Variable.woff2"
extract "$WEB/Switzer-VariableItalic.woff2" "$DEST/Switzer-VariableItalic.woff2"
extract "Switzer_Complete/License/FFL.txt" "$DEST/Switzer-FFL.txt"
echo "fonts: Switzer fetched into $DEST"
