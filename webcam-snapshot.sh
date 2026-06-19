#!/bin/bash
# Webcam surveillance — capture snapshot and send to Telegram
# Runs every 5 minutes via Aura cron

PHOTO="/tmp/webcam-snapshot.jpg"
BOT_TOKEN="REDACTED_TELEGRAM_TOKEN"
CHAT_ID="8519031951"

# Capture a single frame from the webcam
ffmpeg -f v4l2 -video_size 1280x720 -i /dev/video0 -frames:v 1 -y "$PHOTO" 2>/dev/null

if [ ! -f "$PHOTO" ]; then
  echo "ERROR: Failed to capture webcam image"
  exit 1
fi

# Send photo to Telegram
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto" \
  -F "chat_id=${CHAT_ID}" \
  -F "photo=@${PHOTO}" \
  -F "caption=📷 Webcam snapshot — $(date '+%Y-%m-%d %H:%M:%S')" \
  > /dev/null

echo "Snapshot sent at $(date)"
