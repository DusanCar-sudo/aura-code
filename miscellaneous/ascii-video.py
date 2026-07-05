#!/usr/bin/env python3
"""
Practess — Generative ASCII Art Video
"I don't try. I verify."

A coding agent built entirely by AI agents.
"""

import numpy as np
import subprocess
import sys
import os
import time
from PIL import Image, ImageDraw, ImageFont

# ─── Config ────────────────────────────────────────────────────────────────
VW, VH = 1920, 1080
FPS = 24
DURATION = 20  # seconds
TOTAL_FRAMES = FPS * DURATION
OUTPUT = "/home/dusan/ruby-code/Practess-ASCII.mp4"

# ─── Font ──────────────────────────────────────────────────────────────────
FONT_PREFS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf",
    "/usr/share/fonts/truetype/ubuntu/UbuntuMono-R.ttf",
]

def find_font():
    for p in FONT_PREFS:
        if os.path.exists(p):
            return p
    raise FileNotFoundError("No monospace font found")

FONT_PATH = find_font()

# ─── Grid Layer ────────────────────────────────────────────────────────────
class Grid:
    def __init__(self, font_size):
        self.font = ImageFont.truetype(FONT_PATH, font_size)
        asc, desc = self.font.getmetrics()
        bbox = self.font.getbbox("M")
        self.cw = bbox[2] - bbox[0]
        self.ch = asc + desc
        self.cols = VW // self.cw
        self.rows = VH // self.ch
        self.ox = (VW - self.cols * self.cw) // 2
        self.oy = (VH - self.rows * self.ch) // 2

        cx, cy = self.cols / 2.0, self.rows / 2.0
        asp = self.cw / self.ch
        cc = np.arange(self.cols, dtype=np.float32)[None, :]
        rr = np.arange(self.rows, dtype=np.float32)[:, None]
        self.dx = cc - cx
        self.dy = (rr - cy) * asp
        self.dist = np.sqrt(self.dx**2 + self.dy**2)
        self.angle = np.arctan2(self.dy, self.dx)
        self.cc = cc
        self.rr = rr

        # Pre-rasterize chars
        all_chars = set()
        for pal in [PAL_DENSE, PAL_RUNE, PAL_CIRCUIT, PAL_BLOCKS, PAL_KATA]:
            all_chars.update(pal)
        all_chars.update("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:;-!|/\\<>{}[]()@#$%^&*+=~`'\"?")
        all_chars.discard(" ")
        self.bm = {}
        for c in all_chars:
            img = Image.new("L", (self.cw, self.ch), 0)
            ImageDraw.Draw(img).text((0, 0), c, fill=255, font=self.font)
            self.bm[c] = np.array(img, dtype=np.float32) / 255.0

    def render(self, chars, colors, canvas=None):
        if canvas is None:
            canvas = np.zeros((VH, VW, 3), dtype=np.uint8)
        for row in range(self.rows):
            y = self.oy + row * self.ch
            if y + self.ch > VH:
                break
            for col in range(self.cols):
                c = chars[row, col]
                if c == " ":
                    continue
                x = self.ox + col * self.cw
                if x + self.cw > VW:
                    break
                if c in self.bm:
                    a = self.bm[c]
                    canvas[y:y+self.ch, x:x+self.cw] = np.maximum(
                        canvas[y:y+self.ch, x:x+self.cw],
                        (a[:, :, None] * colors[row, col]).astype(np.uint8)
                    )
        return canvas


# ─── Palettes ──────────────────────────────────────────────────────────────
PAL_DENSE   = " .:;+=xX$#@█"
PAL_RUNE    = " .ᚠᚡᚢᚣᚤᚥᚦᚧᚨᚩᚪᚫᚬᚭᚮ"
PAL_CIRCUIT = " .·─│┌┐└┘┼○●□■▲▼"
PAL_BLOCKS  = " ░▒▓█▄▀"
PAL_KATA    = " ·ｱｲｳｴｵｶｷｸｹｺ"


# ─── Color helpers ─────────────────────────────────────────────────────────
def hsv2rgb(h, s, v):
    h = h % 1.0
    c = v * s
    x = c * (1 - np.abs((h * 6) % 2 - 1))
    m = v - c
    r = np.zeros_like(h)
    g = np.zeros_like(h)
    b = np.zeros_like(h)
    mask = (h * 6) < 1; r[mask] = c[mask]; g[mask] = x[mask]
    mask = ((h * 6) >= 1) & ((h * 6) < 2); r[mask] = x[mask]; g[mask] = c[mask]
    mask = ((h * 6) >= 2) & ((h * 6) < 3); g[mask] = c[mask]; b[mask] = x[mask]
    mask = ((h * 6) >= 3) & ((h * 6) < 4); g[mask] = x[mask]; b[mask] = c[mask]
    mask = ((h * 6) >= 4) & ((h * 6) < 5); r[mask] = x[mask]; b[mask] = c[mask]
    mask = (h * 6) >= 5; r[mask] = c[mask]; b[mask] = x[mask]
    return (np.clip((r+m)*255, 0, 255).astype(np.uint8),
            np.clip((g+m)*255, 0, 255).astype(np.uint8),
            np.clip((b+m)*255, 0, 255).astype(np.uint8))

def mkc(R, G, B, rows, cols):
    o = np.zeros((rows, cols, 3), dtype=np.uint8)
    o[:,:,0] = R; o[:,:,1] = G; o[:,:,2] = B
    return o

def val2char(v, mask, pal):
    n = len(pal)
    idx = np.clip((v * n).astype(int), 0, n - 1)
    out = np.full(v.shape, " ", dtype="U1")
    for i, ch in enumerate(pal):
        out[mask & (idx == i)] = ch
    return out

def tonemap(canvas, gamma=0.75):
    f = canvas.astype(np.float32)
    lo, hi = np.percentile(f[::4, ::4], [1, 99.5])
    if hi - lo < 10:
        hi = lo + 10
    f = np.clip((f - lo) / (hi - lo), 0, 1) ** gamma
    return (f * 255).astype(np.uint8)


# ─── Scene Functions ───────────────────────────────────────────────────────

def scene_void(g, t):
    """Opening: dark void with subtle noise"""
    noise = np.random.random((g.rows, g.cols)) * 0.05
    hue = np.full_like(noise, 0.95)  # ruby red hue
    sat = np.full_like(noise, 0.8)
    R, G, B = hsv2rgb(hue, sat, noise)
    chars = val2char(noise, noise > 0.02, PAL_DENSE)
    canvas = mkc(R, G, B, g.rows, g.cols)
    return g.render(chars, canvas)

def scene_title(g, t):
    """Title: HER RUBYNESS appears with matrix rain"""
    # Background: matrix-like rain
    phase = t * 2
    rain = np.sin(g.rr * 0.3 + phase) * np.cos(g.cc * 0.2 - phase * 0.7)
    rain = (rain + 1) / 2 * 0.15
    hue_rain = np.full_like(rain, 0.0)  # red hue
    sat_rain = np.full_like(rain, 0.9)
    R_r, G_r, B_r = hsv2rgb(hue_rain, sat_rain, rain)
    chars_rain = val2char(rain, rain > 0.05, PAL_KATA)

    canvas = mkc(R_r, G_r, B_r, g.rows, g.cols)
    canvas = g.render(chars_rain, canvas)

    # Title text overlay
    title = "HER RUBYNESS"
    fade = np.clip(t * 2, 0, 1)
    if fade > 0.1:
        row = g.rows // 2 - 1
        col_start = (g.cols - len(title)) // 2
        title_color = np.array([int(204 * fade), int(0), int(51 * fade)], dtype=np.uint8)
        for i, c in enumerate(title):
            cc = col_start + i
            if 0 <= row < g.rows and 0 <= cc < g.cols:
                # Draw title character
                img = Image.new("L", (g.cw, g.ch), 0)
                ImageDraw.Draw(img).text((0, 0), c, fill=255, font=g.font)
                bm = np.array(img, dtype=np.float32) / 255.0
                y = g.oy + row * g.ch
                x = g.ox + cc * g.cw
                if y + g.ch <= VH and x + g.cw <= VW:
                    canvas[y:y+g.ch, x:x+g.cw] = np.maximum(
                        canvas[y:y+g.ch, x:x+g.cw],
                        (bm[:, :, None] * title_color).astype(np.uint8)
                    )

    # Tagline
    tagline = "I don't try. I verify."
    tag_fade = np.clip((t - 1.5) * 2, 0, 1)
    if tag_fade > 0.1:
        row_t = g.rows // 2 + 2
        col_t = (g.cols - len(tagline)) // 2
        tag_color = np.array([int(255 * tag_fade), int(215 * tag_fade), int(0 * tag_fade)], dtype=np.uint8)
        for i, c in enumerate(tagline):
            cc = col_t + i
            if 0 <= row_t < g.rows and 0 <= cc < g.cols:
                img = Image.new("L", (g.cw, g.ch), 0)
                ImageDraw.Draw(img).text((0, 0), c, fill=255, font=g.font)
                bm = np.array(img, dtype=np.float32) / 255.0
                y = g.oy + row_t * g.ch
                x = g.ox + cc * g.cw
                if y + g.ch <= VH and x + g.cw <= VW:
                    canvas[y:y+g.ch, x:x+g.cw] = np.maximum(
                        canvas[y:y+g.ch, x:x+g.cw],
                        (bm[:, :, None] * tag_color).astype(np.uint8)
                    )

    return canvas

def scene_architecture(g, t):
    """Architecture: flowing circuit patterns"""
    # Pulsing waves from center
    wave = np.sin(g.dist * 0.15 - t * 3) * 0.5 + 0.5
    wave *= np.exp(-g.dist * 0.02)
    hue = (g.angle / (2 * np.pi) + t * 0.1) % 1.0
    sat = np.full_like(wave, 0.8)
    R, G, B = hsv2rgb(hue, sat, wave * 0.6)
    chars = val2char(wave, wave > 0.1, PAL_CIRCUIT)
    canvas = mkc(R, G, B, g.rows, g.cols)
    canvas = g.render(chars, canvas)

    # Pipeline text
    labels = ["CLI", "Router", "Agent", "Memory", "KG", "LLM"]
    row = g.rows // 2
    spacing = g.cols // (len(labels) + 1)
    for i, label in enumerate(labels):
        col = spacing * (i + 1) - len(label) // 2
        appear = np.clip((t - 0.5 - i * 0.4) * 3, 0, 1)
        if appear > 0.1:
            color = np.array([int(255 * appear), int(255 * appear), int(255 * appear)], dtype=np.uint8)
            for j, c in enumerate(label):
                cc = col + j
                if 0 <= row < g.rows and 0 <= cc < g.cols:
                    img = Image.new("L", (g.cw, g.ch), 0)
                    ImageDraw.Draw(img).text((0, 0), c, fill=255, font=g.font)
                    bm = np.array(img, dtype=np.float32) / 255.0
                    y = g.oy + row * g.ch
                    x = g.ox + cc * g.cw
                    if y + g.ch <= VH and x + g.cw <= VW:
                        canvas[y:y+g.ch, x:x+g.cw] = np.maximum(
                            canvas[y:y+g.ch, x:x+g.cw],
                            (bm[:, :, None] * color).astype(np.uint8)
                        )

    # Arrows between labels
    for i in range(len(labels) - 1):
        col_a = spacing * (i + 1) + len(labels[i]) // 2 + 1
        col_b = spacing * (i + 2) - len(labels[i+1]) // 2 - 1
        arrow_fade = np.clip((t - 0.8 - i * 0.4) * 3, 0, 1)
        if arrow_fade > 0.1:
            for cc in range(col_a, min(col_b, g.cols)):
                if 0 <= row < g.rows:
                    img = Image.new("L", (g.cw, g.ch), 0)
                    ImageDraw.Draw(img).text((0, 0), "→", fill=255, font=g.font)
                    bm = np.array(img, dtype=np.float32) / 255.0
                    y = g.oy + row * g.ch
                    x = g.ox + cc * g.cw
                    color = np.array([int(204 * arrow_fade), int(0), int(51 * arrow_fade)], dtype=np.uint8)
                    if y + g.ch <= VH and x + g.cw <= VW:
                        canvas[y:y+g.ch, x:x+g.cw] = np.maximum(
                            canvas[y:y+g.ch, x:x+g.cw],
                            (bm[:, :, None] * color).astype(np.uint8)
                        )

    return canvas

def scene_stats(g, t):
    """Stats: big numbers appearing"""
    stats = [
        ("566", "tests passing"),
        ("141", "knowledge nodes"),
        ("5", "AI providers"),
        ("87%", "coverage"),
    ]

    canvas = np.zeros((VH, VW, 3), dtype=np.uint8)

    # Background: subtle gradient
    grad = np.linspace(0, 0.08, g.cols)[None, :] * np.ones((g.rows, 1))
    hue_bg = np.full_like(grad, 0.95)
    sat_bg = np.full_like(grad, 0.5)
    R_bg, G_bg, B_bg = hsv2rgb(hue_bg, sat_bg, grad)
    canvas = mkc(R_bg, G_bg, B_bg, g.rows, g.cols)
    bg_chars = val2char(grad, grad > 0.02, PAL_DENSE)
    canvas = g.render(bg_chars, canvas)

    for i, (num, label) in enumerate(stats):
        appear = np.clip((t - i * 1.2) * 2, 0, 1)
        if appear < 0.1:
            continue

        row_offset = (i % 2) * (g.rows // 3) + g.rows // 4
        col_offset = (i // 2) * (g.cols // 2) + g.cols // 4

        # Number
        num_color = np.array([int(204 * appear), int(0), int(51 * appear)], dtype=np.uint8)
        for j, c in enumerate(num):
            cc = col_offset + j
            if 0 <= row_offset < g.rows and 0 <= cc < g.cols:
                img = Image.new("L", (g.cw, g.ch), 0)
                ImageDraw.Draw(img).text((0, 0), c, fill=255, font=g.font)
                bm = np.array(img, dtype=np.float32) / 255.0
                y = g.oy + row_offset * g.ch
                x = g.ox + cc * g.cw
                if y + g.ch <= VH and x + g.cw <= VW:
                    canvas[y:y+g.ch, x:x+g.cw] = np.maximum(
                        canvas[y:y+g.ch, x:x+g.cw],
                        (bm[:, :, None] * num_color).astype(np.uint8)
                    )

        # Label
        lbl_color = np.array([int(255 * appear), int(215 * appear), int(0)], dtype=np.uint8)
        for j, c in enumerate(label):
            cc = col_offset + j
            rr = row_offset + 1
            if 0 <= rr < g.rows and 0 <= cc < g.cols:
                img = Image.new("L", (g.cw, g.ch), 0)
                ImageDraw.Draw(img).text((0, 0), c, fill=255, font=g.font)
                bm = np.array(img, dtype=np.float32) / 255.0
                y = g.oy + rr * g.ch
                x = g.ox + cc * g.cw
                if y + g.ch <= VH and x + g.cw <= VW:
                    canvas[y:y+g.ch, x:x+g.cw] = np.maximum(
                        canvas[y:y+g.ch, x:x+g.cw],
                        (bm[:, :, None] * lbl_color).astype(np.uint8)
                    )

    return canvas

def scene_agents(g, t):
    """Multi-agent: Researcher → Coder → Reviewer"""
    canvas = np.zeros((VH, VW, 3), dtype=np.uint8)

    # Flowing rune background
    rune_flow = np.sin(g.rr * 0.2 + t) * np.cos(g.cc * 0.15 - t * 0.8)
    rune_flow = (rune_flow + 1) / 2 * 0.12
    hue_r = np.full_like(rune_flow, 0.6)  # cyan
    sat_r = np.full_like(rune_flow, 0.7)
    R_r, G_r, B_r = hsv2rgb(hue_r, sat_r, rune_flow)
    chars_bg = val2char(rune_flow, rune_flow > 0.04, PAL_RUNE)
    canvas = mkc(R_r, G_r, B_r, g.rows, g.cols)
    canvas = g.render(chars_bg, canvas)

    agents = [
        ("RESEARCHER", 0.0),   # hue: ruby red
        ("CODER", 0.65),       # hue: cyan
        ("REVIEWER", 0.35),    # hue: green
    ]

    row = g.rows // 2
    spacing = g.cols // (len(agents) + 1)

    for i, (name, hue_val) in enumerate(agents):
        appear = np.clip((t - i * 1.5) * 2, 0, 1)
        if appear < 0.1:
            continue

        col = spacing * (i + 1) - len(name) // 2

        # Agent name
        color = np.array([int(255 * appear), int(255 * appear), int(255 * appear)], dtype=np.uint8)
        for j, c in enumerate(name):
            cc = col + j
            if 0 <= row < g.rows and 0 <= cc < g.cols:
                img = Image.new("L", (g.cw, g.ch), 0)
                ImageDraw.Draw(img).text((0, 0), c, fill=255, font=g.font)
                bm = np.array(img, dtype=np.float32) / 255.0
                y = g.oy + row * g.ch
                x = g.ox + cc * g.cw
                if y + g.ch <= VH and x + g.cw <= VW:
                    canvas[y:y+g.ch, x:x+g.cw] = np.maximum(
                        canvas[y:y+g.ch, x:x+g.cw],
                        (bm[:, :, None] * color).astype(np.uint8)
                    )

        # Colored underline
        under_row = row + 1
        under_color_hsv = np.array([hue_val])
        under_sat = np.array([0.9])
        under_val = np.array([0.8 * appear])
        ru, gu, bu = hsv2rgb(under_color_hsv, under_sat, under_val)
        for j in range(len(name)):
            cc = col + j
            if 0 <= under_row < g.rows and 0 <= cc < g.cols:
                img = Image.new("L", (g.cw, g.ch), 0)
                ImageDraw.Draw(img).text((0, 0), "─", fill=255, font=g.font)
                bm = np.array(img, dtype=np.float32) / 255.0
                y = g.oy + under_row * g.ch
                x = g.ox + cc * g.cw
                uc = np.array([int(ru[0]), int(gu[0]), int(bu[0])], dtype=np.uint8)
                if y + g.ch <= VH and x + g.cw <= VW:
                    canvas[y:y+g.ch, x:x+g.cw] = np.maximum(
                        canvas[y:y+g.ch, x:x+g.cw],
                        (bm[:, :, None] * uc).astype(np.uint8)
                    )

    # Arrows
    for i in range(len(agents) - 1):
        arrow_fade = np.clip((t - 1.0 - i * 1.5) * 2, 0, 1)
        if arrow_fade > 0.1:
            col_a = spacing * (i + 1) + len(agents[i][0]) // 2 + 1
            col_b = spacing * (i + 2) - len(agents[i+1][0]) // 2 - 1
            for cc in range(col_a, min(col_b, g.cols)):
                if 0 <= row < g.rows:
                    img = Image.new("L", (g.cw, g.ch), 0)
                    ImageDraw.Draw(img).text((0, 0), "→", fill=255, font=g.font)
                    bm = np.array(img, dtype=np.float32) / 255.0
                    y = g.oy + row * g.ch
                    x = g.ox + cc * g.cw
                    color = np.array([int(204 * arrow_fade), int(0), int(51 * arrow_fade)], dtype=np.uint8)
                    if y + g.ch <= VH and x + g.cw <= VW:
                        canvas[y:y+g.ch, x:x+g.cw] = np.maximum(
                            canvas[y:y+g.ch, x:x+g.cw],
                            (bm[:, :, None] * color).astype(np.uint8)
                        )

    return canvas

def scene_closing(g, t):
    """Closing: tagline and credits"""
    canvas = np.zeros((VH, VW, 3), dtype=np.uint8)

    # Radial pulse
    pulse = np.sin(g.dist * 0.1 - t * 2) * 0.5 + 0.5
    pulse *= np.exp(-g.dist * 0.015)
    hue = (t * 0.05) % 1.0
    sat = np.full_like(pulse, 0.7)
    R, G, B = hsv2rgb(np.full_like(pulse, hue), sat, pulse * 0.3)
    chars_bg = val2char(pulse, pulse > 0.1, PAL_BLOCKS)
    canvas = mkc(R, G, B, g.rows, g.cols)
    canvas = g.render(chars_bg, canvas)

    # Main tagline
    tagline = "I don't try. I verify."
    fade = np.clip(t * 1.5, 0, 1)
    row = g.rows // 2 - 2
    col = (g.cols - len(tagline)) // 2
    color = np.array([int(255 * fade), int(215 * fade), int(0)], dtype=np.uint8)
    for j, c in enumerate(tagline):
        cc = col + j
        if 0 <= row < g.rows and 0 <= cc < g.cols:
            img = Image.new("L", (g.cw, g.ch), 0)
            ImageDraw.Draw(img).text((0, 0), c, fill=255, font=g.font)
            bm = np.array(img, dtype=np.float32) / 255.0
            y = g.oy + row * g.ch
            x = g.ox + cc * g.cw
            if y + g.ch <= VH and x + g.cw <= VW:
                canvas[y:y+g.ch, x:x+g.cw] = np.maximum(
                    canvas[y:y+g.ch, x:x+g.cw],
                    (bm[:, :, None] * color).astype(np.uint8)
                )

    # GitHub link
    link = "github.com/milodule3-debug/ruby-code"
    link_fade = np.clip((t - 1.5) * 2, 0, 1)
    if link_fade > 0.1:
        row_l = g.rows // 2 + 2
        col_l = (g.cols - len(link)) // 2
        lc = np.array([int(200 * link_fade), int(200 * link_fade), int(200 * link_fade)], dtype=np.uint8)
        for j, c in enumerate(link):
            cc = col_l + j
            if 0 <= row_l < g.rows and 0 <= cc < g.cols:
                img = Image.new("L", (g.cw, g.ch), 0)
                ImageDraw.Draw(img).text((0, 0), c, fill=255, font=g.font)
                bm = np.array(img, dtype=np.float32) / 255.0
                y = g.oy + row_l * g.ch
                x = g.ox + cc * g.cw
                if y + g.ch <= VH and x + g.cw <= VW:
                    canvas[y:y+g.ch, x:x+g.cw] = np.maximum(
                        canvas[y:y+g.ch, x:x+g.cw],
                        (bm[:, :, None] * lc).astype(np.uint8)
                    )

    # MIT License
    lic = "MIT License — Built by AI Agents"
    lic_fade = np.clip((t - 2.5) * 2, 0, 1)
    if lic_fade > 0.1:
        row_lc = g.rows // 2 + 4
        col_lc = (g.cols - len(lic)) // 2
        lic_c = np.array([int(150 * lic_fade), int(150 * lic_fade), int(150 * lic_fade)], dtype=np.uint8)
        for j, c in enumerate(lic):
            cc = col_lc + j
            if 0 <= row_lc < g.rows and 0 <= cc < g.cols:
                img = Image.new("L", (g.cw, g.ch), 0)
                ImageDraw.Draw(img).text((0, 0), c, fill=255, font=g.font)
                bm = np.array(img, dtype=np.float32) / 255.0
                y = g.oy + row_lc * g.ch
                x = g.ox + cc * g.cw
                if y + g.ch <= VH and x + g.cw <= VW:
                    canvas[y:y+g.ch, x:x+g.cw] = np.maximum(
                        canvas[y:y+g.ch, x:x+g.cw],
                        (bm[:, :, None] * lic_c).astype(np.uint8)
                    )

    return canvas


# ─── Scene Table ───────────────────────────────────────────────────────────
SCENES = [
    (0.0,  scene_void),
    (2.0,  scene_title),
    (7.0,  scene_architecture),
    (12.0, scene_stats),
    (15.0, scene_agents),
    (17.5, scene_closing),
]

def get_scene(t):
    fn = SCENES[0][1]
    for ts, sfn in SCENES:
        if t >= ts:
            fn = sfn
    return fn


# ─── Main ──────────────────────────────────────────────────────────────────
def main():
    print(f"Practess — ASCII Video Generator")
    print(f"Resolution: {VW}x{VH} @ {FPS}fps, {DURATION}s ({TOTAL_FRAMES} frames)")
    print(f"Output: {OUTPUT}")
    print()

    grid = Grid(16)
    print(f"Grid: {grid.cols}x{grid.rows} chars, cell {grid.cw}x{grid.ch}px")

    # Start ffmpeg encoder
    cmd = [
        "ffmpeg", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{VW}x{VH}", "-r", str(FPS),
        "-i", "pipe:0",
        "-c:v", "libx264", "-preset", "fast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        OUTPUT
    ]
    stderr_log = open("/tmp/ascii-video-encode.log", "w")
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, stderr=stderr_log)

    t_start = time.time()
    for fi in range(TOTAL_FRAMES):
        t = fi / FPS
        scene_fn = get_scene(t)
        canvas = scene_fn(grid, t)

        canvas = tonemap(canvas, 0.8)
        proc.stdin.write(canvas.tobytes())

        if fi % FPS == 0:
            elapsed = time.time() - t_start
            pct = fi / TOTAL_FRAMES * 100
            fps_actual = fi / max(elapsed, 0.001)
            print(f"\r  Frame {fi:4d}/{TOTAL_FRAMES} ({pct:.0f}%) — {fps_actual:.1f} fps", end="", flush=True)

    proc.stdin.close()
    proc.wait()
    stderr_log.close()

    elapsed = time.time() - t_start
    print(f"\n\nDone! {elapsed:.1f}s render time")
    print(f"Output: {OUTPUT}")

    # Add silent audio track
    final = OUTPUT.replace(".mp4", "-final.mp4")
    subprocess.run([
        "ffmpeg", "-y",
        "-i", OUTPUT,
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-c:v", "copy", "-c:a", "aac", "-shortest",
        final
    ], capture_output=True)
    os.replace(final, OUTPUT)
    print(f"Final output: {OUTPUT}")


if __name__ == "__main__":
    main()
