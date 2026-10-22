"""Raw RGB frame -> downscaled PNG for the screen sidecar.

Kept apart from aura_screen.py so it imports without GStreamer, AT-SPI or
evdev, which lets the test suite exercise it on any machine.
"""
import subprocess

PNG_COMPRESS_LEVEL = 1   # screenshots are transient; level 6 costs ~5x the time for ~20% smaller files


def encode_png(data, w, h, out_path, max_pixels):
    """Raw RGB -> downscaled PNG. PIL in-process; ImageMagick only if PIL is absent.

    The ImageMagick path used to be the only one. It spawns a process per
    screenshot and encodes at default compression, which is most of the
    per-screenshot wait. PIL does the same work in-process at a faster level.
    """
    scale = min(1.0, (max_pixels / float(w * h)) ** 0.5) if max_pixels else 1.0
    tw, th = max(1, int(w * scale)), max(1, int(h * scale))
    try:
        from PIL import Image
    except ImportError:
        return _encode_png_convert(data, w, h, out_path, tw, th, scale)
    img = Image.frombytes("RGB", (w, h), data)
    if (tw, th) != (w, h):
        img = img.resize((tw, th), Image.LANCZOS)
    img.save(out_path, format="PNG", compress_level=PNG_COMPRESS_LEVEL)
    return tw, th, scale


def _encode_png_convert(data, w, h, out_path, tw, th, scale):
    p = subprocess.run(
        ["convert", "-size", f"{w}x{h}", "-depth", "8", "RGB:-",
         "-resize", f"{tw}x{th}!", out_path],
        input=data, capture_output=True)
    if p.returncode != 0:
        raise RuntimeError("convert failed: " + p.stderr.decode()[:200])
    return tw, th, scale
