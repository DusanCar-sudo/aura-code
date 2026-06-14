#!/bin/bash
# Start Praktess Telegram Bot in background
# Usage: ./start-telegram-bot.sh

cd /home/dusan/ruby-code

# Kill existing bot if running
pkill -f "telegram-bot.ts" 2>/dev/null || true

# Start bot in background with nohup
nohup npx tsx src/tools/telegram-bot.ts > ~/.rubycode/telegram-bot.log 2>&1 &
BOT_PID=$!

echo "💎 Praktess Telegram Bot started (PID: $BOT_PID)"
echo "   Log: ~/.rubycode/telegram-bot.log"
echo "   Stop: kill $BOT_PID"
echo $BOT_PID > ~/.rubycode/telegram-bot.pid
