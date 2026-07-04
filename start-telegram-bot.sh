#!/bin/bash
# Start Aura Telegram Bot in background
# Usage: ./start-telegram-bot.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Kill existing bot if running
pkill -f "telegram-bot.ts" 2>/dev/null || true

# Start bot in background with nohup
nohup npx tsx src/tools/telegram-bot.ts > ~/.aura/telegram-bot.log 2>&1 &
BOT_PID=$!

echo "💎 Aura Telegram Bot started (PID: $BOT_PID)"
echo "   Log: ~/.aura/telegram-bot.log"
echo "   Stop: kill $BOT_PID"
echo $BOT_PID > ~/.aura/telegram-bot.pid
