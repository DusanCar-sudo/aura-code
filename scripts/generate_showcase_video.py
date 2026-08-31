import os
import subprocess

screenshots_dir = "assets/screenshots"
images = [
    "01-kanban-board.png",
    "02-execution-list.png",
    "03-third-party-providers.png",
    "04-workflow-zapier-visual.png",
    "05-canvas-web-preview.png",
    "06-archimedes-competence.png",
    "07-model-mesh-settings.png",
    "08-swarm-orchestrator.png",
    "09-system-architecture.png",
    "10-task-detail-modal.png",
    "11-code-editor-canvas.png",
    "12-multi-agent-tui.png"
]

output_video = "aura_code_hyperframes_showcase.mp4"

# Create concat list for ffmpeg (3 seconds per image)
concat_file = "scripts/video_concat.txt"
with open(concat_file, "w") as f:
    for img in images:
        path = os.path.abspath(os.path.join(screenshots_dir, img))
        f.write(f"file '{path}'\n")
        f.write("duration 3\n")
    # Repeat last image to hold ending frame
    last_path = os.path.abspath(os.path.join(screenshots_dir, images[-1]))
    f.write(f"file '{last_path}'\n")

cmd = [
    "ffmpeg", "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concat_file,
    "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p",
    "-c:v", "libx264",
    "-r", "30",
    "-pix_fmt", "yuv420p",
    output_video
]

print("Rendering video with ffmpeg...")
res = subprocess.run(cmd, capture_output=True, text=True)
if res.returncode == 0:
    print(f"Video generated successfully: {output_video}")
else:
    print("FFmpeg error:", res.stderr)
