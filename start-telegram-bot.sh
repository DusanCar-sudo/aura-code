#!/bin/bash
# (Re)start Aura Telegram Bot.
# The bot is managed by the systemd user service `aura-telegram.service`
# (Restart=always). Never launch it directly with nohup — systemd would
# immediately respawn its own copy and two pollers on one token make
# Telegram return 409 Conflict, silently eating messages.
# Usage: ./start-telegram-bot.sh

set -e

systemctl --user restart aura-telegram.service
sleep 3
systemctl --user --no-pager --lines=0 status aura-telegram.service

echo "💎 Aura Telegram Bot restarted (systemd: aura-telegram.service)"
echo "   Logs:   journalctl --user -u aura-telegram.service -f"
echo "   Stop:   systemctl --user stop aura-telegram.service"
