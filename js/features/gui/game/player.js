'use strict';
// The player controller.

Features.part('gui', (engine, feature) => {
const { kits } = engine;
const { V3, M4, clamp, wrapIndex, deg, rad } = GuiKit;

// First-person player: movement, collision, footsteps and noise.

// Its view is a FirstPersonView (turning right with +yaw, 0.004 rad per pixel, pitch within 1.3 rad); its own fov is set
// in degrees (fovDeg)
class PlayerController extends kits.view.FirstPersonView {
    constructor(game, cfg) {
        super({ pos: cfg.start.pos, yaw: cfg.start.yaw, pitch: cfg.start.pitch, fov: rad(cfg.fovDeg), turn: 'right', sensitivity: 0.004, pitchLimit: 1.3 });
        this.game = game;
        this.cfg = cfg;
        this.stepAccum = 0;
        this.stepPhase = 0;
        this.moving = false;
        this.running = false;
        this.noise = 0;
    }

    get eye() { return this.pos; }
    get fovy() { return this.fov; }
    get fovDeg() { return deg(this.fov); }
    set fovDeg(v) { this.fov = rad(v); }
    get heading() { return wrapIndex(Math.round(deg(this.yaw)) % 360, 360); }

    viewMatrix() {
        return M4.lookAt(this.pos, V3.add(this.pos, this.basis().fwd), [0, 1, 0]);
    }

    // Ray through the mouse position for a projection with vertical fov `fovy`
    viewRay(mouse, fovy) {
        const { fwd, right, up } = this.basis();
        const nx = (mouse.x / window.innerWidth) * 2 - 1;
        const ny = 1 - (mouse.y / window.innerHeight) * 2;
        const th = Math.tan(fovy / 2);
        const aspect = window.innerWidth / window.innerHeight;
        return [0, 1, 2].map((k) => fwd[k] + right[k] * nx * th * aspect + up[k] * ny * th);
    }

    stepForward(dist) {
        this.step(Math.sin(this.yaw) * dist, -Math.cos(this.yaw) * dist);
    }

    update(dt, keys) {
        this.noise *= Math.exp(-dt * 0.7);
        const k = keys;
        const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
        const s = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
        this.running = k.has('ShiftLeft') || k.has('ShiftRight');
        this.moving = false;
        if (!f && !s) {
            this.stepAccum = Math.min(this.stepAccum, 0.35);
            return;
        }
        const speed = (this.running ? this.cfg.runSpeed : this.cfg.walkSpeed) * dt;
        const len = Math.hypot(f, s);
        const fx = Math.sin(this.yaw), fz = -Math.cos(this.yaw);
        const before = [this.pos[0], this.pos[2]];
        this.step(((fx * f - fz * s) / len) * speed, ((fz * f + fx * s) / len) * speed);
        const moved = Math.hypot(this.pos[0] - before[0], this.pos[2] - before[1]);
        if (moved < 1e-5) return;
        this.moving = true;

        // Footsteps: one per stride; running is louder and makes bigger radar waves
        const stride = this.running ? this.cfg.stride.run : this.cfg.stride.walk;
        this.stepPhase += (moved / stride) * Math.PI;
        this.stepAccum += moved;
        if (this.stepAccum >= stride) {
            this.stepAccum -= stride;
            this.game.audio.step(this.running);
            this.game.world.waves.emit('step', this.pos[0], this.pos[2], this.running ? 1.4 : 0.8);
            this.noise = clamp(this.noise + (this.running ? 0.3 : 0.14), 0, 1);
        }
    }

    // Move with collision: room bounds, a doorway that opens with its door, entity colliders
    step(dx, dz) {
        const p = this.pos, { bounds, doorway } = this.cfg;
        let x = p[0] + dx;
        const z = p[2] + dz;
        const [dx0, dx1] = doorway.x;
        if (p[2] < doorway.enterZ) x = clamp(x, dx0, dx1);            // inside the doorway / corridor
        const canPass = this.game.world.get(doorway.door).passable && x > dx0 && x < dx1;
        p[0] = clamp(x, bounds.x[0], bounds.x[1]);
        p[2] = clamp(z, canPass ? doorway.minZ : bounds.z[0], bounds.z[1]);
        this.game.world.collide(p);
    }
}

return { PlayerController };
});
