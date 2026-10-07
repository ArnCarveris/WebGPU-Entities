'use strict';
// Entities: doors, lamps, beacons, lights, drones, cameras, the avatar, terminals and easels.

Features.part('gui', (engine, feature) => {
const { kits } = engine;
const { V3, M4, lerp, smooth01, deg } = GuiKit;
const { TerminalGUI, EaselGUI, PaintCanvas } = feature;

// World entities. Each is constructed from a scenario definition ({ type, id, ... }).

class Entity extends kits.world.Entity {
    get game() { return this.world.game; }
    get position() { return this.def.pos; }
    get guis() { return []; }

    init(renderer) {}
    writeInstances(renderer) {}
    render(pass, ctx) {}        // ctx: { showAvatar, skip }
    lights(out) {}              // push [x, y, z, intensity, r, g, b, 0]
    collide(p) {}               // push the player's [x, y, z] out of the entity
}

// One model placed at pos / yaw
class ModelEntity extends Entity {
    init(renderer) {
        this.mesh = this.world.mesh(this.def.model);
        this.instance = renderer.allocInstances(1);
        this.matrix = M4.placement(this.def.pos || [0, 0, 0], this.def.yaw || 0);
        this.tint = null;
    }

    visibleTo(ctx) { return true; }

    writeInstances(renderer) {
        renderer.setInstance(this.instance, this.matrix, this.tint);
    }

    render(pass, ctx) {
        if (this !== ctx.skip && this.visibleTo(ctx)) pass.mesh(this.mesh, this.instance);
    }
}

// Door whose panels slide apart along their `slide` directions
class SlidingDoor extends Entity {
    init(renderer) {
        this.mesh = this.world.mesh(this.def.model);
        this.instance = renderer.allocInstances(this.def.panels.length);
        this.target = 0;
        this.progress = 0;
        this.lastWave = 0;
    }

    get name() { return this.def.name; }
    get isOpen() { return this.target === 1; }
    get passable() { return this.progress > 0.95; }
    get openAmount() { return smooth01(this.progress); }
    get status() {
        if (this.isOpen) return this.progress > 0.99 ? 'open' : 'opening';
        return this.progress < 0.01 ? 'sealed' : 'closing';
    }

    setOpen(open) {
        if (this.isOpen === open) return false;
        this.target = open ? 1 : 0;
        return true;
    }

    update(dt, t) {
        const d = this.target - this.progress;
        this.progress += Math.sign(d) * Math.min(Math.abs(d), dt * this.def.speed);
        if (Math.abs(d) > 0.001 && t - this.lastWave > 0.5) {
            this.lastWave = t;
            this.world.waves.emit('door', this.position[0], this.position[2]);
        }
    }

    writeInstances(renderer) {
        const o = this.openAmount * this.def.travel;
        this.def.panels.forEach((p, i) => {
            renderer.setInstance(this.instance + i, M4.translation(...V3.add(p.pos, V3.scale(p.slide, o))));
        });
    }

    render(pass) {
        pass.mesh(this.mesh, this.instance, this.def.panels.length);
    }
}

// Lamp hanging from a pivot, swinging around Z; its bulb is the scene's first light
class SwingingLamp extends ModelEntity {
    init(renderer) {
        super.init(renderer);
        this.swing = 0;
        this.flicker = 1;
    }

    get position() { return this.def.pivot; }

    update(dt, t) {
        const s = this.def.swing;
        this.swing = s.amp * Math.sin(t * s.freq) + s.amp2 * Math.sin(t * s.freq2);
        this.flicker = Math.sin(t * 13.1) * Math.sin(t * 3.7 + 1) > 0.92 ? 0.2 + 0.3 * Math.random() : 1;
        this.matrix = M4.multiply(M4.translation(...this.def.pivot), M4.rotationZ(this.swing));
    }

    lights(out) {
        const p = this.def.pivot, L = this.def.bulbLength;
        const on = this.world.lightsOn ? this.def.intensity * this.flicker * this.world.lampScale : 0;
        out.push([p[0] + Math.sin(this.swing) * L, p[1] - Math.cos(this.swing) * L, p[2], on, ...this.def.color, 0]);
    }
}

// Rotating alarm beacon: siren, radar waves and a pulsing red light while the alarm is on
class AlarmBeacon extends Entity {
    init() {
        this.lastTone = 0;
        this.lastWave = 0;
        this.high = false;
    }

    update(dt, t) {
        if (!this.world.alarm) return;
        const d = this.def;
        if (t - this.lastTone > d.toneEvery) {
            this.lastTone = t;
            this.high = !this.high;
            this.game.audio.emit('alarm', { freq: this.high ? d.tones[0] : d.tones[1] });
        }
        if (t - this.lastWave > d.waveEvery) {
            this.lastWave = t;
            this.world.waves.emit('alarm', d.wave[0], d.wave[1]);
        }
    }

    lights(out) {
        out.push([...this.def.pos, this.world.alarmPulse * this.def.intensity, ...this.def.color, 0]);
    }
}

// Point light, optionally tied to the room lights, a door's opening or the alarm colour
class PointLight extends Entity {
    lights(out) {
        const d = this.def, w = this.world;
        let intensity = d.intensity;
        if (d.roomLights && !w.lightsOn) intensity = 0;
        if (d.door) intensity *= lerp(d.door.min, 1, w.get(d.door.id).openAmount);
        const color = w.alarm && d.alarmColor ? d.alarmColor : d.color;
        out.push([...d.pos, intensity, ...color, 0]);
    }
}

// Drone flying an elliptical patrol loop, pinging the radar and lighting its surroundings red
class PatrolDrone extends ModelEntity {
    init(renderer) {
        super.init(renderer);
        this.angle = 0;
        this.pos = [...this.def.center];
        this.fwd = [0, 0, -1];
        this.lastPing = 0;
        this.tint = [1, 0, 0, 0];   // blinking eye
    }

    get position() { return this.pos; }

    update(dt, t) {
        const d = this.def;
        this.angle += dt * d.speed;
        const [rx, rz] = d.radius;
        this.pos = [d.center[0] + rx * Math.cos(this.angle), d.center[1] + d.bob.amp * Math.sin(t * d.bob.freq), d.center[2] + rz * Math.sin(this.angle)];
        this.fwd = V3.normalize([-rx * Math.sin(this.angle), 0, rz * Math.cos(this.angle)]);
        this.matrix = M4.facing(this.pos, this.fwd);
        if (t - this.lastPing > d.pingEvery) {
            this.lastPing = t;
            this.world.waves.emit('drone', this.pos[0], this.pos[2]);
        }
    }

    lights(out) {
        const e = this.def.eyeLight;
        out.push([...V3.add(this.pos, V3.scale(this.fwd, e.ahead)), e.intensity, ...e.color, 0]);
    }
}

// Security camera that pans; the CCTV system renders through the selected one
class SecurityCamera extends ModelEntity {
    init(renderer) {
        super.init(renderer);
        this.fwd = V3.normalize(V3.sub(this.def.target, this.def.pos));
        this.panDeg = 0;
    }

    get name() { return this.def.name; }
    get location() { return this.def.loc; }
    get offline() { return !!this.def.offline; }

    update(dt, t) {
        const d = this.def;
        const base = V3.normalize(V3.sub(d.target, d.pos));
        const pan = d.sweep * Math.sin(t * d.speed + d.pos[0]);
        this.panDeg = Math.round(deg(pan));
        const c = Math.cos(pan), s = Math.sin(pan);
        this.fwd = [base[0] * c + base[2] * s, base[1], -base[0] * s + base[2] * c];
        this.matrix = M4.facing(d.pos, this.fwd);
        this.tint = [this.game.cctv.renderingCamera === this ? 1 : 0, 0, 0, 0];   // tally light
    }
}

// The player's body, only seen from other cameras
class Avatar extends ModelEntity {
    update() {
        const p = this.game.player;
        this.matrix = M4.multiply(M4.translation(p.pos[0], 0, p.pos[2]), M4.rotationY(-p.yaw));
    }

    get position() { return this.game.player.pos; }

    visibleTo(ctx) { return !!ctx.showAvatar; }
}

// Wall terminal: housing model + the terminal GUI on its screen
class Terminal extends ModelEntity {
    constructor(def, world) {
        super(def, world);
        this.gui = new TerminalGUI(def.gui, def.content, world);
    }

    get guis() { return [this.gui]; }

    init(renderer) {
        super.init(renderer);
        this.gui.setTransform(this.matrix);
    }
}

// Painting easel: wooden model, a paint render target and the easel GUI
class Easel extends ModelEntity {
    constructor(def, world) {
        super(def, world);
        this.canvas = new PaintCanvas(`paint:${def.id}`, def.paint);
        this.gui = new EaselGUI(def.gui, def.paint, this.canvas);
    }

    get guis() { return [this.gui]; }

    init(renderer) {
        super.init(renderer);
        this.canvas.init(renderer);
        this.gui.setTransform(this.matrix);
    }

    collide(p) {
        const r = this.def.collider;
        const ex = p[0] - this.def.pos[0], ez = p[2] - this.def.pos[2], d = Math.hypot(ex, ez);
        if (d < r) {
            p[0] = this.def.pos[0] + (ex / (d || 1)) * r;
            p[2] = this.def.pos[2] + (ez / (d || 1)) * r;
        }
    }
}

const ENTITY_TYPES = {
    static: ModelEntity,
    door: SlidingDoor,
    lamp: SwingingLamp,
    alarmBeacon: AlarmBeacon,
    light: PointLight,
    drone: PatrolDrone,
    securityCamera: SecurityCamera,
    avatar: Avatar,
    terminal: Terminal,
    easel: Easel
};

return { SecurityCamera, Easel, ENTITY_TYPES };
});
