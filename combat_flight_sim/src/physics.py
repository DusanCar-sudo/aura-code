import numpy as np
from numpy import cross, dot
from numpy.linalg import norm

G = 9.81
R_SPECIFIC = 287.058
GAMMA = 1.4
T_SEA_LEVEL = 288.15
P_SEA_LEVEL = 101325.0
RHO_SEA_LEVEL = 1.225
LAPSE_RATE = 0.0065


class Atmosphere:
    @staticmethod
    def get_state(altitude):
        h = max(altitude, 0.0)

        if h < 11000.0:
            T = T_SEA_LEVEL - LAPSE_RATE * h
            P = P_SEA_LEVEL * (T / T_SEA_LEVEL) ** (G / (LAPSE_RATE * R_SPECIFIC))
        else:
            T = 216.65
            P = P_SEA_LEVEL * (216.65 / T_SEA_LEVEL) ** (G / (LAPSE_RATE * R_SPECIFIC)) * \
                np.exp(-G * (h - 11000.0) / (R_SPECIFIC * T))

        rho = P / (R_SPECIFIC * T)
        sos = np.sqrt(GAMMA * R_SPECIFIC * T)
        return T, P, rho, sos


class Quaternion:
    def __init__(self, w=1.0, x=0.0, y=0.0, z=0.0):
        self.w = w
        self.x = x
        self.y = y
        self.z = z

    def __mul__(self, other):
        if isinstance(other, Quaternion):
            return Quaternion(
                self.w * other.w - self.x * other.x - self.y * other.y - self.z * other.z,
                self.w * other.x + self.x * other.w + self.y * other.z - self.z * other.y,
                self.w * other.y - self.x * other.z + self.y * other.w + self.z * other.x,
                self.w * other.z + self.x * other.y - self.y * other.x + self.z * other.w
            )
        if isinstance(other, (int, float)):
            return Quaternion(self.w * other, self.x * other, self.y * other, self.z * other)
        return NotImplemented

    def __rmul__(self, other):
        if isinstance(other, (int, float)):
            return Quaternion(self.w * other, self.x * other, self.y * other, self.z * other)
        return NotImplemented

    def conj(self):
        return Quaternion(self.w, -self.x, -self.y, -self.z)

    def normalize(self):
        mag = np.sqrt(self.w ** 2 + self.x ** 2 + self.y ** 2 + self.z ** 2)
        if mag > 0:
            self.w /= mag
            self.x /= mag
            self.y /= mag
            self.z /= mag
        return self

    def rotate(self, v):
        vq = Quaternion(0.0, v[0], v[1], v[2])
        res = self * vq * self.conj()
        return np.array([res.x, res.y, res.z])

    def to_euler(self):
        sinr_cosp = 2.0 * (self.w * self.x + self.y * self.z)
        cosr_cosp = 1.0 - 2.0 * (self.x ** 2 + self.y ** 2)
        roll = np.arctan2(sinr_cosp, cosr_cosp)

        sinp = 2.0 * (self.w * self.y - self.z * self.x)
        if abs(sinp) >= 1.0:
            pitch = np.pi / 2.0 * np.sign(sinp)
        else:
            pitch = np.arcsin(sinp)

        siny_cosp = 2.0 * (self.w * self.z + self.x * self.y)
        cosy_cosp = 1.0 - 2.0 * (self.y ** 2 + self.z ** 2)
        yaw = np.arctan2(siny_cosp, cosy_cosp)

        return roll, pitch, yaw

    def to_matrix(self):
        xx, yy, zz = self.x ** 2, self.y ** 2, self.z ** 2
        xy, xz, yz = self.x * self.y, self.x * self.z, self.y * self.z
        wx, wy, wz = self.w * self.x, self.w * self.y, self.w * self.z
        return np.array([
            [1.0 - 2.0 * (yy + zz), 2.0 * (xy - wz), 2.0 * (xz + wy)],
            [2.0 * (xy + wz), 1.0 - 2.0 * (xx + zz), 2.0 * (yz - wx)],
            [2.0 * (xz - wy), 2.0 * (yz + wx), 1.0 - 2.0 * (xx + yy)]
        ])

    @staticmethod
    def from_euler(roll, pitch, yaw):
        cr, cp, cy = np.cos(roll / 2.0), np.cos(pitch / 2.0), np.cos(yaw / 2.0)
        sr, sp, sy = np.sin(roll / 2.0), np.sin(pitch / 2.0), np.sin(yaw / 2.0)
        return Quaternion(
            cr * cp * cy + sr * sp * sy,
            sr * cp * cy - cr * sp * sy,
            cr * sp * cy + sr * cp * sy,
            cr * cp * sy - sr * sp * cy
        ).normalize()

    @staticmethod
    def from_axis_angle(axis, angle):
        half = angle / 2.0
        s = np.sin(half)
        return Quaternion(np.cos(half), axis[0] * s, axis[1] * s, axis[2] * s).normalize()


class RigidBody:
    def __init__(self, mass=12000.0, inertia=None):
        self.mass = mass
        self.inertia = np.diag([35000.0, 200000.0, 250000.0]) if inertia is None else inertia
        self.inv_inertia = np.linalg.inv(self.inertia)

        self.position = np.array([0.0, 500.0, 0.0], dtype=np.float64)
        self.velocity = np.array([150.0, 0.0, 0.0], dtype=np.float64)
        self.orientation = Quaternion()
        self.angular_velocity = np.zeros(3, dtype=np.float64)

        self.total_force = np.zeros(3, dtype=np.float64)
        self.total_torque = np.zeros(3, dtype=np.float64)

    def reset(self):
        self.position = np.array([0.0, 500.0, 0.0], dtype=np.float64)
        self.velocity = np.array([150.0, 0.0, 0.0], dtype=np.float64)
        self.orientation = Quaternion()
        self.angular_velocity = np.zeros(3, dtype=np.float64)

    def apply_force(self, force, torque=np.zeros(3)):
        self.total_force += force
        self.total_torque += torque

    def derivatives(self, state):
        pos = state[0:3]
        vel = state[3:6]
        q_w, q_x, q_y, q_z = state[6:10]
        angvel = state[10:13]
        q = Quaternion(q_w, q_x, q_y, q_z)
        inertia = self.inertia
        inv_inertia = self.inv_inertia

        dpos = vel

        accel = self.total_force / self.mass
        dvel = accel

        w = angvel
        dq = 0.5 * Quaternion(0.0, w[0], w[1], w[2]) * q

        torque = self.total_torque.copy()
        dangvel = inv_inertia @ (torque - cross(w, inertia @ w))

        self.total_force.fill(0.0)
        self.total_torque.fill(0.0)

        return np.concatenate([dpos, dvel, [dq.w, dq.x, dq.y, dq.z], dangvel])

    def integrate(self, dt):
        def f(s):
            old_force = self.total_force.copy()
            old_torque = self.total_torque.copy()
            result = self.derivatives(s)
            self.total_force = old_force
            self.total_torque = old_torque
            return result

        s = np.concatenate([
            self.position,
            self.velocity,
            [self.orientation.w, self.orientation.x, self.orientation.y, self.orientation.z],
            self.angular_velocity
        ])

        k1 = f(s)
        k2 = f(s + 0.5 * dt * k1)
        k3 = f(s + 0.5 * dt * k2)
        k4 = f(s + dt * k3)
        s_new = s + (dt / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4)

        self.position = s_new[0:3]
        self.velocity = s_new[3:6]

        q = Quaternion(s_new[6], s_new[7], s_new[8], s_new[9])
        q.normalize()
        self.orientation = q

        self.angular_velocity = s_new[10:13]

    def get_forward(self):
        return self.orientation.rotate(np.array([1.0, 0.0, 0.0], dtype=np.float64))

    def get_up(self):
        return self.orientation.rotate(np.array([0.0, 1.0, 0.0], dtype=np.float64))

    def get_right(self):
        return self.orientation.rotate(np.array([0.0, 0.0, 1.0], dtype=np.float64))

    def airspeed(self, wind=np.zeros(3)):
        rel_vel = self.velocity - wind
        return norm(rel_vel)

    def angle_of_attack(self, wind=np.zeros(3)):
        rel_vel = self.velocity - wind
        forward = self.get_forward()
        v_body = self.orientation.conj().rotate(rel_vel)
        if norm(v_body) < 0.1:
            return 0.0
        return np.arctan2(-v_body[2], v_body[0])

    def sideslip(self, wind=np.zeros(3)):
        rel_vel = self.velocity - wind
        v_body = self.orientation.conj().rotate(rel_vel)
        if norm(v_body) < 0.1:
            return 0.0
        return np.arcsin(v_body[1] / norm(v_body))


class AircraftPhysics:
    def __init__(self, mass=12000.0, wing_area=28.0, span=9.96, max_thrust=80000.0):
        self.body = RigidBody(mass=mass)
        self.wing_area = wing_area
        self.span = span
        self.max_thrust = max_thrust

        self.throttle = 0.0
        self.elevator = 0.0
        self.aileron = 0.0
        self.rudder = 0.0

        self.flap_setting = 0.0
        self.gear_down = False

        self.aoa = 0.0
        self.mach = 0.0
        self.ias = 0.0

        self.stalled = False

    def compute_forces(self, dt):
        body = self.body
        T, P, rho, sos = Atmosphere.get_state(body.position[1])

        speed = norm(body.velocity)
        if speed > 0.1:
            self.mach = speed / sos
        else:
            self.mach = 0.0

        fwd = body.get_forward()
        up = body.get_up()
        right = body.get_right()

        self.aoa = body.angle_of_attack()
        beta = body.sideslip()

        qbar = 0.5 * rho * speed ** 2

        self.ias = speed * np.sqrt(rho / RHO_SEA_LEVEL)
        if self.ias < 5.0 and body.position[1] > 0.0:
            self.ias = 5.0

        aoa_deg = np.degrees(self.aoa)

        CL = 0.35 + aoa_deg * 0.085
        cl_max = 1.5 - 0.3 * self.flap_setting
        aoa_stall_deg = (cl_max - 0.35) / 0.085 if 0.085 > 0 else 15.0
        if aoa_deg > aoa_stall_deg:
            CL = cl_max - 0.08 * (aoa_deg - aoa_stall_deg)
            self.stalled = True
        elif aoa_deg < -5.0:
            CL = 0.35 + aoa_deg * 0.035
            self.stalled = False
        else:
            self.stalled = False
        CL = np.clip(CL, -1.2, 1.6)

        ar = self.span ** 2 / self.wing_area
        e = 0.8
        CD = 0.022 + 0.02 * self.flap_setting + 0.005 * self.gear_down
        CD += CL ** 2 / (np.pi * ar * e)
        if self.mach > 0.8:
            CD += 0.02 * (self.mach - 0.8) ** 2

        if speed > 5.0:
            lift_dir = cross(cross(body.velocity, right), body.velocity)
            ln = norm(lift_dir)
            if ln > 0.001:
                lift_dir /= ln
            else:
                lift_dir = up.copy()
        else:
            lift_dir = up.copy()

        lift_mag = qbar * self.wing_area * CL
        drag_mag = qbar * self.wing_area * CD

        lift_force = lift_dir * lift_mag
        drag_vec = -(body.velocity / max(speed, 0.01)) * drag_mag

        weight_force = np.array([0.0, -self.body.mass * G, 0.0])

        thrust_force = fwd * (self.throttle * self.max_thrust)

        total_force = weight_force + thrust_force + lift_force + drag_vec

        cl_elev = -0.6 * self.elevator * qbar * self.wing_area * 1.5
        cl_ail = -0.4 * self.aileron * qbar * self.wing_area * 5.0
        cl_rud = 0.3 * self.rudder * qbar * self.wing_area * 5.0

        pitch_moment = np.array([0.0, 0.0, cl_elev])
        roll_moment = np.array([cl_ail, 0.0, 0.0])
        yaw_moment = np.array([0.0, 0.0, cl_rud])

        damping = -self.body.angular_velocity * qbar * self.wing_area * np.array([2.0, 8.0, 6.0]) * 0.01

        total_torque = pitch_moment + roll_moment + yaw_moment + damping

        body.total_force = total_force
        body.total_torque = total_torque

    def update(self, dt, throttle, elevator, aileron, rudder):
        self.throttle = np.clip(throttle, 0.0, 1.0)
        self.elevator = np.clip(elevator, -1.0, 1.0)
        self.aileron = np.clip(aileron, -1.0, 1.0)
        self.rudder = np.clip(rudder, -1.0, 1.0)

        self.compute_forces(dt)
        self.body.integrate(dt)

        if self.body.position[1] < 0.0:
            self.body.position[1] = 0.0
            if self.body.velocity[1] < 0.0:
                self.body.velocity[1] = max(self.body.velocity[1], 0.0)

        if np.any(np.isnan(self.body.position)):
            self.body.position = np.array([0.0, 500.0, 0.0])
            self.body.velocity = np.array([0.0, 0.0, -200.0])
            self.body.orientation = Quaternion.from_euler(0.0, 0.0, -np.pi/2)
        if np.any(np.isnan(self.body.velocity)):
            self.body.velocity = np.array([0.0, 0.0, -200.0])

    def get_state(self):
        return {
            'position': self.body.position.copy(),
            'velocity': self.body.velocity.copy(),
            'orientation': self.body.orientation,
            'angular_velocity': self.body.angular_velocity.copy(),
            'speed': norm(self.body.velocity),
            'aoa': self.aoa,
            'mach': self.mach,
            'ias': self.ias,
            'altitude': self.body.position[1],
            'throttle': self.throttle,
        }
