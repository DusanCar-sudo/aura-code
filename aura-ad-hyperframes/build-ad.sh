#!/usr/bin/env bash
set -euo pipefail

OUT="/mnt/bigdata/home/Videos/aura-code-ad"
HF="/home/dusan/aura-code/aura-ad-hyperframes"
mkdir -p "$OUT/work"

CLIPS=(
  "/home/dusan/recording_2026-06-21-11-02-18.mp4"
  "/home/dusan/recording_2026-06-21-11-03-26.mp4"
  "/home/dusan/recording_2026-06-21-11-18-27.mp4"
  "/home/dusan/recording_2026-06-21-11-50-07.mp4"
)
LABELS=(
  "Reads your codebase"
  "Plans and executes changes"
  "Runs tests and verifies"
  "Reports what passed"
)

i=0
for src in "${CLIPS[@]}"; do
  out="$OUT/work/seg_$(printf '%02d' "$i").mp4"
  label="${LABELS[$i]}"
  # Trim highlight window; normalize to 1080p30
  ffmpeg -y -hide_banner -loglevel error -ss 5 -t 18 -i "$src" \
    -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${label}':fontsize=42:fontcolor=white:borderw=3:bordercolor=black@0.7:x=80:y=h-120" \
    -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p \
    -c:a aac -b:a 128k -ar 48000 -ac 2 \
    "$out"
  i=$((i + 1))
done

# HyperFrames intro (fallback to ffmpeg title card if render fails)
INTRO="$OUT/work/intro_hf.mp4"
if cd "$HF" && npm run check 2>/dev/null && npm run render -o "$INTRO" 2>/dev/null; then
  echo "HyperFrames intro rendered"
else
  echo "HyperFrames render skipped — using ffmpeg intro"
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i color=c=0x0a0a0f:s=1920x1080:d=8 -f lavfi -i anullsrc=r=48000:cl=stereo \
    -vf "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='Aura Code':fontsize=96:fontcolor=0xcc0000:x=(w-text_w)/2:y=380,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='I don'\''t try. I verify.':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=520" \
    -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "$INTRO"
fi

# Outro
OUTRO="$OUT/work/outro.mp4"
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i color=c=0x0a0a0f:s=1920x1080:d=6 -f lavfi -i anullsrc=r=48000:cl=stereo \
  -vf "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='aura-code on npm':fontsize=64:fontcolor=white:x=(w-text_w)/2:y=420,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='github.com/milodule3-debug/aura-code':fontsize=36:fontcolor=0xcccccc:x=(w-text_w)/2:y=520" \
  -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "$OUTRO"

LIST="$OUT/work/concat.txt"
: > "$LIST"
for f in "$INTRO" "$OUT/work/seg_"*.mp4 "$OUTRO"; do
  echo "file '$f'" >> "$LIST"
done

FINAL="$OUT/aura-code-capabilities-ad.mp4"
ffmpeg -y -hide_banner -loglevel error -f concat -safe 0 -i "$LIST" -c copy "$FINAL" 2>/dev/null || \
ffmpeg -y -hide_banner -loglevel error -f concat -safe 0 -i "$LIST" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 160k "$FINAL"

ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$FINAL"
echo "Wrote $FINAL"