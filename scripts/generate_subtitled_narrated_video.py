import os
import asyncio
import subprocess

EDGE_TTS_BIN = "/tmp/tts_venv/bin/edge-tts"
VOICE = "en-US-JennyNeural"

slides = [
    {
        "img": "assets/screenshots/01-kanban-board.png",
        "text": "Welcome to Aura Code. We built this because jumping between ten different developer tools destroys your focus. Here in our Kanban view, you can track tasks across lanes and drag cards around freely.",
        "audio": "scripts/sub_slide_01.mp3"
    },
    {
        "img": "assets/screenshots/02-execution-list.png",
        "text": "Need a clean table view? The Execution List lets you search through every task, filter by status, and see exactly what models and tools were used.",
        "audio": "scripts/sub_slide_02.mp3"
    },
    {
        "img": "assets/screenshots/03-third-party-providers.png",
        "text": "Connecting your existing tools is super easy. With our Integration Hub, you can hook up n8n, Zapier, Slack, Telegram, or custom webhooks in seconds.",
        "audio": "scripts/sub_slide_03.mp3"
    },
    {
        "img": "assets/screenshots/04-workflow-zapier-visual.png",
        "text": "For complex pipelines, check out the Workflow editor. You can connect nodes visually, set up human approval checkpoints, or switch to a simple step-by-step list.",
        "audio": "scripts/sub_slide_04.mp3"
    },
    {
        "img": "assets/screenshots/05-canvas-web-preview.png",
        "text": "Inside the Web Studio Canvas, your code runs live in a safe sandbox. You can preview web apps across phone, tablet, or desktop screens instantly.",
        "audio": "scripts/sub_slide_05.mp3"
    },
    {
        "img": "assets/screenshots/06-archimedes-competence.png",
        "text": "Behind the scenes, our Archimedes memory engine remembers what worked best. It tracks model performance so every future task gets routed smarter.",
        "audio": "scripts/sub_slide_06.mp3"
    },
    {
        "img": "assets/screenshots/07-model-mesh-settings.png",
        "text": "Aura Code is completely model-agnostic. Mix and match Claude, GPT-4, Gemini, MiMo, or local Ollama models with automatic fallback if an API goes down.",
        "audio": "scripts/sub_slide_07.mp3"
    },
    {
        "img": "assets/screenshots/08-swarm-orchestrator.png",
        "text": "When you need extra power, turn on Swarm mode. Specialized researcher, coder, and reviewer agents work together in parallel to tackle big features.",
        "audio": "scripts/sub_slide_08.mp3"
    },
    {
        "img": "assets/screenshots/09-system-architecture.png",
        "text": "Everything follows a clean four-step loop: perception reads your code, planning designs the fix, execution runs the tools, and verification checks the tests.",
        "audio": "scripts/sub_slide_09.mp3"
    },
    {
        "img": "assets/screenshots/10-task-detail-modal.png",
        "text": "Clicking any task opens a retro inspection modal. Here you can tweak instructions, adjust model settings, or attach files whenever you need.",
        "audio": "scripts/sub_slide_10.mp3"
    },
    {
        "img": "assets/screenshots/11-code-editor-canvas.png",
        "text": "The built-in Code Canvas gives you a clean side-by-side editor with syntax highlighting, so you can inspect and edit files right alongside the agent.",
        "audio": "scripts/sub_slide_11.mp3"
    },
    {
        "img": "assets/screenshots/12-multi-agent-tui.png",
        "text": "Whether you prefer the lightning-fast Terminal UI or the Web Studio, Aura Code gives you full autonomy in one single work window.",
        "audio": "scripts/sub_slide_12.mp3"
    }
]

async def generate_audio():
    print("Generating conversational narration clips with JennyNeural...")
    for i, slide in enumerate(slides):
        cmd = [EDGE_TTS_BIN, "--voice", VOICE, "--text", slide["text"], "--write-media", slide["audio"]]
        proc = await asyncio.create_subprocess_exec(*cmd)
        await proc.communicate()
        print(f"Generated clip {i+1}/12: {slide['audio']}")

def get_duration(file_path):
    cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file_path]
    res = subprocess.run(cmd, capture_output=True, text=True)
    return float(res.stdout.strip())

def format_srt_time(seconds):
    millis = int((seconds - int(seconds)) * 1000)
    secs = int(seconds) % 60
    mins = (int(seconds) // 60) % 60
    hours = int(seconds) // 3600
    return f"{hours:02d}:{mins:02d}:{secs:02d},{millis:03d}"

def build_srt_and_concat():
    asyncio.run(generate_audio())

    srt_path = "scripts/subtitles.srt"
    concat_audio_file = "scripts/concat_sub_audio.txt"
    concat_video_file = "scripts/concat_sub_video.txt"

    srt_entries = []
    current_time = 0.0

    with open(concat_audio_file, "w") as fa, open(concat_video_file, "w") as fv:
        for idx, slide in enumerate(slides):
            dur = get_duration(slide["audio"]) + 0.5  # padding
            start_t = current_time
            end_t = current_time + dur

            # SRT entry for burnt-in on-screen text
            srt_entries.append(f"{idx+1}\n{format_srt_time(start_t)} --> {format_srt_time(end_t - 0.2)}\n{slide['text']}\n\n")

            fa.write(f"file '{os.path.abspath(slide['audio'])}'\n")
            fa.write(f"outpoint {dur:.3f}\n")

            fv.write(f"file '{os.path.abspath(slide['img'])}'\n")
            fv.write(f"duration {dur:.3f}\n")

            current_time += dur

        fv.write(f"file '{os.path.abspath(slides[-1]['img']) }'\n")

    with open(srt_path, "w") as f_srt:
        f_srt.writelines(srt_entries)

    print(f"Generated subtitles: {srt_path}")
    print(f"Total Video Duration: {current_time:.2f} seconds")

    # Step 1: Combine Audio
    narration_combined = "scripts/sub_narration_full.mp3"
    subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_audio_file, "-c", "copy", narration_combined], check=True)

    # Step 2: Mix background music /home/dusan/1/Aura.mp3
    soundtrack = "scripts/sub_soundtrack_mixed.mp3"
    mix_cmd = [
        "ffmpeg", "-y",
        "-i", narration_combined,
        "-i", "/home/dusan/1/Aura.mp3",
        "-filter_complex", f"[0:a]volume=1.0[voice];[1:a]volume=0.15,atrim=0:{current_time:.2f}[bg];[voice][bg]amix=inputs=2:duration=first:dropout_transition=2[aout]",
        "-map", "[aout]",
        "-c:a", "mp3",
        soundtrack
    ]
    subprocess.run(mix_cmd, check=True)

    # Step 3: Render final MP4 video with burnt-in subtitles!
    final_output = "aura_code_hyperframes_showcase.mp4"
    srt_abs = os.path.abspath(srt_path)

    # Force style: crisp white text with dark translucent box, centered bottom
    vf_filter = (
        "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p,"
        f"subtitles='{srt_abs}':force_style='FontSize=22,FontName=DejaVu Sans,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BackColour=&H80000000,BorderStyle=4,Outline=2,Shadow=1,MarginV=45,Alignment=2'"
    )

    render_cmd = [
        "ffmpeg", "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concat_video_file,
        "-i", soundtrack,
        "-vf", vf_filter,
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "18",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        final_output
    ]

    print("Rendering video with burnt-in subtitles and mixed audio...")
    subprocess.run(render_cmd, check=True)
    print(f"Successfully generated: {final_output}")

if __name__ == "__main__":
    build_srt_and_concat()
