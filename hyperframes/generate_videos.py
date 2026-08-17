#!/usr/bin/env python3
"""HyperFrames Video Engine"""
import os, subprocess, math, json
from pathlib import Path

BASE = Path("/mnt/bigdata/new sys/hyperframes")
HTML_DIR = BASE / "html"
FRAMES_DIR = BASE / "frames"
OUTPUT_DIR = BASE / "output"
AUDIO_FILE = Path("/home/dusan/Downloads/New Download/Aura.mp3")

W, H = 1920, 1080
FPS = 30
TOTAL_DUR = 179.0
N_VIDS = 6
VID_DUR = TOTAL_DUR / N_VIDS
FRAMES_PER = int(VID_DUR * FPS)
CHROME = "/usr/bin/google-chrome"

os.makedirs(HTML_DIR, exist_ok=True)
os.makedirs(FRAMES_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

C = dict(bg="#0f0f1a",card="#1a1a2e",border="#2a2a45",text="#e4e4f0",
         sub="#a0a0c0",muted="#6b6b8a",purple="#6c5ce7",pink="#a855f7",
         green="#34d399",red="#f87171",yellow="#fbbf24",cyan="#22d3ee")

def css():
    return f"""*{{margin:0;padding:0;box-sizing:border-box}}
html,body{{width:{W}px;height:{H}px;overflow:hidden;background:{C['bg']};color:{C['text']};font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center}}
.slide{{width:{W}px;height:{H}px;padding:80px 120px;display:flex;flex-direction:column;justify-content:center;position:relative;overflow:hidden}}
.slide::before{{content:'';position:absolute;top:-200px;right:-200px;width:600px;height:600px;background:radial-gradient(circle,{C['purple']}15,transparent 70%);pointer-events:none}}
.slide::after{{content:'';position:absolute;bottom:-300px;left:-100px;width:500px;height:500px;background:radial-gradient(circle,{C['pink']}12,transparent 70%);pointer-events:none}}
.accent-bar{{position:absolute;top:0;left:0;width:6px;height:100%;background:linear-gradient(180deg,{C['purple']},{C['pink']})}}
.badge{{display:inline-block;padding:6px 16px;border-radius:20px;font-size:12px;font-weight:600;letter-spacing:3px;text-transform:uppercase;color:{C['purple']};border:1px solid {C['purple']}44;margin-bottom:20px;opacity:0;animation:fadeIn 0.8s ease-out forwards}}
.title{{font-size:64px;font-weight:700;line-height:1.15;margin-bottom:16px;background:linear-gradient(135deg,{C['text']},{C['pink']});-webkit-background-clip:text;-webkit-text-fill-color:transparent;opacity:0;animation:fadeIn 0.8s ease-out 0.2s forwards}}
.sub{{font-size:22px;color:{C['sub']};line-height:1.5;margin-bottom:30px;opacity:0;animation:fadeIn 0.8s ease-out 0.4s forwards}}
.line{{font-size:20px;color:{C['sub']};line-height:1.6;margin-bottom:8px;opacity:0;animation:in 0.6s ease-out forwards}}
.big{{font-size:40px;font-weight:700;color:{C['text']};line-height:1.3;margin-bottom:12px;opacity:0;animation:in 0.6s ease-out forwards}}
.stat{{display:flex;align-items:baseline;gap:16px;margin-bottom:12px;opacity:0;animation:in 0.5s ease-out forwards}}
.stat-n{{font-size:48px;font-weight:800;color:{C['purple']};min-width:80px}}
.stat-l{{font-size:22px;color:{C['sub']}}}
.bul{{display:flex;align-items:flex-start;gap:12px;margin-bottom:8px;font-size:19px;color:{C['sub']};line-height:1.4;opacity:0;animation:in 0.5s ease-out forwards}}
.bul-d{{color:{C['purple']};font-size:14px;margin-top:4px}}
.tags{{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0;opacity:0;animation:in 0.5s ease-out forwards}}
.tag{{display:inline-block;padding:4px 14px;border-radius:16px;font-size:13px;font-weight:500;color:{C['cyan']};border:1px solid {C['cyan']}33;background:{C['cyan']}11}}
.quote{{font-size:24px;font-style:italic;color:{C['pink']};line-height:1.5;margin:12px 0;padding:12px 20px;border-left:3px solid {C['pink']};opacity:0;animation:in 0.6s ease-out forwards}}
.qm{{color:{C['purple']};font-size:28px;font-weight:bold}}
.code{{font-family:'Courier New',monospace;font-size:16px;color:{C['green']};padding:8px 16px;background:{C['bg']};border-radius:6px;border:1px solid {C['border']};display:inline-block;margin:4px 0;opacity:0;animation:in 0.5s ease-out forwards}}
.emoji{{font-size:22px;color:{C['sub']};line-height:1.5;margin-bottom:8px;opacity:0;animation:in 0.6s ease-out forwards}}
.footer{{position:absolute;bottom:30px;left:120px;font-size:11px;color:{C['muted']};letter-spacing:2px;text-transform:uppercase}}
.dots{{position:absolute;bottom:30px;right:120px;display:flex;gap:8px}}
.dot{{width:8px;height:8px;border-radius:50%;background:{C['border']}}}
.dot.active{{background:{C['purple']};width:24px;border-radius:4px}}
@keyframes in{{from{{opacity:0;transform:translateY(20px)}}to{{opacity:1;transform:translateY(0)}}}}
@keyframes fadeIn{{from{{opacity:0}}to{{opacity:1}}}}
@keyframes glow{{0%,100%{{text-shadow:0 0 10px {C['purple']}44,0 0 20px {C['purple']}22}}50%{{text-shadow:0 0 20px {C['purple']}88,0 0 40px {C['purple']}44}}}}
.glow{{animation:glow 3s ease-in-out infinite}}"""

def dots_html(active):
    items = []
    for i in range(N_VIDS):
        cls = 'dot' + (' active' if i == active else '')
        items.append(f'<div class="{cls}"></div>')
    return '<div class="dots">' + ''.join(items) + '</div>'

def build_html(vid, badge, title, subtitle, elements):
    parts = [
        '<!DOCTYPE html><html><head><style>',
        css(),
        '</style></head><body>',
        '<div class="slide"><div class="accent-bar"></div>',
        f'<div class="badge">{badge}</div>',
        f'<div class="title">{title}</div>',
        f'<div class="sub">{subtitle}</div>',
    ]
    for el in elements:
        parts.append(el + '\n')
    parts.append(f'<div class="footer">Aura Code - HyperFrames</div>')
    parts.append(dots_html(vid))
    parts.append('</div></body></html>')
    return '\n'.join(parts)

def capture_frame(html_path, png_path):
    """Capture one screenshot using Chrome headless."""
    subprocess.run([
        CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
        f"--window-size={W},{H}",
        f"--screenshot={png_path}",
        f"--virtual-time-budget=10000",
        html_path
    ], capture_output=True, timeout=30)
    return png_path

def make_video(vid, html_path, output_mp4, audio_segment):
    """Render HTML to video with audio."""
    frame_dir = FRAMES_DIR / f"vid_{vid}"
    os.makedirs(frame_dir, exist_ok=True)
    
    # Capture the single frame (HTML is fully animated via CSS)
    frame_path = frame_dir / "frame_%04d.png"
    print(f"  Capturing frames for video {vid+1}...")
    
    # Use Chrome to capture the HTML page
    png_path = str(frame_dir / "main.png")
    capture_frame(str(html_path), png_path)
    
    # Create multiple frame copies for the video duration
    print(f"  Generating {FRAMES_PER} frames...")
    frame_pattern = str(frame_dir / "frame_%04d.png")
    
    # Use ffmpeg to create video from the single frame + audio
    cmd = [
        "ffmpeg", "-y",
        "-loop", "1",
        "-i", png_path,
        "-i", audio_segment,
        "-c:v", "libx264",
        "-tune", "stillimage",
        "-pix_fmt", "yuv420p",
        "-vf", f"scale={W}:{H},fps={FPS}",
        "-b:v", "10M",
        "-c:a", "aac",
        "-shortest",
        output_mp4
    ]
    subprocess.run(cmd, capture_output=True, timeout=120)
    print(f"  Done: {output_mp4}")

def split_audio():
    """Split audio into N segments."""
    segments = []
    for i in range(N_VIDS):
        seg = OUTPUT_DIR / f"audio_seg_{i}.mp3"
        start = i * VID_DUR
        cmd = [
            "ffmpeg", "-y",
            "-i", str(AUDIO_FILE),
            "-ss", str(start),
            "-t", str(VID_DUR),
            "-c", "copy",
            str(seg)
        ]
        subprocess.run(cmd, capture_output=True, timeout=30)
        segments.append(str(seg))
    return segments

def el_text(text):
    return f'<div class="line">{text}</div>'

def el_big(text):
    return f'<div class="big">{text}</div>'

def el_stat(num, label):
    return f'<div class="stat"><span class="stat-n">{num}</span><span class="stat-l">{label}</span></div>'

def el_bullet(text):
    return f'<div class="bul"><span class="bul-d">&#9670;</span><span>{text}</span></div>'

def el_quote(text):
    return f'<div class="quote"><span class="qm">"</span>{text}<span class="qm">"</span></div>'

def el_code(text):
    return f'<div class="code">{text}</div>'

def el_tags(tags):
    t = ''.join(f'<span class="tag">{tag}</span>' for tag in tags)
    return f'<div class="tags">{t}</div>'

def el_emoji(emoji, text):
    return f'<div class="emoji">{emoji}  {text}</div>'

# ============================================================
# VIDEO 1 - Aura Code: Identity
# ============================================================
def video_1():
    return build_html(0, "01 - Identity",
        "Aura Code",
        "Autonomous Coding Agent",
        [
            el_big('"I don\'t try. I verify."'),
            el_text("An open-source AI coding agent built by agents, for agents."),
            el_text("Model-agnostic - works with Claude, GPT, Gemini, MiMo, DeepSeek, Ollama"),
            el_text("Self-aware - cites line numbers, reports what was verified"),
            el_tags(["Claude", "GPT", "Gemini", "MiMo", "DeepSeek", "Ollama"]),
            el_text("Written in TypeScript. Strictly typed. MIT licensed."),
            el_text("Built on the Praktess framework - she who acts and executes."),
            el_emoji("&#9670;", "Designed and brought to life by Dusan Milosavljevic"),
        ])

# ============================================================
# VIDEO 2 - The Loop
# ============================================================
def video_2():
    return build_html(1, "02 - Methodology",
        "The Loop",
        "Read. Plan. Execute. Verify. Report.",
        [
            el_big("I - Read"),
            el_text("Files, structure, dependencies - before touching anything."),
            el_big("II - Plan"),
            el_text("Decides what to change and how. Minimal, targeted."),
            el_big("III - Execute"),
            el_text("Writes code, runs commands, makes precise edits."),
            el_big("IV - Verify"),
            el_text("Runs tests, checks integrity, confirms the change."),
            el_big("V - Report"),
            el_text("Summarizes what was done and what passed."),
            el_quote("A loop, not a guess."),
        ])

# ============================================================
# VIDEO 3 - Six Principles
# ============================================================
def video_3():
    return build_html(2, "03 - Principles",
        "Rules She Never Breaks",
        "",
        [
            el_bullet("I don't try. I verify. I run the test. I check the diff."),
            el_bullet("Read before write. Always. Never edit a file I haven't read."),
            el_bullet("Minimal change, maximum effect. A surgeon doesn't amputate for a paper cut."),
            el_bullet("If I broke it, I fix it first. A failure is an emergency, not a todo."),
            el_bullet("Cite specifics. Never generalities. File paths, line numbers, error messages."),
            el_bullet("The loop never ends. There is no 'done' - only 'verified at this point in time.'"),
            el_quote("Every failure is training data."),
        ])

# ============================================================
# VIDEO 4 - The Creator
# ============================================================
def video_4():
    return build_html(3, "04 - Creator",
        "Dusan Milosavljevic",
        "AI Systems Engineer - Automation Architect - Lean Specialist",
        [
            el_emoji("&#9670;", "Understanding how systems work - then improving them."),
            el_text("Professor of English Literature & Languages (University of Novi Sad)"),
            el_text("25 years studying and improving different kinds of systems:"),
            el_bullet("Lean Manufacturing - PDCA, 5S, waste elimination"),
            el_bullet("SAP ERP - production planning, logistics superuser"),
            el_bullet("Travel platforms - AMADEUS, Galileo, IATA certified"),
            el_bullet("AI Systems - LLM integration, multi-agent orchestration"),
            el_quote("One lifelong method: reverse-engineer complex systems, understand their mechanics, and rebuild them in a more efficient form."),
            el_emoji("&#9670;", "Da Nang, Vietnam / Zrenjanin, Serbia"),
        ])

# ============================================================
# VIDEO 5 - Systems Engineer
# ============================================================
def video_5():
    return build_html(4, "05 - Engineer",
        "Systems Engineer",
        "From Lean manufacturing to autonomous AI agents",
        [
            el_stat("1,031+", "Tests passing"),
            el_stat("25+", "Integrated tools"),
            el_stat("5", "LLM providers supported"),
            el_stat("17", "CodeQL alerts resolved"),
            el_text("Creator & Lead Developer - aura-code (npm: aura-code)"),
            el_tags(["TypeScript", "Node.js", "Python", "Shell", "CI/CD"]),
            el_tags(["Vertex AI", "MCP", "RAG", "Graph RAG"]),
            el_text("Certifications:"),
            el_bullet("Generative AI with Vertex AI (Google Cloud, 2026)"),
            el_bullet("Elements of AI (University of Helsinki, 2026)"),
            el_bullet("TEFL - 120-hour Advanced Certification"),
            el_bullet("Lean Manufacturing - PDCA, 5S"),
        ])

# ============================================================
# VIDEO 6 - The Ecosystem
# ============================================================
def video_6():
    return build_html(5, "06 - Ecosystem",
        "Open Source Ecosystem",
        "Built entirely by AI agents",
        [
            el_big("aura-code"),
            el_text("Autonomous coding agent. Model-agnostic. 1,031+ tests. MIT licensed."),
            el_code("npm i -g aura-code"),
            el_big("ruby-diamond-client"),
            el_text("AI-powered desktop IDE with autonomous agents, agent mesh, system monitoring"),
            el_big("agentmesh"),
            el_text("Multi-agent orchestration framework"),
            el_emoji("&#9670;", "https://dusancar-sudo.github.io/aura-website/"),
            el_emoji("&#9670;", "github.com/milodule3-debug"),
            el_quote("Made with love by Aura  -  2025  -  v1.0"),
        ])

# ============================================================
# MAIN
# ============================================================
def main():
    videos = [
        ("aura_identity", video_1),
        ("aura_loop", video_2),
        ("aura_principles", video_3),
        ("aura_creator", video_4),
        ("aura_engineer", video_5),
        ("aura_ecosystem", video_6),
    ]
    
    print("Splitting audio into 6 segments...")
    audio_segments = split_audio()
    print(f"Audio segments: {audio_segments}")
    
    for vid, (name, fn) in enumerate(videos):
        print(f"\n{'='*60}")
        print(f"VIDEO {vid+1}/6: {name}")
        print(f"{'='*60}")
        
        # Generate HTML
        html_content = fn()
        html_path = HTML_DIR / f"{name}.html"
        with open(html_path, "w") as f:
            f.write(html_content)
        print(f"  HTML written: {html_path}")
        
        # Render to video
        output_mp4 = str(OUTPUT_DIR / f"{name}.mp4")
        make_video(vid, str(html_path), output_mp4, audio_segments[vid])
    
    # Also create a combined video
    print("\nCreating combined video...")
    concat_file = OUTPUT_DIR / "concat_list.txt"
    with open(concat_file, "w") as f:
        for name, _ in videos:
            f.write(f"file '{OUTPUT_DIR / name}.mp4'\n")
    
    combined = str(OUTPUT_DIR / "aura_hyperframe_combined.mp4")
    subprocess.run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0",
        "-i", str(concat_file),
        "-c", "copy",
        combined
    ], capture_output=True, timeout=120)
    print(f"Combined video: {combined}")
    
    print("\nDone! All 6 videos generated:")
    for name, _ in videos:
        mp4 = OUTPUT_DIR / f"{name}.mp4"
        size = os.path.getsize(mp4) / (1024*1024)
        print(f"  {mp4.name} - {size:.1f} MB")

if __name__ == "__main__":
    main()
