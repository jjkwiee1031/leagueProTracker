#!/usr/bin/env bash
# Master orchestrator for the Worlds daily match report pipeline.
# Scrapes the day's Swiss Stage matches, writes a Mandarin summary (LLM),
# renders TTS narration and builds a Remotion vertical video.
#
# Shows, while running: which stage is active, when it started, a live elapsed
# heartbeat for long stages, how long each stage took, and a final timing table
# (also written to output/logs/<DATE>_pipeline.log).
#
# Usage: scripts/run_pipeline.sh <YYYY-MM-DD> <tournament> [--skip-scrape] [--skip-render] [--stop-after-db] [--dry-run]
# Env: PIPELINE_HEARTBEAT=auto|on|off (default auto = TTY only), PIPELINE_HEARTBEAT_SECS=15
#      WORLDS_URL=<liquipedia page>  (default: 2026 Swiss Stage; set to .../Playoffs for Bo5)
set -euo pipefail

DATE="${1:?Usage: scripts/run_pipeline.sh <YYYY-MM-DD> <tournament> [--skip-scrape] [--skip-render] [--stop-after-db] [--dry-run]}"
TOURNAMENT="${2:?tournament name required (e.g. \"World Championship 2026\")}"
shift 2
SKIP_SCRAPE=0
SKIP_RENDER=0
DRY_RUN=0
STOP_AFTER_DB=0
for a in "$@"; do
  case "$a" in
    --skip-scrape) SKIP_SCRAPE=1 ;;
    --skip-render) SKIP_RENDER=1 ;;
    --stop-after-db) STOP_AFTER_DB=1 ;;
    --dry-run) DRY_RUN=1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TOTAL_STEPS=8
STEP_IDX=0
STEP_NAME=""
STEP_T0=0
STEP_SECS=()
STEP_NAMES=()
STEP_STATUS=()
PIPELINE_START=$(date +%s)
HB_PID=""

mkdir -p "output/logs"
LOG_FILE="output/logs/${DATE}_pipeline.log"
: > "$LOG_FILE"

BOLD=$'\033[1m'; DIM=$'\033[2m'; CYAN=$'\033[1;36m'; GREEN=$'\033[1;32m'
YEL=$'\033[1;33m'; RED=$'\033[1;41m'; RST=$'\033[0m'

now() { date +%s; }
hms() { date +%H:%M:%S; }
fmt() {
  local s=${1:-0}
  if [ "$s" -ge 60 ]; then printf '%dm%02ds' $((s / 60)) $((s % 60)); else printf '%ds' "$s"; fi
}
elapsed_since() { local t=${1:-0}; printf '%d' "$(( $(now) - t ))"; }

# --- live heartbeat: only on a real terminal, so piped/captured logs stay clean
heartbeat_start() {
  local mode="${PIPELINE_HEARTBEAT:-auto}"
  if [ "$mode" = "off" ]; then return 0; fi
  if [ "$mode" = "auto" ] && [ ! -t 1 ]; then return 0; fi
  local label="$1"
  local t0="$STEP_T0"
  local every="${PIPELINE_HEARTBEAT_SECS:-15}"
  (
    while :; do
      sleep "$every"
      printf '\n%s   ⏱  %s … %s elapsed  (%s)%s\n' "$DIM" "$label" "$(fmt "$(( $(now) - t0 ))")" "$(hms)" "$RST"
    done
  ) &
  HB_PID=$!
}
heartbeat_stop() {
  if [ -n "${HB_PID:-}" ]; then
    kill "$HB_PID" 2>/dev/null || true
    wait "$HB_PID" 2>/dev/null || true
    HB_PID=""
  fi
}

step_begin() {
  STEP_IDX=$((STEP_IDX + 1))
  STEP_NAME="$1"
  STEP_T0=$(now)
  printf '\n%s▶ STEP %d/%d%s  %s   %s(started %s)%s\n' \
    "$CYAN" "$STEP_IDX" "$TOTAL_STEPS" "$RST" "$STEP_NAME" "$DIM" "$(hms)" "$RST"
}
step_end() {
  local d
  d=$(elapsed_since "$STEP_T0")
  STEP_NAMES[$STEP_IDX]="$STEP_NAME"
  STEP_SECS[$STEP_IDX]=$d
  STEP_STATUS[$STEP_IDX]="ok"
  printf '%s✔ %s%s  %s%s%s\n' "$GREEN" "$STEP_NAME" "$RST" "$DIM" "$(fmt "$d")" "$RST"
  printf '%d\t%s\t%d\tok\n' "$STEP_IDX" "$STEP_NAME" "$d" >>"$LOG_FILE"
}
step_skip() {
  STEP_IDX=$((STEP_IDX + 1))
  STEP_NAME="$1"
  STEP_NAMES[$STEP_IDX]="$STEP_NAME"
  STEP_SECS[$STEP_IDX]=0
  STEP_STATUS[$STEP_IDX]="skip"
  printf '\n%s⊘ STEP %d/%d%s  %s   %s(skipped)%s\n' \
    "$YEL" "$STEP_IDX" "$TOTAL_STEPS" "$RST" "$STEP_NAME" "$DIM" "$RST"
  printf '%d\t%s\t0\tskip\n' "$STEP_IDX" "$STEP_NAME" >>"$LOG_FILE"
}

on_error() {
  local code=$?
  local d
  d=$(elapsed_since "$STEP_T0")
  heartbeat_stop
  printf '\n%s FAILED %s STEP %d/%d  %s   %s(after %s)%s\n' \
    "$RED" "$RST" "$STEP_IDX" "$TOTAL_STEPS" "$STEP_NAME" "$DIM" "$(fmt "$d")" "$RST" >&2
  STEP_NAMES[$STEP_IDX]="$STEP_NAME"
  STEP_SECS[$STEP_IDX]=$d
  STEP_STATUS[$STEP_IDX]="fail"
  printf '%d\t%s\t%d\tfail\n' "$STEP_IDX" "$STEP_NAME" "$d" >>"$LOG_FILE"
  print_timings >&2 || true
  exit "$code"
}
trap on_error ERR

trap heartbeat_stop EXIT

print_timings() {
  local total
  total=$(elapsed_since "$PIPELINE_START")
  local slowest_i=0
  local i
  for i in $(seq 1 $STEP_IDX); do
    if [ "${STEP_SECS[$i]:-0}" -gt "${STEP_SECS[$slowest_i]:-0}" ]; then slowest_i=$i; fi
  done
  printf '\n%s════════════ STAGE TIMINGS · %s ════════════%s\n' "$BOLD" "$DATE" "$RST"
  printf '  %-3s %-40s %7s  %-20s %5s\n' '#' 'stage' 'time' 'share' ''
  for i in $(seq 1 $STEP_IDX); do
    local s=${STEP_SECS[$i]:-0}
    local st=${STEP_STATUS[$i]:-ok}
    local pct=0
    if [ "$total" -gt 0 ]; then pct=$((s * 100 / total)); fi
    local bar=""
    local n=$((pct / 5))
    local k
    for ((k = 0; k < n; k++)); do bar+="█"; done
    local note=""
    if [ "$st" = "skip" ]; then note=" (skipped)"; fi
    if [ "$st" = "fail" ]; then note=" (FAILED)"; fi
    if [ "$i" -eq "$slowest_i" ] && [ "$st" = "ok" ] && [ "$STEP_IDX" -gt 1 ]; then note="$note  ← slowest"; fi
    printf '  %-3d %-40s %7s  %-20s %4s%%%s\n' \
      "$i" "${STEP_NAMES[$i]}" "$(fmt "$s")" "$bar" "$pct" "$note"
  done
  printf '  %-3s %-40s %7s\n' '' 'TOTAL' "$(fmt "$total")"
  printf '%s\n' "${DIM}full log: $LOG_FILE${RST}"
}

printf '%s\n' "==================== WORLDS DAILY PIPELINE ($DATE) ===================="
printf '%s\n' "${DIM}8 stages · heartbeat: ${PIPELINE_HEARTBEAT:-auto} every ${PIPELINE_HEARTBEAT_SECS:-15}s (auto = TTY only; set PIPELINE_HEARTBEAT=on to force)${RST}"
if [ "$SKIP_SCRAPE" -eq 1 ]; then printf '%s\n' "${DIM}--skip-scrape: reusing existing matches.json${RST}"; fi
if [ "$SKIP_RENDER" -eq 1 ]; then printf '%s\n' "${DIM}--skip-render: steps 1-6 only${RST}"; fi
if [ "$STOP_AFTER_DB" -eq 1 ]; then printf '%s\n' "${DIM}--stop-after-db: stop right after DB upload; resume video later with --skip-scrape${RST}"; fi
if [ -n "${WORLDS_URL:-}" ]; then printf '%s\n' "${DIM}WORLDS_URL: ${WORLDS_URL}${RST}"; fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf '\n%s(planned stages)%s\n' "$BOLD" "$RST"
  printf '  1  Verify Liquipedia access (Cloudflare gate)   ~15s\n'
  printf '  2  Scrape matches + per-game screenshots        ~1m20s%s\n' "$( [ "$SKIP_SCRAPE" -eq 1 ] && echo '  [skipped]')"
  printf '  3  Generate Mandarin summary (LLM)              ~20s\n'
  printf '  4  Render TTS narration (edge-tts)              ~10s\n'
  printf '  5  Parse subtitles (VTT -> frames)              ~0s\n'
  printf '  6  Measure narration duration                   ~0s\n'
  printf '  7  Render Remotion video                        ~3-7min  <-- almost always the longest%s\n' "$( [ "$SKIP_RENDER" -eq 1 ] && echo '  [skipped]')"
  printf '\n  est. total: ~%s (render dominates when enabled)\n' "$( [ "$SKIP_RENDER" -eq 1 ] && echo '2min' || echo '9min')"
  exit 0
fi

# 1. Auth / Cloudflare gate
step_begin "Verify Liquipedia access (Cloudflare gate)"
bash scripts/check_auth.sh
step_end

# 2. Scrape
if [ "$SKIP_SCRAPE" -eq 0 ]; then
  step_begin "Scrape matches + per-game screenshots"
  heartbeat_start "scrape"
  node scripts/scrape.mjs "$DATE"
  heartbeat_stop
  step_end
else
  step_skip "Scrape matches + per-game screenshots"
fi

# 2.5 Upload scraped data to Supabase DB (idempotent; summary then reads the DB)
step_begin "Upload match data to Supabase DB"
node scripts/db_ingest.mjs "$DATE" "$TOURNAMENT"
step_end

# Optional gate: data-only run. Video generation can be resumed any time with
# --skip-scrape (scrape is skipped, DB ingest is idempotent, summary/TTS render
# fresh from the DB).
if [ "$STOP_AFTER_DB" -eq 1 ]; then
  printf '\n%s⏸  Data-only run complete: matches scraped, screenshotted and uploaded to the DB.%s\n' "$GREEN" "$RST"
  printf 'To generate the video later: %sscripts/run_pipeline.sh %s "%s" --skip-scrape%s\n' "$BOLD" "$DATE" "$TOURNAMENT" "$RST"
  print_timings
  exit 0
fi

# 3. Dynamic Mandarin summary (pi headless LLM; reads the DB, fails loudly on bad output)
step_begin "Generate Mandarin summary (LLM)"
heartbeat_start "LLM"
node scripts/generate_summary.mjs "$DATE"
heartbeat_stop
step_end

# 4. TTS
step_begin "Render TTS narration (edge-tts)"
bash scripts/tts.sh "$DATE"
step_end

# 5. Parse VTT -> subtitle frames
step_begin "Parse subtitles (VTT -> frames)"
node scripts/parse_vtt.mjs
step_end

# 6. Compute narration length -> render-config.json (audio must never clip)
step_begin "Measure narration duration"
FPS=30
DUR="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 remotion/public/worlds/narration.mp3 2>/dev/null || true)"
if [ -z "$DUR" ]; then
  LAST_FRAME="$(python3 -c "import json;d=json.load(open('remotion/public/worlds/subtitles.json'));print(max([x['end'] for x in d]) if d else 90)")"
  NARRATION_FRAMES="$((LAST_FRAME + 40))"
else
  NARRATION_FRAMES="$(python3 -c "import math;print(int(math.ceil(float('$DUR')*$FPS)) + 20)")"
fi
printf '  %s%s · %s frames%s\n' "$DIM" "$DUR" "$NARRATION_FRAMES" "$RST"
python3 -c "import json;json.dump({'narrationFrames': int('$NARRATION_FRAMES'), 'fps': $FPS, 'date': '$DATE'}, open('remotion/public/worlds/render-config.json','w'), indent=2)"
step_end

# 7. Render
if [ "$SKIP_RENDER" -eq 0 ]; then
  step_begin "Render Remotion video"
  printf '%s  remotion prints its own frame progress below; this stage is usually the longest%s\n' "$DIM" "$RST"
  heartbeat_start "render"
  (
    cd remotion
    # Guard: a missing screenshot would silently render as a broken image.
    node ../scripts/check_assets.mjs || exit 1
    # Optional palette override, e.g. WORLDS_THEME=blue (default: gold)
    RENDER_PROPS=""
    if [ -n "${WORLDS_THEME:-}" ]; then
      RENDER_PROPS="--props={\"theme\":\"${WORLDS_THEME}\"}"
    fi
    npx remotion render WorldsReport $RENDER_PROPS --log=warn "../output/${DATE}_worlds_report.mp4"
  )
  heartbeat_stop
  step_end
  printf '  %s✅ output/%s_worlds_report.mp4%s\n' "$DIM" "$DATE" "$RST"
else
  step_skip "Render Remotion video"
fi

print_timings
printf '\n%s==================== PIPELINE COMPLETE (%s) ====================%s\n' "$GREEN" "$DATE" "$RST"