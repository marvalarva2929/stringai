#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

PLATFORM="${1:-all}"   # ios | android | all
PROFILE="${2:-preview}" # preview | production

echo "🏗  Building StringAI — platform: $PLATFORM, profile: $PROFILE"

# Ensure EAS CLI is available
if ! command -v eas &>/dev/null; then
  echo "📦 Installing EAS CLI..."
  npm install -g eas-cli
fi

# Check logged in
eas whoami || (echo "❌ Not logged in. Run: eas login" && exit 1)

case "$PLATFORM" in
  ios)
    eas build --platform ios --profile "$PROFILE"
    ;;
  android)
    eas build --platform android --profile "$PROFILE"
    ;;
  all)
    eas build --platform all --profile "$PROFILE"
    ;;
  *)
    echo "Usage: $0 [ios|android|all] [preview|production]"
    exit 1
    ;;
esac

echo "✅ Build submitted. Check status at https://expo.dev"
