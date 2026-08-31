import os
import asyncio
import subprocess

EDGE_TTS_BIN = "/tmp/tts_venv/bin/edge-tts"
VOICE = "en-US-ChristopherNeural"

slides = [
    {
        "img": "assets/screenshots/01-kanban-board.png",
        "text": "Welcome to Aura Code, the model agnostic autonomous coding agent. Our single window interface brings Kanban task tracking, multi-model execution, and instant card re-parenting into one unified workspace.",
        "audio": "scripts/slide_01.mp3"
    },
    {
        "img": "assets/screenshots/02-execution-list.png",
        "text": "The real-time Execution List provides instant search, filterable column lanes, and complete status visibility across all agent tasks without container scroll clipping.",
        "audio": "scripts/slide_02.mp3"
    },
    {
        "img": "assets/screenshots/03-third-party-providers.png",
        "text": "The Third-Party Provider Hub enables zero-code automation triggers for n8n, Zapier, Make, Pipedream, Telegram, Slack, and custom webhooks.",
        "audio": "scripts/slide_03.mp3"
    },
    {
        "img": "assets/screenshots/04-workflow-zapier-visual.png",
        "text": "With the Workflow DAG editor, you can build visual node graphs, configure tool steps, place human approval gates, and switch seamlessly to linear Zapier mode.",
        "audio": "scripts/slide_04.mp3"
    },
    {
        "img": "assets/screenshots/05-canvas-web-preview.png",
        "text": "The Web Studio Canvas delivers instant sandboxed web execution, multi-viewport mobile and desktop preview, and real-time terminal output.",
        "audio": "scripts/slide_05.mp3"
    },
    {
        "img": "assets/screenshots/06-archimedes-competence.png",
        "text": "Powered by the Archimedes memory engine, Aura Code tracks model competence per task domain, capturing execution trajectories to optimize routing.",
        "audio": "scripts/slide_06.mp3"
    },
    {
        "img": "assets/screenshots/07-model-mesh-settings.png",
        "text": "Configure resilient fallback chains across Anthropic Claude, OpenAI GPT-4o, Google Gemini, Xiaomi MiMo, Zhipu GLM, and local Ollama models.",
        "audio": "scripts/slide_07.mp3"
    },
    {
        "img": "assets/screenshots/08-swarm-orchestrator.png",
        "text": "When launching Swarm mode with orchestrate, specialized sub-agents operate in parallel branch workspaces with unified plan store synchronization.",
        "audio": "scripts/slide_08.mp3"
    },
    {
        "img": "assets/screenshots/09-system-architecture.png",
        "text": "Our single window philosophy unifies natural language perception, architect planning, tool execution, and Vitest verification into one coherent pipeline.",
        "audio": "scripts/slide_09.mp3"
    },
    {
        "img": "assets/screenshots/10-task-detail-modal.png",
        "text": "Interactive NES retro inspection modals give you full control to edit task notes, toggle agent tool permissions, and attach project files on the fly.",
        "audio": "scripts/slide_10.mp3"
    },
    {
        "img": "assets/screenshots/11-code-editor-canvas.png",
        "text": "The integrated Code Editor Canvas allows side-by-side file editing, live syntax highlighting, and immediate code verification.",
        "audio": "scripts/slide_11.mp3"
    },
    {
        "img": "assets/screenshots/12-multi-agent-tui.png",
        "text": "Whether running from the high-speed Terminal UI or the Web Studio, Aura Code empowers autonomous software development with zero context switching.",
        "audio": "scripts/slide_12.mp3"
    }
]

async def generate_narration():
    print("Generating AI voice narration clips with edge-tts...")
    for i, slide in enumerate(slides):
        cmd = [EDGE_TTS_BIN, "--voice", VOICE, "--text", slide["text"], "--write-media", slide["audio"]]
        proc = await asyncio.create_subprocess_exec(*cmd)
        await proc.communicate()
        print(f"Generated clip {i+1}/12: {slide['audio']}")

def get_audio_duration(file_path):
    cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file_path]
    res = subprocess.run(cmd, capture_output=True, text=True)
    return float(res.stdout.strip())

def build_video():
    asyncio.run(generate_narration())

    # Get durations and build concat file
    print("Calculating clip durations...")
    concat_audio_file = "scripts/concat_audio.txt"
    concat_video_file = "scripts/concat_video.txt"

    with open(concat_audio_file, "w") as fa, open(concat_video_file, "w") as fv:
        total_time = 0.0
        for slide in slides:
            dur = get_audio_duration(slide["audio"]) + 0.6  # Add 0.6s padding between slides
            total_time += dur
            fa.write(f"file '{os.path.abspath(slide['audio'])}'\n")
            fa.write(f"outpoint {dur:.3f}\n") # pad clip

            fv.write(f"file '{os.path.abspath(slide['img'])}'\n")
            fv.write(f"duration {dur:.3f}\n")
        # repeat last image for ffmpeg concat requirement
        fv.write(f"file '{os.path.abspath(slides[-1]['img']) }'\n")

    print(f"Total Video Duration: {total_time:.2f} seconds (> 60 seconds minimum!)")

    # Step 1: Concat voice narration
    narration_combined = "scripts/narration_full.mp3"
    subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_audio_file, "-c", "copy", narration_combined], check=True)

    # Step 2: Mix background music /home/dusan/1/Aura.mp3 with narration
    soundtrack = "scripts/soundtrack_mixed.mp3"
    mix_cmd = [
        "ffmpeg", "-y",
        "-i", narration_combined,
        "-i", "/home/dusan/1/Aura.mp3",
        "-filter_complex", f"[0:a]volume=1.0[voice];[1:a]volume=0.18,atrim=0:{total_time:.2f}[bg];[voice][bg]amix=inputs=2:duration=first:dropout_transition=2[aout]",
        "-map", "[aout]",
        "-c:a", "mp3",
        soundtrack
    ]
    subprocess.run(mix_cmd, check=True)

    # Step 3: Render final MP4 video
    final_output = "aura_code_hyperframes_showcase.mp4"
    render_cmd = [
        "ffmpeg", "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concat_video_file,
        "-i", soundtrack,
        "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p",
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "18",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        final_output
    ]
    print("Rendering final narrated video with background music...")
    subprocess.run(render_cmd, check=True)
    print(f"Successfully rendered: {final_output}")

if __name__ == "__main__":
    build_video()
