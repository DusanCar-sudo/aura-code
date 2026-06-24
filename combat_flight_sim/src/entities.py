import numpy as np
from numpy import cross, dot
from numpy.linalg import norm
from physics import RigidBody, Atmosphere, G, RHO_SEA_LEVEL


class GunProjectile:
    def __init__(self, pos, vel):
        self.position = pos.copy()
        self.velocity = vel.copy()
        self.alive = True
        self.life = 3.0
        self.drag_coeff = 0.3
        self.mass = 0.1
        self.area = 0.0001

    def update(self, dt):
        if not self.alive:
            return
        self.life -= dt
        if self.life <= 0 or self.position[1] < 0:
            self.alive = False
            return

        speed = norm(self.velocity)
        drag = 0.5 * RHO_SEA_LEVEL * speed ** 2 * self.area * self.drag_coeff
        drag_dir = -self.velocity / max(speed, 0.01)
        accel = np.array([0.0, -G, 0.0]) + drag_dir * drag / self.mass
        self.velocity += accel * dt
        self.position += self.velocity * dt


class Missile:
    def __init__(self, pos, vel, target_getter, seeker_type='IR'):
        self.position = pos.copy()
        self.velocity = vel.copy()
        self.target_getter = target_getter
        self.seeker_type = seeker_type

        self.alive = True
        self.life = 20.0
        self.burn_time = 5.0
        self.thrust = 15000.0
        self.mass = 85.0
        self.burn_mass = 50.0
        self.mass_initial = self.mass

        self.drag_coeff = 0.4
        self.area = 0.03
        self.wing_area = 0.15

        self.orientation = None
        self.angular_velocity = np.zeros(3)

        self.N = 4.0
        self.max_g = 25.0

        self.exhaust_vel = self.thrust / (self.burn_mass / self.burn_time) if self.burn_time > 0 else 2000.0

    def update(self, dt):
        if not self.alive:
            return

        self.life -= dt
        if self.life <= 0 or self.position[1] < 0:
            self.alive = False
            return

        speed = norm(self.velocity)

        target = self.target_getter()
        if target is None:
            self.alive = False
            return

        if self.orientation is None:
            if speed > 0.1:
                fwd = self.velocity / speed
                up = np.array([0.0, 1.0, 0.0])
                if abs(dot(fwd, up)) > 0.99:
                    up = np.array([1.0, 0.0, 0.0])
                right = cross(fwd, up)
                right /= norm(right)
                up = cross(right, fwd)
                rot = np.column_stack([fwd, up, right])
                from physics import Quaternion
                self.orientation = Quaternion()
                m = rot
                trace = m[0, 0] + m[1, 1] + m[2, 2]
                if trace > 0:
                    S = 2.0 * np.sqrt(trace + 1.0)
                    self.orientation.w = 0.25 * S
                    self.orientation.x = (m[2, 1] - m[1, 2]) / S
                    self.orientation.y = (m[0, 2] - m[2, 0]) / S
                    self.orientation.z = (m[1, 0] - m[0, 1]) / S
                self.orientation.normalize()

        from physics import Quaternion
        q = self.orientation or Quaternion()

        if self.burn_time > 0:
            thrust_mag = self.thrust
            self.burn_time -= dt
            mass_flow = self.burn_mass / 5.0
            self.mass -= mass_flow * dt
            if self.mass < 85.0 - self.burn_mass:
                self.mass = 85.0 - self.burn_mass
        else:
            thrust_mag = 0.0

        T, P, rho, sos = Atmosphere.get_state(self.position[1])
        qbar = 0.5 * rho * speed ** 2

        fwd = q.rotate(np.array([1.0, 0.0, 0.0]))

        to_target = target - self.position
        dist = norm(to_target)

        los = to_target / dist
        los_rate = cross(los, target - (self.position + self.velocity * dt)) if dt > 0 else np.zeros(3)

        closing_speed = -dot(self.velocity, los)

        accel_cmd = self.N * closing_speed * norm(los_rate)
        accel_dir = cross(los_rate, los)
        if norm(accel_dir) > 0:
            accel_dir /= norm(accel_dir)
        else:
            accel_dir = np.array([0.0, 1.0, 0.0])

        g_limit = self.max_g * G
        accel_mag = min(accel_cmd, g_limit)

        aero_lift = qbar * self.wing_area * 2.0
        total_lift = aero_lift + self.mass * accel_mag if aero_lift > 0 else self.mass * accel_mag

        if speed > 0.1:
            drag = 0.5 * rho * speed ** 2 * self.area * self.drag_coeff
        else:
            drag = 0.0

        seeker_fov = np.radians(45.0)
        angle_off = np.arccos(np.clip(dot(fwd, to_target / dist), -1.0, 1.0))

        if angle_off > seeker_fov:
            self.alive = False
            return

        force = fwd * thrust_mag + accel_dir * total_lift
        drag_force = -(self.velocity / max(speed, 0.01)) * drag
        total_force = force + drag_force + np.array([0.0, -self.mass * G, 0.0])

        accel = total_force / self.mass
        self.velocity += accel * dt
        self.position += self.velocity * dt

        if speed > 0.5:
            new_fwd = self.velocity / speed
            old_fwd = fwd
            rot_axis = cross(old_fwd, new_fwd)
            rot_angle = np.arccos(np.clip(dot(old_fwd, new_fwd), -1.0, 1.0))
            if norm(rot_axis) > 0.0001:
                rot_axis /= norm(rot_axis)
                dq = Quaternion.from_axis_angle(rot_axis, rot_angle * 0.95)
                self.orientation = dq * q
                self.orientation.normalize()

    def get_position(self):
        return self.position.copy()

    def is_alive(self):
        return self.alive


AIRCRAFT_PRESETS = {
    'F-16C': {
        'mass': 12000.0,
        'wing_area': 28.0,
        'span': 9.96,
        'max_thrust': 80000.0,
        'name': 'F-16C Fighting Falcon',
    },
    'J-22M1A': {
        'mass': 9300.0,
        'wing_area': 26.0,
        'span': 8.55,
        'max_thrust': 45000.0,
        'name': 'J-22M1A Orao (Serbian Eagle)',
    },
}


class Aircraft:
    def __init__(self, name="F-16C", start_pos=None):
        self.name = name
        preset = AIRCRAFT_PRESETS.get(name, AIRCRAFT_PRESETS['F-16C'])

        from physics import AircraftPhysics
        self.physics = AircraftPhysics(
            mass=preset['mass'],
            wing_area=preset['wing_area'],
            span=preset['span'],
            max_thrust=preset['max_thrust'],
        )

        if start_pos is not None:
            self.physics.body.position = np.array(start_pos, dtype=np.float64)
            self.physics.body.velocity = np.array([150.0, 0.0, 0.0], dtype=np.float64)

        self.projectiles = []
        self.missiles = []
        self.missile_count = 4

        self.gun_ready = True
        self.gun_cooldown = 0.0
        self.gun_fire_rate = 0.05
        self.gun_muzzle_vel = 1000.0

        self.alive = True

    def update(self, dt, controls):
        if not self.alive:
            return

        ctrl = controls
        self.physics.update(
            dt,
            throttle=ctrl.get('throttle', 0.0),
            elevator=ctrl.get('pitch', 0.0),
            aileron=ctrl.get('roll', 0.0),
            rudder=ctrl.get('yaw', 0.0)
        )

        self.gun_cooldown -= dt
        if self.gun_cooldown <= 0:
            self.gun_ready = True

        for p in self.projectiles[:]:
            p.update(dt)
            if not p.alive:
                self.projectiles.remove(p)

        for m in self.missiles[:]:
            m.update(dt)
            if not m.alive:
                self.missiles.remove(m)

    def fire_gun(self):
        if not self.gun_ready or not self.alive:
            return False

        pos = self.physics.body.position
        vel = self.physics.body.velocity
        fwd = self.physics.body.get_forward()
        up = self.physics.body.get_up()

        spread = 0.003
        for i in range(3):
            spray = np.random.randn(3) * spread
            proj_vel = vel + (fwd + spray) * self.gun_muzzle_vel
            proj_pos = pos + fwd * 8.0 + up * 0.3
            self.projectiles.append(GunProjectile(proj_pos, proj_vel))

        self.gun_ready = False
        self.gun_cooldown = self.gun_fire_rate
        return True

    def fire_missile(self, target_getter):
        if self.missile_count <= 0 or not self.alive:
            return False

        pos = self.physics.body.position
        vel = self.physics.body.velocity
        fwd = self.physics.body.get_forward()
        up = self.physics.body.get_up()

        mpos = pos + fwd * 8.0 + up * 0.5
        mvel = vel + fwd * 50.0

        self.missiles.append(Missile(mpos, mvel, target_getter, seeker_type='IR'))
        self.missile_count -= 1
        return True

    def get_state(self):
        state = self.physics.get_state()
        state['stalled'] = self.physics.stalled
        state['acceleration'] = self.physics.body.total_force / self.physics.body.mass if self.physics.body.mass > 0 else np.zeros(3)
        return state

    def get_position(self):
        return self.physics.body.position.copy()

    def get_weapon_status(self):
        return {
            'gun_ready': self.gun_ready,
            'missiles': self.missile_count,
        }
