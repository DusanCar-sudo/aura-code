from OpenGL.GL import *
from OpenGL.GLU import *
import numpy as np
from font_renderer import FontRenderer


class HUD:
    def __init__(self, width, height):
        self.width = width
        self.height = height
        self.aspect = width / height
        self.font = FontRenderer()

    def resize(self, width, height):
        self.width = width
        self.height = height
        self.aspect = width / height

    def render(self, state, weapons=None):
        glPushAttrib(GL_ENABLE_BIT | GL_DEPTH_BUFFER_BIT | GL_LINE_BIT)
        glDisable(GL_DEPTH_TEST)
        glDisable(GL_LIGHTING)
        glDepthMask(GL_FALSE)

        glMatrixMode(GL_PROJECTION)
        glPushMatrix()
        glLoadIdentity()
        gluOrtho2D(-self.aspect, self.aspect, -1.0, 1.0)

        glMatrixMode(GL_MODELVIEW)
        glPushMatrix()
        glLoadIdentity()

        glLineWidth(1.5)
        glEnable(GL_LINE_SMOOTH)
        glEnable(GL_BLEND)
        glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA)

        roll, pitch, yaw = state['orientation'].to_euler()

        self._draw_pitch_ladder(pitch, roll)
        self._draw_velocity_vector(state, roll)
        self._draw_heading_scale(yaw)
        self._draw_airspeed_tape(state)
        self._draw_altitude_tape(state)
        self._draw_g_meter(state)
        self._draw_aoa_indicator(state)
        self._draw_throttle_indicator(state)
        self._draw_crosshair()
        self._draw_weapon_status(state, weapons)
        self._draw_stall_warning(state)

        glPopMatrix()
        glMatrixMode(GL_PROJECTION)
        glPopMatrix()
        glMatrixMode(GL_MODELVIEW)

        glPopAttrib()
        glDepthMask(GL_TRUE)
        glEnable(GL_DEPTH_TEST)

    def _draw_pitch_ladder(self, pitch, roll):
        c, s = np.cos(roll), np.sin(roll)
        fov_factor = 1.2

        for deg in range(-90, 91, 10):
            if deg == 0:
                continue
            pitch_rad = np.radians(deg)
            screen_y = -(pitch - pitch_rad) * fov_factor
            if screen_y < -1.5 or screen_y > 1.5:
                continue

            half_w = 0.08 * (1.0 + abs(deg) / 45.0)
            if deg > 0:
                half_w *= 0.6
            if deg % 30 == 0 and deg != 0:
                half_w *= 1.5

            glBegin(GL_LINES)
            rx1 = -half_w * c - screen_y * s
            ry1 = screen_y * c - half_w * s
            rx2 = half_w * c - screen_y * s
            ry2 = screen_y * c + half_w * s
            glVertex2f(rx1, ry1)
            glVertex2f(rx2, ry2)
            glEnd()

            if deg % 10 == 0:
                label = str(abs(deg))
                lx = (-half_w - 0.04) * c - screen_y * s - 0.02
                ly = screen_y * c + (-half_w - 0.04) * s
                self.font.render_text(label, lx, ly - 0.008, scale=0.0015)

        glBegin(GL_LINE_STRIP)
        for deg in range(-90, 91, 5):
            pitch_rad = np.radians(deg)
            screen_y = -(pitch - pitch_rad) * fov_factor
            if screen_y < -1.5 or screen_y > 1.5:
                continue
            glVertex2f(screen_y * s, screen_y * c)
        glEnd()

    def _draw_velocity_vector(self, state, roll):
        speed = state['speed']
        if speed < 1.0:
            return
        vel = state['velocity']
        vel_dir = vel / np.linalg.norm(vel)
        pitch_angle = np.arcsin(np.clip(vel_dir[1], -1.0, 1.0))
        yaw_angle = np.arctan2(vel_dir[0], -vel_dir[2])

        sy = -pitch_angle * 1.2
        sx = yaw_angle * 1.2

        glBegin(GL_LINE_LOOP)
        r = 0.025
        for i in range(16):
            a = 2.0 * np.pi * i / 16
            glVertex2f(sx + r * np.cos(a), sy + r * np.sin(a))
        glEnd()

        glBegin(GL_LINES)
        glVertex2f(sx - 0.04, sy)
        glVertex2f(sx + 0.04, sy)
        glVertex2f(sx, sy - 0.04)
        glVertex2f(sx, sy + 0.04)
        glEnd()

    def _draw_heading_scale(self, yaw):
        y = 0.85
        heading = np.degrees(yaw)
        if heading < 0:
            heading += 360.0

        glBegin(GL_LINES)
        glVertex2f(-self.aspect, y)
        glVertex2f(self.aspect, y)
        glEnd()

        for deg in range(0, 360, 5):
            offset = (deg - heading + 540.0) % 360.0 - 180.0
            sx = offset * 0.008
            if sx < -self.aspect or sx > self.aspect:
                continue
            if deg % 90 == 0:
                glBegin(GL_LINES)
                glVertex2f(sx, y + 0.01)
                glVertex2f(sx, y + 0.04)
                glEnd()
                label = ['N', 'E', 'S', 'W'][deg // 90]
                self.font.render_text(label, sx - 0.008, y + 0.038, scale=0.0015)
            elif deg % 30 == 0:
                glBegin(GL_LINES)
                glVertex2f(sx, y + 0.01)
                glVertex2f(sx, y + 0.03)
                glEnd()
            else:
                glBegin(GL_LINES)
                glVertex2f(sx, y + 0.01)
                glVertex2f(sx, y + 0.02)
                glEnd()

        glBegin(GL_LINE_LOOP)
        glVertex2f(-0.02, y - 0.025)
        glVertex2f(0.02, y - 0.025)
        glVertex2f(0.02, y + 0.01)
        glVertex2f(0.0, y + 0.035)
        glVertex2f(-0.02, y + 0.01)
        glEnd()

    def _draw_airspeed_tape(self, state):
        ias = state['ias']
        x = -self.aspect + 0.04
        cx = x + 0.02

        glBegin(GL_LINE_LOOP)
        glVertex2f(cx - 0.01, -0.6)
        glVertex2f(cx + 0.01, -0.6)
        glVertex2f(cx + 0.01, 0.6)
        glVertex2f(cx - 0.01, 0.6)
        glEnd()

        step = 10.0
        start = int(ias / step) * step - 50.0
        end = int(ias / step) * step + 50.0

        glBegin(GL_LINES)
        for val in range(int(start), int(end) + 1, int(step)):
            offset = (val - ias) * 0.006
            if offset < -0.55 or offset > 0.55:
                continue
            if val % 20 == 0:
                glVertex2f(cx - 0.03, offset)
                glVertex2f(cx + 0.03, offset)
            else:
                glVertex2f(cx - 0.02, offset)
                glVertex2f(cx + 0.02, offset)
        glEnd()

        for val in range(int(start), int(end + 1), int(step)):
            if val % 20 != 0:
                continue
            offset = (val - ias) * 0.006
            if offset < -0.55 or offset > 0.55:
                continue
            self.font.render_text(str(val), cx - 0.045, offset - 0.01, scale=0.001)

        glBegin(GL_LINE_LOOP)
        glVertex2f(cx - 0.04, -0.03)
        glVertex2f(cx + 0.04, -0.03)
        glVertex2f(cx + 0.04, 0.03)
        glVertex2f(cx - 0.04, 0.03)
        glEnd()

    def _draw_altitude_tape(self, state):
        alt = state['altitude']
        x = self.aspect - 0.04
        cx = x - 0.02

        glBegin(GL_LINE_LOOP)
        glVertex2f(cx - 0.01, -0.6)
        glVertex2f(cx + 0.01, -0.6)
        glVertex2f(cx + 0.01, 0.6)
        glVertex2f(cx - 0.01, 0.6)
        glEnd()

        step = 50.0
        start = int(alt / step) * step - 100.0
        end = int(alt / step) * step + 100.0

        glBegin(GL_LINES)
        for val in range(int(start), int(end) + 1, int(step)):
            offset = (val - alt) * 0.003
            if offset < -0.55 or offset > 0.55:
                continue
            if val % 100 == 0:
                glVertex2f(cx - 0.03, offset)
                glVertex2f(cx + 0.03, offset)
            else:
                glVertex2f(cx - 0.02, offset)
                glVertex2f(cx + 0.02, offset)
        glEnd()

        for val in range(int(start), int(end + 1), int(step)):
            if val % 100 != 0:
                continue
            offset = (val - alt) * 0.003
            if offset < -0.55 or offset > 0.55:
                continue
            self.font.render_text(f"{int(val)}", cx + 0.03, offset - 0.01, scale=0.001)

        glBegin(GL_LINE_LOOP)
        glVertex2f(cx - 0.04, -0.03)
        glVertex2f(cx + 0.04, -0.03)
        glVertex2f(cx + 0.04, 0.03)
        glVertex2f(cx - 0.04, 0.03)
        glEnd()

    def _draw_g_meter(self, state):
        if 'acceleration' not in state:
            return
        acc = state['acceleration']
        gs = acc[1] / 9.81
        x, y = self.aspect - 0.08, -0.7

        gs = np.clip(gs, -2.0, 10.0)
        fraction = (gs + 2.0) / 12.0

        glBegin(GL_LINE_LOOP)
        glVertex2f(x - 0.015, y - 0.03)
        glVertex2f(x + 0.015, y - 0.03)
        glVertex2f(x + 0.015, y + 0.03)
        glVertex2f(x - 0.015, y + 0.03)
        glEnd()

        glBegin(GL_QUADS)
        glVertex2f(x - 0.013, y - 0.028)
        glVertex2f(x + 0.013, y - 0.028)
        glVertex2f(x + 0.013, y - 0.028 + fraction * 0.056)
        glVertex2f(x - 0.013, y - 0.028 + fraction * 0.056)
        glEnd()

        self.font.render_text(f"{gs:.1f}G", x - 0.018, y + 0.035, scale=0.001)

    def _draw_aoa_indicator(self, state):
        aoa = np.degrees(state['aoa'])
        x, y = -self.aspect + 0.08, 0.5

        aoa = np.clip(aoa, -5.0, 30.0)
        fraction = (aoa + 5.0) / 35.0

        glBegin(GL_LINE_LOOP)
        glVertex2f(x - 0.015, y - 0.03)
        glVertex2f(x + 0.015, y - 0.03)
        glVertex2f(x + 0.015, y + 0.03)
        glVertex2f(x - 0.015, y + 0.03)
        glEnd()

        glBegin(GL_QUADS)
        color = (1.0, 1.0, 0.0) if fraction > 0.6 else (0.0, 1.0, 0.0)
        if fraction > 0.85:
            color = (1.0, 0.0, 0.0)
        glColor3f(*color)
        glVertex2f(x - 0.013, y - 0.028)
        glVertex2f(x + 0.013, y - 0.028)
        glVertex2f(x + 0.013, y - 0.028 + fraction * 0.056)
        glVertex2f(x - 0.013, y - 0.028 + fraction * 0.056)
        glEnd()

        glColor3f(0.0, 1.0, 0.0)

    def _draw_throttle_indicator(self, state):
        thr = state['throttle']
        x, y = -self.aspect + 0.08, -0.5

        glBegin(GL_LINE_LOOP)
        glVertex2f(x - 0.015, y - 0.03)
        glVertex2f(x + 0.015, y - 0.03)
        glVertex2f(x + 0.015, y + 0.03)
        glVertex2f(x - 0.015, y + 0.03)
        glEnd()

        glBegin(GL_QUADS)
        glVertex2f(x - 0.013, y - 0.028)
        glVertex2f(x + 0.013, y - 0.028)
        glVertex2f(x + 0.013, y - 0.028 + thr * 0.056)
        glVertex2f(x - 0.013, y - 0.028 + thr * 0.056)
        glEnd()

        self.font.render_text("THR", x - 0.016, y - 0.05, scale=0.001)

    def _draw_crosshair(self):
        glBegin(GL_LINES)
        glVertex2f(-0.01, 0.0)
        glVertex2f(0.01, 0.0)
        glVertex2f(0.0, -0.01)
        glVertex2f(0.0, 0.01)
        glEnd()

        glBegin(GL_LINE_LOOP)
        r = 0.015
        for i in range(24):
            a = 2.0 * np.pi * i / 24
            glVertex2f(r * np.cos(a), r * np.sin(a))
        glEnd()

    def _draw_weapon_status(self, state, weapons):
        if not weapons:
            return

        y = 0.7
        x = -self.aspect + 0.12

        status = f"GUN: {'RDY' if weapons.get('gun_ready', False) else '--'}"
        self.font.render_text(status, x, y, scale=0.001)

        misl = f"MISL: {weapons.get('missiles', 0)}"
        self.font.render_text(misl, x, y - 0.035, scale=0.001)

        spd = f"SPD: {state['speed']:.0f}"
        self.font.render_text(spd, x, y - 0.07, scale=0.001)

    def _draw_stall_warning(self, state):
        if state.get('stalled', False):
            glColor3f(1.0, 0.0, 0.0)
            self.font.render_text("STALL", -0.04, 0.3, scale=0.002)
            glColor3f(0.0, 1.0, 0.0)
