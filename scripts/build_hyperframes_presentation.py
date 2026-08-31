import os
import asyncio
import subprocess
from PIL import Image, ImageDraw, ImageFont

EDGE_TTS_BIN = "/tmp/tts_venv/bin/edge-tts"
VOICE = "en-US-JennyNeural"
HYPERFRAMES_DIR = "assets/hyperframes_generated"
os.makedirs(HYPERFRAMES_DIR, exist_ok=True)

# Helper to create stylized web presentation hyperframe title cards
def create_hyperframe(filename, badge_text, main_title, subtitle, accent_color=(110, 208, 234)):
    width, height = 1920, 1080
    img = Image.new("RGB", (width, height), color=(11, 14, 23))
    draw = ImageDraw.Draw(img)

    # Background gradient / grid lines decoration
    for y in range(0, height, 40):
        draw.line([(0, y), (width, y)], fill=(20, 26, 40), width=1)
    for x in range(0, width, 40):
        draw.line([(x, 0), (x, height)], fill=(20, 26, 40), width=1)

    # Glowing outer border
    draw.rectangle([40, 40, width-40, height-40], outline=accent_color, width=3)
    draw.rectangle([45, 45, width-45, height-45], outline=(30, 40, 60), width=1)

    # Load fonts
    try:
        font_badge = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 26)
        font_title = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 72)
        font_sub = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 36)
    except:
        font_badge = font_title = font_sub = ImageFont.load_default()

    # Draw Badge Pill
    badge_w = len(badge_text) * 16 + 40
    draw.rectangle([100, 240, 100 + badge_w, 290], fill=accent_color)
    draw.text((120, 250), badge_text.upper(), font=font_badge, fill=(11, 14, 23))

    # Draw Main Title
    draw.text((100, 340), main_title.upper(), font=font_title, fill=(255, 255, 255))

    # Draw Subtitle
    draw.text((100, 460), subtitle, font=font_sub, fill=(180, 195, 220))

    # Bottom branding pill
    draw.text((100, 960), "⚡ AURA CODE — THE SINGLE WINDOW AUTONOMOUS AGENT", font=font_badge, fill=accent_color)

    img.save(filename)
    print(f"Created hyperframe title card: {filename}")

# Generate Title Cards
create_hyperframe(f"{HYPERFRAMES_DIR}/hf_01.png", "PRODUCT SHOWCASE", "AURA CODE", "Model-Agnostic Autonomous AI Coding Agent", (110, 208, 234))
create_hyperframe(f"{HYPERFRAMES_DIR}/hf_02.png", "THE PHILOSOPHY", "ZERO CONTEXT SWITCHING", "One Window for Perception, Plan, Execution & Verification", (235, 120, 90))
create_hyperframe(f"{HYPERFRAMES_DIR}/hf_03.png", "AUTOMATION HUB", "THIRD-PARTY CONNECTORS", "Seamless Integration with n8n, Zapier, Slack & Webhooks", (100, 220, 150))
create_hyperframe(f"{HYPERFRAMES_DIR}/hf_04.png", "PIPELINE ENGINE", "WORKFLOW DAG & ZAPIER MODE", "Visual Step Graphs with Interactive Approval Checkpoints", (255, 190, 60))
create_hyperframe(f"{HYPERFRAMES_DIR}/hf_05.png", "SANDBOX PREVIEW", "LIVE WEB STUDIO CANVAS", "Instant Sandboxed Execution & Multi-Device Previews", (170, 120, 255))
create_hyperframe(f"{HYPERFRAMES_DIR}/hf_06.png", "MULTI-AGENT SWARM", "PARALLEL AGENT ORCHESTRATOR", "Specialized Researcher, Coder & Reviewer Pipelines", (255, 100, 150))
create_hyperframe(f"{HYPERFRAMES_DIR}/hf_07.png", "SELF-IMPROVING AGENT", "ARCHIMEDES MEMORY ENGINE", "Competence Tracking & Optimal Model Routing", (100, 200, 255))

presentation = [
    {
        "type": "title",
        "img": f"{HYPERFRAMES_DIR}/hf_01.png",
        "text": "Welcome to Aura Code. A modern model agnostic coding agent built for high performance development.",
        "audio": "scripts/hf_aud_01.mp3"
    },
    {
        "type": "feature",
        "img": "assets/screenshots/01-kanban-board.png",
        "text": "Our Kanban board gives you complete visual control. Drag and drop task cards across columns with instant re parenting.",
        "audio": "scripts/hf_aud_02.mp3"
    },
    {
        "type": "title",
        "img": f"{HYPERFRAMES_DIR}/hf_02.png",
        "text": "The core philosophy is simple: Zero context switching. Everything happens inside one unified work window.",
        "audio": "scripts/hf_aud_03.mp3"
    },
    {
        "type": "feature",
        "img": "assets/screenshots/02-execution-list.png",
        "text": "The Execution List lets you search and filter through all tasks, monitoring status and tool usage in real time.",
        "audio": "scripts/hf_aud_04.mp3"
    },
    {
        "type": "title",
        "img": f"{HYPERFRAMES_DIR}/hf_03.png",
        "text": "Connect your automation ecosystem without writing a single line of integration glue code.",
        "audio": "scripts/hf_aud_05.mp3"
    },
    {
        "type": "feature",
        "img": "assets/screenshots/03-third-party-providers.png",
        "text": "Our Third Party Hub connects directly to n8n, Zapier, Make, Pipedream, Slack, Telegram, and REST webhooks.",
        "audio": "scripts/hf_aud_06.mp3"
    },
    {
        "type": "title",
        "img": f"{HYPERFRAMES_DIR}/hf_04.png",
        "text": "Design complex automation pipelines visually with our Workflow DAG engine.",
        "audio": "scripts/hf_aud_07.mp3"
    },
    {
        "type": "feature",
        "img": "assets/screenshots/04-workflow-zapier-visual.png",
        "text": "Build node graphs, configure tool actions, set human approval checkpoints, or switch to a linear Zapier mode.",
        "audio": "scripts/hf_aud_08.mp3"
    },
    {
        "type": "title",
        "img": f"{HYPERFRAMES_DIR}/hf_05.png",
        "text": "See your web apps come to life instantly inside the Web Studio Canvas.",
        "audio": "scripts/hf_aud_09.mp3"
    },
    {
        "type": "feature",
        "img": "assets/screenshots/05-canvas-web-preview.png",
        "text": "Run code live in a secure sandbox and preview layouts across mobile, tablet, and desktop viewports.",
        "audio": "scripts/hf_aud_10.mp3"
    },
    {
        "type": "title",
        "img": f"{HYPERFRAMES_DIR}/hf_06.png",
        "text": "Tackle massive refactors with parallel multi-agent Swarm mode.",
        "audio": "scripts/hf_aud_11.mp3"
    },
    {
        "type": "feature",
        "img": "assets/screenshots/08-swarm-orchestrator.png",
        "text": "Specialized researcher, coder, and reviewer sub agents execute simultaneously in isolated git branches.",
        "audio": "scripts/hf_aud_12.mp3"
    },
    {
        "type": "title",
        "img": f"{HYPERFRAMES_DIR}/hf_07.png",
        "text": "Aura Code gets smarter over time with the Archimedes memory engine.",
        "audio": "scripts/hf_aud_13.mp3"
    },
    {
        "type": "feature",
        "img": "assets/screenshots/06-archimedes-competence.png",
        "text": "It tracks model competence per task domain and selects the optimal LLM provider automatically.",
        "audio": "scripts/hf_aud_14.mp3"
    },
    {
        "type": "feature",
        "img": "assets/screenshots/12-multi-agent-tui.png",
        "text": "Whether you love the fast Terminal UI or the Web Studio, Aura Code puts true agent autonomy at your fingertips.",
        "audio": "scripts/hf_aud_15.mp3"
    }
]

async def generate_voice():
    print("Generating voice narration clips...")
    for i, slide in enumerate(presentation):
        if not os.path.exists(slide["audio"]):
            cmd = [EDGE_TTS_BIN, "--voice", VOICE, "--text", slide["text"], "--write-media", slide["audio"]]
            proc = await asyncio.create_subprocess_exec(*cmd)
            await proc.communicate()
            print(f"Generated audio clip {i+1}/{len(presentation)}: {slide['audio']}")

def get_duration(file_path):
    cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file_path]
    res = subprocess.run(cmd, capture_output=True, text=True)
    return float(res.stdout.strip())

def render_presentation():
    asyncio.run(generate_voice())

    concat_audio_file = "scripts/concat_hf_audio.txt"
    concat_video_file = "scripts/concat_hf_video.txt"

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

    print(f"Total Video Duration: {current_time:.2f} seconds")

    # Combine audio
    narration_combined = "scripts/hf_narration_full.mp3"
    subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_audio_file, "-c", "copy", narration_combined], check=True)

    # Mix soundtrack with background music /home/dusan/1/Aura.mp3
    soundtrack = "scripts/hf_soundtrack_mixed.mp3"
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

    # Render MP4 video WITHOUT burnt-in subtitles text!
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

    print("Rendering clean Hyperframes Presentation MP4 video (subtitles removed)...")
    subprocess.run(render_cmd, check=True)
    print(f"Successfully generated clean presentation video: {final_output}")

if __name__ == "__main__":
    render_presentation()
