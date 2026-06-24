#!/usr/bin/env python3
import sys
import os
import numpy as np
import glfw
from OpenGL.GL import *
from OpenGL.GLU import *

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from physics import G
from entities import Aircraft
from renderer import Terrain, AircraftModel, SkyRenderer, Runway
from hud import HUD

WINDOW_WIDTH = 1280
WINDOW_HEIGHT = 720
FIXED_DT = 1.0 / 120.0
MAX_PHYSICS_STEPS = 5
VIEW_DISTANCE = 4000.0


class Game:
    def __init__(self, aircraft_type="F-16C"):
        self.keys = set()
        self.mouse_look = False
        self.look_pitch = 0.0
        self.look_yaw = 0.0
        self.last_mx = 0.0
        self.last_my = 0.0
        self.view_mode = 'cockpit'

        self.controls = {
            'throttle': 0.5,
            'pitch': 0.0,
            'roll': 0.0,
            'yaw': 0.0,
        }

        self.aircraft_type = aircraft_type
        self._create_player()

    def _create_player(self):
        from entities import AIRCRAFT_PRESETS
        preset = AIRCRAFT_PRESETS.get(self.aircraft_type, AIRCRAFT_PRESETS['F-16C'])

        self.player = Aircraft(self.aircraft_type, start_pos=[0.0, 200.0, 0.0])
        from physics import Quaternion
        self.player.physics.body.orientation = Quaternion.from_euler(0.0, 0.0, -np.pi/2)
        self.player.physics.body.velocity = np.array([0.0, 0.0, -200.0], dtype=np.float64)

        self.terrain = Terrain()
        self.aircraft_model = AircraftModel()
        self.sky = SkyRenderer()
        self.runway = Runway()
        self.hud = HUD(WINDOW_WIDTH, WINDOW_HEIGHT)

        self.window = None

    def get_target_position(self):
        pos = self.player.get_position()
        fwd = self.player.physics.body.get_forward()
        return pos + fwd * 500.0

    def respawn_player(self, switch_type=None):
        if switch_type:
            self.aircraft_type = switch_type
        self._create_player()
        self.player.missile_count = 4
        self.player.projectiles.clear()
        self.player.missiles.clear()
        self.player.alive = True

    def key_callback(self, window, key, scancode, action, mods):
        key_map = {
            glfw.KEY_W: 'W', glfw.KEY_S: 'S', glfw.KEY_A: 'A', glfw.KEY_D: 'D',
            glfw.KEY_Q: 'Q', glfw.KEY_E: 'E',
            glfw.KEY_LEFT_SHIFT: 'LSHIFT', glfw.KEY_RIGHT_SHIFT: 'RSHIFT',
            glfw.KEY_LEFT_CONTROL: 'LCTRL', glfw.KEY_RIGHT_CONTROL: 'RCTRL',
            glfw.KEY_LEFT: 'LEFT', glfw.KEY_RIGHT: 'RIGHT',
            glfw.KEY_UP: 'UP', glfw.KEY_DOWN: 'DOWN',
            glfw.KEY_HOME: 'HOME', glfw.KEY_END: 'END',
            glfw.KEY_SPACE: 'SPACE',
            glfw.KEY_M: 'M', glfw.KEY_R: 'R', glfw.KEY_C: 'C',
            glfw.KEY_1: '1', glfw.KEY_2: '2',
        }

        if key in key_map:
            k = key_map[key]
            if action == glfw.PRESS:
                if k == 'SPACE':
                    self.player.fire_gun()
                elif k == 'M':
                    self.player.fire_missile(self.get_target_position)
                elif k == 'R':
                    self.respawn_player()
                elif k == 'C':
                    self.view_mode = 'external' if self.view_mode == 'cockpit' else 'cockpit'
                elif k == '1':
                    self.respawn_player('F-16C')
                elif k == '2':
                    self.respawn_player('J-22M1A')
                else:
                    self.keys.add(k)
            elif action == glfw.RELEASE:
                self.keys.discard(k)

        if key == glfw.KEY_ESCAPE and action == glfw.PRESS:
            glfw.set_window_should_close(window, True)

    def mouse_button_callback(self, window, button, action, mods):
        if button == glfw.MOUSE_BUTTON_RIGHT:
            if action == glfw.PRESS:
                self.mouse_look = True
                self.last_mx, self.last_my = glfw.get_cursor_pos(window)
            elif action == glfw.RELEASE:
                self.mouse_look = False

    def cursor_pos_callback(self, window, x, y):
        if self.mouse_look:
            dx = x - self.last_mx
            dy = y - self.last_my
            self.look_yaw += dx * 0.002
            self.look_pitch += dy * 0.002
            self.look_pitch = np.clip(self.look_pitch, -np.pi / 2.5, np.pi / 2.5)
            self.last_mx, self.last_my = x, y

    def scroll_callback(self, window, x_offset, y_offset):
        self.controls['throttle'] = np.clip(
            self.controls['throttle'] + y_offset * 0.05, 0.0, 1.0
        )

    def resize_callback(self, window, w, h):
        global WINDOW_WIDTH, WINDOW_HEIGHT
        WINDOW_WIDTH = w
        WINDOW_HEIGHT = h
        glViewport(0, 0, w, h)
        self.hud.resize(w, h)

    def process_keys(self, dt):
        pitch_speed = 1.5
        roll_speed = 2.5
        yaw_speed = 1.0
        thr_speed = 0.5

        self.controls['pitch'] = 0.0
        self.controls['roll'] = 0.0
        self.controls['yaw'] = 0.0

        if 'W' in self.keys or 'UP' in self.keys:
            self.controls['pitch'] = -pitch_speed
        if 'S' in self.keys or 'DOWN' in self.keys:
            self.controls['pitch'] = pitch_speed
        if 'A' in self.keys or 'LEFT' in self.keys:
            self.controls['roll'] = -roll_speed
        if 'D' in self.keys or 'RIGHT' in self.keys:
            self.controls['roll'] = roll_speed
        if 'Q' in self.keys:
            self.controls['yaw'] = -yaw_speed
        if 'E' in self.keys:
            self.controls['yaw'] = yaw_speed

        if 'LSHIFT' in self.keys:
            self.controls['throttle'] = min(self.controls['throttle'] + thr_speed * dt * 2.0, 1.0)
        if 'LCTRL' in self.keys:
            self.controls['throttle'] = max(self.controls['throttle'] - thr_speed * dt * 2.0, 0.0)

        if 'HOME' in self.keys:
            self.controls['throttle'] = 1.0
        if 'END' in self.keys:
            self.controls['throttle'] = 0.0

    def render(self):
        state = self.player.get_state()
        wep_status = self.player.get_weapon_status()
        pos = state['position']
        orientation = state['orientation']

        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT)

        self.sky.render()

        glMatrixMode(GL_PROJECTION)
        glLoadIdentity()
        gluPerspective(75.0, WINDOW_WIDTH / WINDOW_HEIGHT, 1.0, VIEW_DISTANCE)

        glMatrixMode(GL_MODELVIEW)
        glLoadIdentity()

        if self.view_mode == 'cockpit':
            fwd = orientation.rotate(np.array([1.0, 0.0, 0.0]))
            up = orientation.rotate(np.array([0.0, 1.0, 0.0]))
            eye_offset = fwd * 2.0 + up * 1.5
            eye_pos = pos + eye_offset
            look_at = pos + fwd * 100.0
            gluLookAt(
                eye_pos[0], eye_pos[1], eye_pos[2],
                look_at[0], look_at[1], look_at[2],
                0.0, 1.0, 0.0
            )

            glRotatef(-np.degrees(self.look_pitch), 1.0, 0.0, 0.0)
            glRotatef(np.degrees(self.look_yaw), 0.0, 1.0, 0.0)
        else:
            fwd = orientation.rotate(np.array([1.0, 0.0, 0.0]))
            up = orientation.rotate(np.array([0.0, 1.0, 0.0]))
            chase = -fwd * 15.0 + up * 5.0
            eye_pos = pos + chase
            look_at = pos + fwd * 50.0
            gluLookAt(
                eye_pos[0], eye_pos[1], eye_pos[2],
                look_at[0], look_at[1], look_at[2],
                0.0, 1.0, 0.0
            )

        glLightfv(GL_LIGHT0, GL_POSITION, [1.0, 2.0, 1.0, 0.0])
        glLightfv(GL_LIGHT0, GL_AMBIENT, [0.3, 0.3, 0.3, 1.0])
        glLightfv(GL_LIGHT0, GL_DIFFUSE, [0.8, 0.8, 0.8, 1.0])

        glEnable(GL_LIGHTING)
        self.terrain.render()
        self.runway.render()

        glPushMatrix()
        glTranslatef(pos[0], pos[1], pos[2])
        m = orientation.to_matrix()
        glMultMatrixf(np.array([
            [m[0, 0], m[1, 0], m[2, 0], 0.0],
            [m[0, 1], m[1, 1], m[2, 1], 0.0],
            [m[0, 2], m[1, 2], m[2, 2], 0.0],
            [0.0, 0.0, 0.0, 1.0]
        ], dtype=np.float32).flatten())
        glScalef(0.5, 0.5, 0.5)
        self.aircraft_model.render()
        glPopMatrix()

        for p in self.player.projectiles:
            if p.alive:
                glPushMatrix()
                glTranslatef(p.position[0], p.position[1], p.position[2])
                glDisable(GL_LIGHTING)
                glColor3f(1.0, 0.6, 0.0)
                glBegin(GL_LINES)
                glVertex3f(0.0, 0.0, 0.0)
                vel_dir = p.velocity / max(np.linalg.norm(p.velocity), 0.01)
                glVertex3f(vel_dir[0] * 5.0, vel_dir[1] * 5.0, vel_dir[2] * 5.0)
                glEnd()
                glEnable(GL_LIGHTING)
                glPopMatrix()

        for m in self.player.missiles:
            if m.alive:
                glPushMatrix()
                glTranslatef(m.position[0], m.position[1], m.position[2])
                glDisable(GL_LIGHTING)
                glColor3f(1.0, 0.2, 0.2)
                fwd = m.orientation.rotate(np.array([1.0, 0.0, 0.0])) if m.orientation else np.array([1.0, 0.0, 0.0])
                glBegin(GL_LINES)
                glVertex3f(-fwd[0] * 2.0, -fwd[1] * 2.0, -fwd[2] * 2.0)
                glVertex3f(fwd[0] * 2.0, fwd[1] * 2.0, fwd[2] * 2.0)
                glEnd()
                glColor3f(1.0, 1.0, 1.0)
                glPointSize(3.0)
                glBegin(GL_POINTS)
                glVertex3f(0.0, 0.0, 0.0)
                glEnd()
                glEnable(GL_LIGHTING)
                glPopMatrix()

        self.hud.render(state, wep_status)

        glfw.swap_buffers(self.window)

    def run(self):
        if not glfw.init():
            print("Failed to init GLFW")
            return

        glfw.window_hint(glfw.CONTEXT_VERSION_MAJOR, 2)
        glfw.window_hint(glfw.CONTEXT_VERSION_MINOR, 1)
        glfw.window_hint(glfw.SAMPLES, 4)

        self.window = glfw.create_window(
            WINDOW_WIDTH, WINDOW_HEIGHT,
            "Combat Flight Simulator", None, None
        )
        if not self.window:
            glfw.terminate()
            return

        glfw.make_context_current(self.window)
        glfw.swap_interval(1)

        glfw.set_key_callback(self.window, self.key_callback)
        glfw.set_mouse_button_callback(self.window, self.mouse_button_callback)
        glfw.set_cursor_pos_callback(self.window, self.cursor_pos_callback)
        glfw.set_scroll_callback(self.window, self.scroll_callback)
        glfw.set_window_size_callback(self.window, self.resize_callback)

        glClearColor(0.4, 0.6, 0.9, 1.0)
        glEnable(GL_DEPTH_TEST)
        glEnable(GL_LIGHTING)
        glEnable(GL_LIGHT0)
        glEnable(GL_COLOR_MATERIAL)
        glColorMaterial(GL_FRONT_AND_BACK, GL_AMBIENT_AND_DIFFUSE)
        glLightModeli(GL_LIGHT_MODEL_TWO_SIDE, GL_TRUE)
        glEnable(GL_NORMALIZE)

        glFogi(GL_FOG_MODE, GL_LINEAR)
        glFogf(GL_FOG_START, VIEW_DISTANCE * 0.5)
        glFogf(GL_FOG_END, VIEW_DISTANCE)
        glFogfv(GL_FOG_COLOR, [0.4, 0.6, 0.9, 1.0])
        glEnable(GL_FOG)

        accumulator = 0.0
        running = True
        frame_time = 0.016
        fps_counter = 0
        fps_time = 0.0

        while running:
            glfw.poll_events()
            running = not glfw.window_should_close(self.window)

            self.process_keys(frame_time)

            accumulator += frame_time
            accumulator = min(accumulator, FIXED_DT * MAX_PHYSICS_STEPS)

            while accumulator >= FIXED_DT:
                self.player.update(FIXED_DT, self.controls)
                accumulator -= FIXED_DT

            self.render()

            fps_counter += 1
            fps_time += frame_time
            if fps_time >= 1.0:
                ac_name = self.aircraft_type
                glfw.set_window_title(
                    self.window,
                    f"Combat Flight Sim [{ac_name}] - {fps_counter} FPS | {self.controls['throttle'] * 100:.0f}% THR"
                )
                fps_counter = 0
                fps_time = 0.0

            ft = glfw.get_time()
            glfw.set_time(0.0)
            if 0.001 < ft < 0.1:
                frame_time = ft

        glfw.terminate()


if __name__ == '__main__':
    game = Game()
    game.run()
