'use strict';
// A first-person view: a position, yaw and pitch, and how looking, flying and walking drive them.

Features.kit('view', (engine, kit) => {
const { Common } = engine;
const { DEG, clamp, v3, m4 } = Common;

// FirstPersonView: an eye at `pos` looking along yaw / pitch (radians), vertical field of view `fov` (radians). What
// drives it is options, so one class serves a free fly camera, one held over a terrain, and a walking player's view
// (which moves `pos` by its own rules and uses only look(), basis(), view...):
//   turn            'left' (default): +yaw turns left, yaw 0 looks along -z (forward [-sin y cos p, sin p, -cos y cos p]);
//                   'right': +yaw turns right (forward [sin y cos p, sin p, -cos y cos p])
//   sensitivity     radians per pixel of pointer motion (look); fovScaled: times fov / 60 degrees
//   pitchLimit      |pitch| at most this (radians)
//   speed           m/s (move); keys: { forward, back, right, left, up, down } lists of key codes; normalize: diagonal
//                   moves no faster; boost / slow: { keys, factor } while one of those keys is held
//   wheel           { step, min, max }: each wheel notch divides the speed by step (zoomSpeed), within [min, max]
//   mode            'fly' (default) or 'walk' (setMode): how move() goes
//   clearance       flying, move() keeps the eye this far above the floor, and at most `ceiling` high
//   walk            { eye, speed, run, step, gravity }: walking, the feet stand on the floor the eye is `eye` m above, at
//                   `speed` m/s (`run` with the boost keys, times slow.factor with the slow keys); a floor up to `step`
//                   m higher is stepped onto at once (the eye eases up after it), a lower one is fallen to
// The floor is a function floor(x, y, z): the height of the highest thing to stand on at or below y there (-Infinity:
// nothing), e.g. a world's ground or the engine's over every world (FeatureWorld.ground, Host.floorFor).
class FirstPersonView {
    constructor(o = {}) {
        this.pos = [...(o.pos || [0, 0, 0])];
        this.yaw = o.yaw ?? 0;
        this.pitch = o.pitch ?? 0;
        this.fov = o.fov ?? 60 * DEG;
        this.speed = o.speed ?? 10;
        this.opts = {
            turn: 'left', sensitivity: 0.0025, fovScaled: false, pitchLimit: 1.55, normalize: false,
            boost: { keys: ['ShiftLeft', 'ShiftRight'], factor: 5 }, slow: null, clearance: 0, ceiling: Infinity,
            ...o,
            keys: { ...FirstPersonView.WASD, ...(o.keys || {}) },
            wheel: { step: 1.2, min: 1, max: 20000, ...(o.wheel || {}) },
            walk: { eye: 1.62, speed: 1.5, run: 4.5, step: 0.5, gravity: 9.81, ...(o.walk || {}) },
        };
        this.sign = this.opts.turn === 'right' ? 1 : -1;     // forward.x = sign * sin(yaw) cos(pitch)
        this.mode = 'fly';
        this.vy = 0;                    // walking: falling speed (m/s, up +)
        this.lag = 0;                   // walking: eye height still to catch up after a step
        this.setMode(o.mode || 'fly');
    }

    // 'fly' or 'walk' (walking starts on the floor under the eye)
    setMode(mode) {
        if (mode === this.mode) return;
        this.mode = mode;
        this.vy = this.lag = 0;
        this.landing = mode === 'walk';
    }

    basis() {
        const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch), k = this.sign;
        const fwd = [k * sy * cp, sp, -cy * cp], right = [cy, 0, k * sy];
        return { fwd, right, up: v3.cross(right, fwd) };
    }

    // turn to look along unit direction d / at a point
    lookAlong(d) {
        this.yaw = Math.atan2(this.sign * d[0], -d[2]);
        this.pitch = Math.asin(clamp(d[1], -1, 1));
    }
    lookAt(target) { this.lookAlong(v3.norm(v3.sub(target, this.pos))); }

    // { pos, fwd, up, fov } (FeatureWorld.view)
    get view() {
        const { fwd, up } = this.basis();
        return { pos: [...this.pos], fwd, up, fov: this.fov };
    }

    setView(v) {
        this.pos.splice(0, 3, ...v.pos);
        this.lookAlong(v.fwd);
        if (v.fov) this.fov = v.fov;
    }

    // world to view, column-major
    viewMatrix() { return m4.lookAt(this.pos, v3.add(this.pos, this.basis().fwd), [0, 1, 0]); }

    // pointer motion (pixels): turn and tilt
    look(dx, dy) {
        const o = this.opts, k = o.sensitivity * (o.fovScaled ? this.fov / (60 * DEG) : 1);
        this.yaw += this.sign * dx * k;
        this.pitch = clamp(this.pitch - dy * k, -o.pitchLimit, o.pitchLimit);
    }

    // wheel notches (+ away from the user): slower, (-) faster
    zoomSpeed(notches) {
        const w = this.opts.wheel;
        if (notches) this.speed = clamp(this.speed * Math.pow(w.step, -notches), w.min, w.max);
    }

    // dt s of the held keys (a Set of codes) over `floor` (or none): flying along the view, sideways, straight up and
    // down; or walking
    move(dt, keys, floor = null) {
        if (this.mode === 'walk' && floor) return this.walk(dt, keys, floor);
        const o = this.opts, K = o.keys, held = list => list.some(c => keys.has(c)), { fwd, right } = this.basis();
        let m = [0, 0, 0];
        if (held(K.forward)) m = v3.add(m, fwd);
        if (held(K.back)) m = v3.sub(m, fwd);
        if (held(K.right)) m = v3.add(m, right);
        if (held(K.left)) m = v3.sub(m, right);
        if (held(K.up)) m[1] += 1;
        if (held(K.down)) m[1] -= 1;
        if (o.normalize) { if (!v3.len(m)) return; m = v3.norm(m); }
        const mul = (o.boost && held(o.boost.keys) ? o.boost.factor : 1) * (o.slow && held(o.slow.keys) ? o.slow.factor : 1);
        this.pos = v3.add(this.pos, v3.mul(m, this.speed * mul * dt));
        if (floor) this.pos[1] = clamp(this.pos[1], floor(this.pos[0], this.pos[1], this.pos[2]) + o.clearance, o.ceiling);
    }

    // on foot: level along the view's heading, onto the floor (up a step at once, the eye following; or falling to it)
    walk(dt, keys, floor) {
        const o = this.opts, W = o.walk, K = o.keys, held = list => list.some(c => keys.has(c));
        const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw), f = [this.sign * sy, -cy], r = [cy, this.sign * sy];
        let mx = 0, mz = 0;
        if (held(K.forward)) { mx += f[0]; mz += f[1]; }
        if (held(K.back)) { mx -= f[0]; mz -= f[1]; }
        if (held(K.right)) { mx += r[0]; mz += r[1]; }
        if (held(K.left)) { mx -= r[0]; mz -= r[1]; }
        const l = Math.hypot(mx, mz), speed = (o.boost && held(o.boost.keys) ? W.run : W.speed) * (o.slow && held(o.slow.keys) ? o.slow.factor : 1);
        const x = this.pos[0] + (l ? mx / l * speed * dt : 0), z = this.pos[2] + (l ? mz / l * speed * dt : 0);
        let feet = this.pos[1] - W.eye - this.lag;
        const g = floor(x, this.landing ? feet : feet + W.step, z);
        if (g === -Infinity) { this.vy = 0; return; }                  // nothing to stand on there: stay
        if (this.landing) { feet = g; this.landing = false; }
        if (g >= feet) { this.lag -= g - feet; feet = g; this.vy = 0; }
        else {
            this.vy -= W.gravity * dt;
            feet = Math.max(g, feet + this.vy * dt);
            if (feet === g) this.vy = 0;
        }
        this.lag *= Math.exp(-dt * 10);
        if (Math.abs(this.lag) < 1e-3) this.lag = 0;
        this.pos = [x, feet + W.eye + this.lag, z];
    }

    // a frame of input: io (PointerInput.consume(): dx, dy, wheel), the held keys, and the floor (move)
    control(dt, io, keys, floor = null) {
        this.look(io.dx, io.dy);
        this.zoomSpeed(io.wheel);
        this.move(dt, keys, floor);
    }

    // world-space direction through canvas pixel (mx, my) of a w x h canvas
    ray(mx, my, w, h) {
        const { fwd, right, up } = this.basis(), t = Math.tan(this.fov / 2), a = w / h;
        const x = (mx / w * 2 - 1) * t * a, y = (1 - my / h * 2) * t;
        return v3.norm(v3.add(fwd, v3.add(v3.mul(right, x), v3.mul(up, y))));
    }
}

FirstPersonView.WASD = { forward: ['KeyW'], back: ['KeyS'], right: ['KeyD'], left: ['KeyA'], up: ['Space'], down: ['KeyC'] };

return { FirstPersonView };
});
