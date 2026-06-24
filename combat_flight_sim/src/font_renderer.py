from OpenGL.GL import *
import numpy as np
from PIL import Image, ImageDraw, ImageFont

class FontRenderer:
    def __init__(self):
        self.texture_id = None
        self.char_width = 9
        self.char_height = 15
        self.chars_per_row = 16
        self.first_char = 32
        self.last_char = 127
        self._build_atlas()

    def _build_atlas(self):
        cw, ch = self.char_width, self.char_height
        cpr = self.chars_per_row
        n_chars = self.last_char - self.first_char
        rows = (n_chars + cpr - 1) // cpr
        cols = min(n_chars, cpr)

        tw = cols * cw
        th = rows * ch

        img = Image.new('L', (tw, th), 0)
        draw = ImageDraw.Draw(img)

        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 14)
        except Exception:
            try:
                font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 14)
            except Exception:
                font = ImageFont.load_default()

        for i in range(n_chars):
            c = chr(self.first_char + i)
            row = i // cpr
            col = i % cpr
            x = col * cw + 1
            y = row * ch + 1
            draw.text((x, y), c, 255, font=font)

        img_data = np.array(img, dtype=np.uint8)

        self.texture_id = glGenTextures(1)
        glBindTexture(GL_TEXTURE_2D, self.texture_id)

        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR)
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR)
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE)
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE)

        glTexImage2D(GL_TEXTURE_2D, 0, GL_LUMINANCE, tw, th, 0,
                     GL_LUMINANCE, GL_UNSIGNED_BYTE, img_data)

        self.atlas_w = float(tw)
        self.atlas_h = float(th)

    def render_text(self, text, x, y, scale=1.0, color=(0.0, 1.0, 0.0)):
        if not text:
            return

        glBindTexture(GL_TEXTURE_2D, self.texture_id)
        glEnable(GL_TEXTURE_2D)
        glEnable(GL_BLEND)
        glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA)

        glColor3f(*color)
        cw = self.char_width * scale / self.atlas_w
        ch = self.char_height * scale / self.atlas_h

        cpr = self.chars_per_row
        fc = self.first_char

        for i, c in enumerate(text):
            ci = ord(c) - fc
            if ci < 0 or ci >= self.last_char - self.first_char:
                continue
            row = ci // cpr
            col = ci % cpr

            u0 = col * self.char_width / self.atlas_w
            v0 = row * self.char_height / self.atlas_h
            u1 = u0 + self.char_width / self.atlas_w
            v1 = v0 + self.char_height / self.atlas_h

            sx = x + i * self.char_width * scale
            sy = y
            sw = self.char_width * scale
            sh = self.char_height * scale

            glBegin(GL_QUADS)
            glTexCoord2f(u0, v0)
            glVertex2f(sx, sy)
            glTexCoord2f(u1, v0)
            glVertex2f(sx + sw, sy)
            glTexCoord2f(u1, v1)
            glVertex2f(sx + sw, sy + sh)
            glTexCoord2f(u0, v1)
            glVertex2f(sx, sy + sh)
            glEnd()

        glDisable(GL_TEXTURE_2D)
        glDisable(GL_BLEND)
