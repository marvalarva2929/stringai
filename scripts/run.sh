#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# Install deps if node_modules missing
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install
fi

# Copy .env.example to .env if .env doesn't exist
if [ ! -f ".env" ]; then
  echo "⚠️  No .env file found. Copying from .env.example..."
  cp .env.example .env
  echo "👉  Fill in your Supabase + RevenueCat keys in .env before proceeding."
  echo ""
fi

echo "🚀 Starting Expo dev server..."
npx expo start "$@"
