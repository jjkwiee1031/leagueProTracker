#!/usr/bin/env bash
set -e

PROFILE_DIR=".playwright-profile"
AUTH_FILE="auth.json"
TARGET_URL="${WORLDS_URL:-https://liquipedia.net/leagueoflegends/World_Championship/2026/Swiss_Stage}"
# Set WORLDS_URL to scrape another stage, e.g. .../2026/Knockout_Stage for Bo5 series.

echo "=== Checking access to Liquipedia ==="
STATUS=$(playwright-cli open --persistent --profile="$PROFILE_DIR" "$TARGET_URL" 2>&1 || true)

if echo "$STATUS" | grep -q "403" || echo "$STATUS" | grep -qi "verify you are human"; then
  echo "⚠️ Cloudflare verification required / cookies expired!"
  echo "Launching headed browser. Please solve the CAPTCHA in the window..."
  playwright-cli close-all 2>/dev/null || true
  playwright-cli open --headed --persistent --profile="$PROFILE_DIR" "$TARGET_URL"
  read -p "Press [ENTER] here once you solved the CAPTCHA and the page has loaded: "
  echo "Saving new session state..."
  playwright-cli state-save "$AUTH_FILE"
  echo "✅ Session renewed and saved to $AUTH_FILE."
else
  echo "✅ Access valid (no CAPTCHA triggered)."
  playwright-cli state-save "$AUTH_FILE" 2>/dev/null || true
fi
