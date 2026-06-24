from OpenGL.GL import *
from OpenGL.GLU import *
import numpy as np
from numpy import sin, cos, pi, tan
from numpy.linalg import norm

TERRAIN_SIZE = 5000.0
TERRAIN_SEGMENTS = 120
TERRAIN_HEIGHT = 80.0


class Terrain:
    def __init__(self):
        self.vertices = None
        self.normals = None
        self.colors = None
        self.indices = None
        self._generate()

    def _height(self, x, z):
        h = 0.0
        h += sin(x * 0.0008) * 60.0
        h += sin(z * 0.0006) * 50.0
        h += sin((x + z) * 0.0004) * 40.0
        h += sin(x * 0.0015) * sin(z * 0.0018) * 30.0
        h += sin(x * 0.003 + z * 0.002) * 15.0
        h += sin(x * 0.0001) * 100.0 * sin(z * 0.00015) * 80.0
        h = max(h, 0.0)
        return h

    def _generate(self):
        n = TERRAIN_SEGMENTS
        half = TERRAIN_SIZE / 2.0
        step = TERRAIN_SIZE / n

        verts = []
        for iz in range(n + 1):
            z = -half + iz * step
            for ix in range(n + 1):
                x = -half + ix * step
                y = self._height(x, z)
                verts.append((x, y, z))

        self.vertices = np.array(verts, dtype=np.float32)

        normals = np.zeros((len(verts), 3), dtype=np.float32)
        for iz in range(n):
            for ix in range(n):
                i0 = iz * (n + 1) + ix
                i1 = iz * (n + 1) + ix + 1
                i2 = (iz + 1) * (n + 1) + ix
                i3 = (iz + 1) * (n + 1) + ix + 1

                for tri in [(i0, i1, i2), (i1, i3, i2)]:
                    v0, v1, v2 = self.vertices[tri[0]], self.vertices[tri[1]], self.vertices[tri[2]]
                    e1 = v1 - v0
                    e2 = v2 - v0
                    normal_vec = np.cross(e1, e2)
                    nl = norm(normal_vec)
                    if nl > 0:
                        normal_vec /= nl
                        for idx in tri:
                            normals[idx] += normal_vec

        for i in range(len(normals)):
            nl = norm(normals[i])
            if nl > 0:
                normals[i] /= nl
        self.normals = normals

        colors = np.zeros((len(verts), 3), dtype=np.float32)
        for i, (x, y, z) in enumerate(verts):
            if y < 5.0:
                colors[i] = [0.2, 0.5, 0.15]
            elif y < 20.0:
                t = (y - 5.0) / 15.0
                colors[i] = [0.2 + t * 0.3, 0.5 - t * 0.15, 0.15 + t * 0.05]
            elif y < 60.0:
                t = (y - 20.0) / 40.0
                colors[i] = [0.5 + t * 0.2, 0.35 - t * 0.15, 0.2 + t * 0.1]
            else:
                colors[i] = [0.7, 0.2, 0.3]
            if y > 100.0:
                t = min((y - 100.0) / 30.0, 1.0)
                colors[i] = colors[i] * (1 - t) + np.array([0.95, 0.95, 0.98]) * t
        self.colors = colors

        indices = []
        for iz in range(n):
            for ix in range(n):
                i0 = iz * (n + 1) + ix
                i1 = iz * (n + 1) + ix + 1
                i2 = (iz + 1) * (n + 1) + ix
                i3 = (iz + 1) * (n + 1) + ix + 1
                indices.extend([i0, i1, i2, i1, i3, i2])
        self.indices = np.array(indices, dtype=np.uint32)

    def render(self):
        glEnableClientState(GL_VERTEX_ARRAY)
        glEnableClientState(GL_NORMAL_ARRAY)
        glEnableClientState(GL_COLOR_ARRAY)

        glVertexPointer(3, GL_FLOAT, 0, self.vertices)
        glNormalPointer(GL_FLOAT, 0, self.normals)
        glColorPointer(3, GL_FLOAT, 0, self.colors)

        glDrawElements(GL_TRIANGLES, len(self.indices), GL_UNSIGNED_INT, self.indices)

        glDisableClientState(GL_VERTEX_ARRAY)
        glDisableClientState(GL_NORMAL_ARRAY)
        glDisableClientState(GL_COLOR_ARRAY)


class AircraftModel:
    def __init__(self):
        self.vbo_data = None
        self._build()

    def _build(self):
        verts = []

        def add_triangle(v0, v1, v2, color):
            n = np.cross(np.array(v1) - np.array(v0), np.array(v2) - np.array(v0))
            nl = norm(n)
            if nl > 0:
                n = n / nl
            else:
                n = np.array([0.0, 1.0, 0.0])
            nl = n.tolist()
            verts.append(list(v0) + nl + color)
            verts.append(list(v1) + nl + color)
            verts.append(list(v2) + nl + color)

        def add_quad(v0, v1, v2, v3, color):
            add_triangle(v0, v1, v2, color)
            add_triangle(v0, v2, v3, color)

        lg = [0.45, 0.48, 0.50]
        dk = [0.25, 0.28, 0.30]
        ck = [0.3, 0.32, 0.35]

        nf = 12.0
        nose = (8.0, 0.0, 0.0)
        top = (6.5, 1.2, 0.0)
        bottom = (6.5, -0.8, 0.0)
        left = (6.5, 0.0, -1.0)
        right = (6.5, 0.0, 1.0)

        fwd_top = (0.0, 0.8, 0.0)
        fwd_left = (0.0, 0.0, -0.9)
        fwd_right = (0.0, 0.0, 0.9)
        fwd_bottom = (0.0, -0.7, 0.0)

        aft_top = (-5.0, 0.6, 0.0)
        aft_left = (-5.0, 0.0, -0.7)
        aft_right = (-5.0, 0.0, 0.7)
        aft_bottom = (-5.0, -0.5, 0.0)

        tail_top = (-8.0, 1.4, 0.0)
        tail_bot = (-8.0, -0.4, 0.0)

        add_triangle(nose, top, left, lg)
        add_triangle(nose, top, right, lg)
        add_triangle(nose, bottom, left, lg)
        add_triangle(nose, bottom, right, lg)

        add_quad(top, fwd_top, fwd_left, left, lg)
        add_quad(top, fwd_top, fwd_right, right, lg)
        add_quad(bottom, fwd_bottom, fwd_left, left, lg)
        add_quad(bottom, fwd_bottom, fwd_right, right, lg)

        add_quad(fwd_top, aft_top, aft_left, fwd_left, lg)
        add_quad(fwd_top, aft_top, aft_right, fwd_right, lg)
        add_quad(fwd_bottom, aft_bottom, aft_left, fwd_left, lg)
        add_quad(fwd_bottom, aft_bottom, aft_right, fwd_right, lg)

        add_quad(fwd_top, aft_top, aft_bottom, fwd_bottom, lg)
        add_triangle(aft_top, tail_top, aft_left, lg)
        add_triangle(aft_top, tail_top, aft_right, lg)
        add_triangle(tail_bot, aft_bottom, aft_left, lg)
        add_triangle(tail_bot, aft_bottom, aft_right, lg)
        add_triangle(aft_top, tail_top, tail_bot, lg)

        wx1, wz1, wx2, wz2 = 2.0, 6.5, -2.0, 7.0
        wing_top = (1.0, +0.15, 0.0)
        wing_bot = (1.0, -0.15, 0.0)

        lw1 = (wx1, 0.0, -wz1)
        lw2 = (wx2, 0.0, -wz2)
        rw1 = (wx1, 0.0, wz1)
        rw2 = (wx2, 0.0, wz2)

        add_quad(wing_top, wing_bot, lw2, lw1, dk)
        add_triangle(wing_top, lw1, (wx1, -0.15, -wz1), dk)
        add_triangle(wing_bot, (wx1, -0.15, -wz1), lw1, dk)
        lw1b = (wx1, -0.15, -wz1)

        add_quad(wing_top, wing_bot, rw2, rw1, dk)
        add_triangle(wing_top, rw1, (wx1, -0.15, wz1), dk)
        add_triangle(wing_bot, (wx1, -0.15, wz1), rw1, dk)

        ht_x1, ht_z1, ht_x2, ht_z2 = -6.5, 2.2, -7.8, 2.8
        ht_top = (-6.5, 0.15, 0.0)
        ht_bot = (-6.5, -0.15, 0.0)

        lht1 = (ht_x1, 0.0, -ht_z1)
        lht2 = (ht_x2, 0.0, -ht_z2)
        rht1 = (ht_x1, 0.0, ht_z1)
        rht2 = (ht_x2, 0.0, ht_z2)

        add_quad(ht_top, ht_bot, lht2, lht1, dk)
        add_quad(ht_top, ht_bot, rht2, rht1, dk)

        vfwd = (-7.5, 0.6, 0.0)
        vaft = (-8.5, 0.0, 0.0)
        vtip = (-8.0, 2.0, 0.0)
        add_triangle(vfwd, vtip, vaft, dk)

        canopy_verts = [
            (4.0, 0.8, 0.4), (4.0, 1.0, 0.0), (4.0, 0.8, -0.4),
            (2.0, 0.8, 0.4), (2.0, 1.1, 0.0), (2.0, 0.8, -0.4),
        ]
        canopy = [0.2, 0.35, 0.55]
        add_quad(canopy_verts[0], canopy_verts[1], canopy_verts[4], canopy_verts[3], canopy)
        add_quad(canopy_verts[1], canopy_verts[2], canopy_verts[5], canopy_verts[4], canopy)
        add_triangle(canopy_verts[0], canopy_verts[3], canopy_verts[4], canopy)
        add_triangle(canopy_verts[0], canopy_verts[4], canopy_verts[1], canopy)
        add_triangle(canopy_verts[1], canopy_verts[4], canopy_verts[5], canopy)
        add_triangle(canopy_verts[1], canopy_verts[5], canopy_verts[2], canopy)

        self.vertices = np.array(verts, dtype=np.float32)

    def render(self):
        glEnableClientState(GL_VERTEX_ARRAY)
        glEnableClientState(GL_NORMAL_ARRAY)
        glEnableClientState(GL_COLOR_ARRAY)

        stride = 9 * 4
        glVertexPointer(3, GL_FLOAT, stride, self.vertices)
        glNormalPointer(GL_FLOAT, stride, self.vertices[3:])
        glColorPointer(3, GL_FLOAT, stride, self.vertices[6:])

        count = len(self.vertices) // 9
        glDrawArrays(GL_TRIANGLES, 0, count)

        glDisableClientState(GL_VERTEX_ARRAY)
        glDisableClientState(GL_NORMAL_ARRAY)
        glDisableClientState(GL_COLOR_ARRAY)


class SkyRenderer:
    def render(self, sun_dir=None):
        glPushAttrib(GL_ENABLE_BIT | GL_DEPTH_BUFFER_BIT)
        glDepthMask(GL_FALSE)
        glDisable(GL_DEPTH_TEST)
        glDisable(GL_LIGHTING)

        glMatrixMode(GL_PROJECTION)
        glPushMatrix()
        glLoadIdentity()
        glMatrixMode(GL_MODELVIEW)
        glPushMatrix()
        glLoadIdentity()

        top = np.array([0.05, 0.1, 0.25])
        mid = np.array([0.2, 0.4, 0.7])
        low = np.array([0.5, 0.7, 0.9])
        fog = np.array([0.7, 0.75, 0.8])

        glBegin(GL_TRIANGLE_FAN)
        glColor3f(*top)
        glVertex3f(0.0, 1.0, -1.0)
        glColor3f(*mid)
        for i in range(17):
            a = -pi / 2 + pi * i / 16
            glVertex3f(sin(a) * 2.0, cos(a) * 0.6, -1.0)
        glEnd()

        glBegin(GL_TRIANGLE_FAN)
        glColor3f(*mid)
        glVertex3f(0.0, 0.6, -1.0)
        glColor3f(*low)
        for i in range(17):
            a = -pi / 2 + pi * i / 16
            glVertex3f(sin(a) * 2.0, cos(a) * (-0.4), -1.0)
        glEnd()

        glBegin(GL_TRIANGLE_FAN)
        glColor3f(*low)
        glVertex3f(0.0, -0.4, -1.0)
        glColor3f(*fog)
        for i in range(17):
            a = -pi / 2 + pi * i / 16
            glVertex3f(sin(a) * 2.0, cos(a) * (-1.0), -1.0)
        glEnd()

        glPopMatrix()
        glMatrixMode(GL_PROJECTION)
        glPopMatrix()
        glMatrixMode(GL_MODELVIEW)

        glPopAttrib()
        glDepthMask(GL_TRUE)
        glEnable(GL_DEPTH_TEST)


class Runway:
    def __init__(self):
        pass

    def render(self):
        glDisable(GL_LIGHTING)
        glBegin(GL_QUADS)
        glColor3f(0.15, 0.15, 0.15)
        glVertex3f(-20.0, 0.5, -1000.0)
        glVertex3f(20.0, 0.5, -1000.0)
        glVertex3f(20.0, 0.5, 1000.0)
        glVertex3f(-20.0, 0.5, 1000.0)
        glEnd()

        glBegin(GL_QUADS)
        glColor3f(1.0, 1.0, 1.0)
        for z in range(-900, 1000, 100):
            w = 1.0
            glVertex3f(-w, 0.6, z - 15)
            glVertex3f(w, 0.6, z - 15)
            glVertex3f(w, 0.6, z + 15)
            glVertex3f(-w, 0.6, z + 15)
        glEnd()
        glEnable(GL_LIGHTING)
