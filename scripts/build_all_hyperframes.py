import os
import asyncio
import subprocess
from PIL import Image, ImageDraw, ImageFont

EDGE_TTS_BIN = "/tmp/tts_venv/bin/edge-tts"
VOICE = "en-US-JennyNeural"
HYPERFRAMES_DIR = "assets/hyperframes_generated"
os.makedirs(HYPERFRAMES_DIR, exist_ok=True)

def create_hyperframe(filename, badge_text, main_title, subtitle, accent_color=(110, 208, 234)):
    width, height = 1920, 1080
    img = Image.new("RGB", (width, height), color=(11, 14, 23))
    draw = ImageDraw.Draw(img)

    for y in range(0, height, 40):
        draw.line([(0, y), (width, y)], fill=(20, 26, 40), width=1)
    for x in range(0, width, 40):
        draw.line([(x, 0), (x, height)], fill=(20, 26, 40), width=1)

    draw.rectangle([40, 40, width-40, height-40], outline=accent_color, width=3)
    draw.rectangle([46, 46, width-46, height-46], outline=(30, 42, 64), width=1)

    try:
        font_badge = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 26)
        font_title = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 68)
        font_sub = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 34)
    except:
        font_badge = font_title = font_sub = ImageFont.load_default()

    badge_str = badge_text.upper()
    bbox = draw.textbbox((120, 245), badge_str, font=font_badge)
    badge_w = (bbox[2] - bbox[0]) + 40

    draw.rectangle([100, 235, 100 + badge_w, 295], fill=accent_color)
    draw.text((120, 245), badge_str, font=font_badge, fill=(11, 14, 23))

    draw.text((100, 340), main_title.upper(), font=font_title, fill=(255, 255, 255))
    draw.text((100, 460), subtitle, font=font_sub, fill=(180, 195, 220))
    draw.text((100, 960), "⚡ AURA CODE — THE SINGLE WINDOW AUTONOMOUS AGENT", font=font_badge, fill=accent_color)

    img.save(filename)

# Generate all 12 Hyperframe Title Cards
create_hyperframe(f"{HYPERFRAMES_DIR}/hf_01.png", "PRODUCT SHOWCASE", "AURA CODE", "Model-Agnostic Autonomous AI Coding Agent", (110, 208, 234))
create_hyperframe(f"{HYPERFRAMES_DIR}/hf_02.png", "THE PHILOSOPHY", "ZERO CONTEXT SWITCHING", "One Window for Perception, Plan, Execution & Verification", (235, 120, 90))
create_hyperframe(f"{HYPERFRAMES_DIR}/hf_03.png", "AUTOMATION HUB", "THIRD-PARTY CONNECTORS", "Seamless Integration with n8n, Zapier, Slack & Webhooks", (100, 220, 150))
create_hyperframe(f"{HYPERFRAMES_DIR}/hf_04.png", "PIPELINE ENGINE", "WORKFLOW DAG & ZAPIER MODE", "Visual Step Graphs with Interactive Approval Checkpoints", (255, 190, 60))
create_hyperframe(f"{HYPERFRAMES_DIR}/hf_05.png", "SANDBOX PREVIEW", "LIVE WEB STUDIO CANVAS", "Instant Sandboxed Execution & Multi-Device Previews", (170, 120, 255))
create_hyperframe(f"{HYPERFRAMES_DIR}/hf_06.png", "IDE CANVAS", "CODE EDITOR CANVAS", "Side-by-Side File Editing & Syntax Highlighting", (90, 210, 240))
create_hyperframe(f"{HYPERFRAMES_DIR}/hf_07.png", "MULTI-AGENT SWARM", "PARALLEL AGENT ORCHESTRATOR", "Specialized Researcher, Coder & Reviewer Pipelines", (255, 100, 150))
create_hyperframe(f"{HYPERFRAMES_DIR}/hf_08.png", "CORE ENGINE", "SYSTEM ARCHITECTURE", "Perception • Plan • Execution • Verification Loop", (255, 215, 0))
create_hyperframe(f"{HYPERFRAMES_DIR}/hf_09.png", "MEMORY SYSTEM", "ARCHIMEDES MEMORY ENGINE", "Competence Tracking & Optimal Model Routing", (100, 200, 255))
create_hyperframe(f"{HYPERFRAMES_DIR}/hf_10.png", "MODEL MESH", "MODEL-AGNOSTIC ROUTING", "Claude • GPT-4o • Gemini • MiMo • Zhipu • Ollama", (180, 140, 255))
create_hyperframe(f"{HYPERFRAMES_DIR}/hf_11.png", "TASK MANAGEMENT", "NES RETRO TASK INSPECTOR", "Live Notes, Tool Permissions & File Attachments", (255, 140, 100))
create_hyperframe(f"{HYPERFRAMES_DIR}/hf_12.png", "CLI & WEB UNIFIED", "MULTI-AGENT TERMINAL UI", "High-Speed Command Line & Web Studio Autonomy", (110, 208, 234))

presentation = [
    {"type": "title", "img": f"{HYPERFRAMES_DIR}/hf_01.png", "text": "Welcome to Aura Code. A modern model agnostic coding agent built for high performance development.", "audio": "scripts/hf_aud_01.mp3"},
    {"type": "feature", "img": "assets/screenshots/01-kanban-board.png", "text": "Our Kanban board gives you complete visual control. Drag and drop task cards across columns with instant re parenting.", "audio": "scripts/hf_aud_02.mp3"},

    {"type": "title", "img": f"{HYPERFRAMES_DIR}/hf_02.png", "text": "The core philosophy is simple: Zero context switching. Everything happens inside one unified work window.", "audio": "scripts/hf_aud_03.mp3"},
    {"type": "feature", "img": "assets/screenshots/02-execution-list.png", "text": "The Execution List lets you search and filter through all tasks, monitoring status and tool usage in real time.", "audio": "scripts/hf_aud_04.mp3"},

    {"type": "title", "img": f"{HYPERFRAMES_DIR}/hf_03.png", "text": "Connect your automation ecosystem without writing a single line of integration glue code.", "audio": "scripts/hf_aud_05.mp3"},
    {"type": "feature", "img": "assets/screenshots/03-third-party-providers.png", "text": "Our Third Party Hub connects directly to n8n, Zapier, Make, Pipedream, Slack, Telegram, and REST webhooks.", "audio": "scripts/hf_aud_06.mp3"},

    {"type": "title", "img": f"{HYPERFRAMES_DIR}/hf_04.png", "text": "Design complex automation pipelines visually with our Workflow DAG engine.", "audio": "scripts/hf_aud_07.mp3"},
    {"type": "feature", "img": "assets/screenshots/04-workflow-zapier-visual.png", "text": "Build node graphs, configure tool actions, set human approval checkpoints, or switch to a linear Zapier mode.", "audio": "scripts/hf_aud_08.mp3"},

    {"type": "title", "img": f"{HYPERFRAMES_DIR}/hf_05.png", "text": "See your web apps come to life instantly inside the Web Studio Canvas.", "audio": "scripts/hf_aud_09.mp3"},
    {"type": "feature", "img": "assets/screenshots/05-canvas-web-preview.png", "text": "Run code live in a secure sandbox and preview layouts across mobile, tablet, and desktop viewports.", "audio": "scripts/hf_aud_10.mp3"},

    {"type": "title", "img": f"{HYPERFRAMES_DIR}/hf_06.png", "text": "Inspect and edit files side by side with the agent using the Code Canvas.", "audio": "scripts/hf_aud_11.mp3"},
    {"type": "feature", "img": "assets/screenshots/11-code-editor-canvas.png", "text": "The built-in Code Canvas provides syntax highlighting and instant file verification.", "audio": "scripts/hf_aud_12.mp3"},

    {"type": "title", "img": f"{HYPERFRAMES_DIR}/hf_07.png", "text": "Tackle massive refactors with parallel multi-agent Swarm mode.", "audio": "scripts/hf_aud_13.mp3"},
    {"type": "feature", "img": "assets/screenshots/swarm-user-screenshot.png", "text": "Specialized researcher, coder, and reviewer sub agents execute simultaneously in isolated git branches.", "audio": "scripts/hf_aud_14.mp3"},

    {"type": "title", "img": f"{HYPERFRAMES_DIR}/hf_08.png", "text": "Everything follows our strict four step Praktess execution loop.", "audio": "scripts/hf_aud_15.mp3"},
    {"type": "feature", "img": "assets/screenshots/09-system-architecture.png", "text": "Perception reads your codebase, architect plans the fix, execution runs tools, and verification checks tests.", "audio": "scripts/hf_aud_16.mp3"},

    {"type": "title", "img": f"{HYPERFRAMES_DIR}/hf_09.png", "text": "Aura Code gets smarter over time with the Archimedes memory engine.", "audio": "scripts/hf_aud_17.mp3"},
    {"type": "feature", "img": "assets/screenshots/06-archimedes-competence.png", "text": "It tracks model competence per task domain and selects the optimal LLM provider automatically.", "audio": "scripts/hf_aud_18.mp3"},

    {"type": "title", "img": f"{HYPERFRAMES_DIR}/hf_10.png", "text": "Enjoy true model-agnostic flexibility across leading AI providers.", "audio": "scripts/hf_aud_19.mp3"},
    {"type": "feature", "img": "assets/screenshots/07-model-mesh-settings.png", "text": "Mix and match Claude, GPT-4, Gemini, MiMo, or local Ollama models with automatic fallback.", "audio": "scripts/hf_aud_20.mp3"},

    {"type": "title", "img": f"{HYPERFRAMES_DIR}/hf_11.png", "text": "Inspect task details instantly with retro NES style modals.", "audio": "scripts/hf_aud_21.mp3"},
    {"type": "feature", "img": "assets/screenshots/10-task-detail-modal.png", "text": "Clicking any task allows you to tweak instructions, adjust model settings, or attach files on the fly.", "audio": "scripts/hf_aud_22.mp3"},

    {"type": "title", "img": f"{HYPERFRAMES_DIR}/hf_12.png", "text": "Unified terminal and web experience for complete developer autonomy.", "audio": "scripts/hf_aud_23.mp3"},
    {"type": "feature", "img": "assets/screenshots/12-multi-agent-tui.png", "text": "Whether you prefer the fast Terminal UI or the Web Studio, Aura Code puts true agent autonomy at your fingertips.", "audio": "scripts/hf_aud_24.mp3"}
]

async def generate_voice():
    for i, slide in enumerate(presentation):
        if not os.path.exists(slide["audio"]):
            cmd = [EDGE_TTS_BIN, "--voice", VOICE, "--text", slide["text"], "--write-media", slide["audio"]]
            proc = await asyncio.create_subprocess_exec(*cmd)
            await proc.communicate()

def get_duration(file_path):
    cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file_path]
    res = subprocess.run(cmd, capture_output=True, text=True)
    return float(res.stdout.strip())

def render_presentation():
    asyncio.run(generate_voice())

    concat_audio_file = "scripts/concat_hf_audio_all.txt"
    concat_video_file = "scripts/concat_hf_video_all.txt"

    current_time = 0.0

    with open(concat_audio_file, "w") as fa, open(concat_video_file, "w") as fv:
        for idx, slide in enumerate(presentation):
            dur = get_duration(slide["audio"]) + 0.4
            fa.write(f"file '{os.path.abspath(slide['audio'])}'\n")
            fa.write(f"outpoint {dur:.3f}\n")

            fv.write(f"file '{os.path.abspath(slide['img'])}'\n")
            fv.write(f"duration {dur:.3f}\n")

            current_time += dur

        fv.write(f"file '{os.path.abspath(presentation[-1]['img']) }'\n")

    # Combine audio
    narration_combined = "scripts/hf_narration_full_all.mp3"
    subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_audio_file, "-c", "copy", narration_combined], check=True)

    # Mix soundtrack
    soundtrack = "scripts/hf_soundtrack_mixed_all.mp3"
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

    # Render MP4
    final_output = "aura_code_hyperframes_showcase.mp4"
    vf_filter = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p"

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

    print("Rendering updated Swarm showcase video...")
    subprocess.run(render_cmd, check=True)
    print("Done rendering!")

if __name__ == "__main__":
    render_presentation()
