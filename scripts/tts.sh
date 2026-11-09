#!/usr/bin/env bash
set -e

DATE="${1:-$(date +%Y-%m-%d)}"
# Mandarin/Taiwanese-Mandarin female voice. Override with TTS_VOICE=... TTS_PITCH=... TTS_RATE=...
VOICE="${TTS_VOICE:-zh-TW-HsiaoChenNeural}"
PITCH="${TTS_PITCH:-}"
RATE="${TTS_RATE:-}"
INPUT_TXT="output/data/$DATE/summary.txt"
OUT_AUDIO="remotion/public/worlds/narration.mp3"
OUT_VTT="remotion/public/worlds/narration.vtt"

if [ ! -f "$INPUT_TXT" ]; then
  echo "Error: $INPUT_TXT not found!"
  exit 1
fi

echo "=== Running edge-tts voice synthesis ($VOICE) ==="
mkdir -p remotion/public/worlds
EXTRA=()
[ -n "$PITCH" ] && EXTRA+=(--pitch="$PITCH")
[ -n "$RATE" ] && EXTRA+=(--rate="$RATE")
edge-tts --voice "$VOICE" "${EXTRA[@]}" \
  --file "$INPUT_TXT" \
  --write-media "$OUT_AUDIO" \
  --write-subtitles "$OUT_VTT"

echo "✅ Generated:"
echo " - $OUT_AUDIO"
echo " - $OUT_VTT"
