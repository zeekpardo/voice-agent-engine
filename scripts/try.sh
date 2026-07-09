#!/usr/bin/env bash
# Quick manual tester for the voice-gateway transcribe endpoint.
#
#   ./scripts/try.sh --say "hello there"     # speak text -> transcribe (no mic needed)
#   ./scripts/try.sh --record 5              # record 5s from your mic -> transcribe
#   ./scripts/try.sh path/to/audio.m4a       # transcribe an existing file
#
# Key resolution: $VOICE_KEY env var, else the .test-key file in the repo root.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATEWAY="${VOICE_GATEWAY_URL:-http://localhost:8787}"
KEY="${VOICE_KEY:-$(cat "$ROOT/.test-key" 2>/dev/null || true)}"

if [ -z "$KEY" ]; then
  echo "❌ No API key. Set VOICE_KEY=vk_live_... or create $ROOT/.test-key" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
WAV="$TMP/audio.wav"

case "${1:-}" in
  --say)
    [ -n "${2:-}" ] || { echo "usage: try.sh --say \"text to speak\""; exit 1; }
    echo "🗣️  synthesizing: \"$2\""
    say -o "$TMP/s.aiff" "$2"
    ffmpeg -y -i "$TMP/s.aiff" -ar 16000 -ac 1 "$WAV" >/dev/null 2>&1
    ;;
  --record)
    SECS="${2:-5}"
    echo "🎙️  recording ${SECS}s from your mic (grant Terminal mic access if prompted)…"
    ffmpeg -y -f avfoundation -i ":0" -t "$SECS" -ar 16000 -ac 1 "$WAV" >/dev/null 2>&1
    ;;
  "")
    echo "usage: try.sh [--say \"text\" | --record [seconds] | <audiofile>]"; exit 1
    ;;
  *)
    [ -f "$1" ] || { echo "❌ file not found: $1"; exit 1; }
    echo "📄 transcribing file: $1"
    ffmpeg -y -i "$1" -ar 16000 -ac 1 "$WAV" >/dev/null 2>&1
    ;;
esac

echo "⏳ sending to $GATEWAY/v1/transcribe …"
RESP="$(curl -s -w '\n%{http_code}' \
  -X POST -H "Authorization: Bearer $KEY" \
  -F "language=en" \
  -F "file=@$WAV;type=audio/wav" \
  "$GATEWAY/v1/transcribe")"

CODE="$(echo "$RESP" | tail -1)"
BODY="$(echo "$RESP" | sed '$d')"

echo
if [ "$CODE" = "200" ]; then
  if command -v jq >/dev/null 2>&1; then
    echo "✅ [$CODE]  \"$(echo "$BODY" | jq -r .text)\""
  else
    echo "✅ [$CODE]  $BODY"
  fi
else
  echo "⚠️  [$CODE]  $BODY"
fi
