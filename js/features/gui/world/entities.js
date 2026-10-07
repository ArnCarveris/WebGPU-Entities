'use strict';
// Entities: doors, lamps, beacons, lights, drones, cameras, the avatar, terminals and easels.

Features.part('gui', (engine, feature) => {
const { kits } = engine;
const { V3, M4, EaselGUI, PaintCanvas } = engine.kits.gui;
const { door, securityCamera, drone, LightSource } = kits.entities;
const { TerminalGUI } = feature;

// World entities. Each is constructed from a scenario definition ({ type, id, ... }).

class Entity extends kits.world.Entity {
    get game() { return this.world.game; }
    get position() { return this.def.pos; }
    get guis() { return []; }

    init(renderer) {}
    writeInstances(renderer) {}
    render(pass, ctx) {}        // ctx: { showAvatar, skip }
    lights(out, t) {}           // push [x, y, z, intensity, r, g, b, 0]
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

// Door (kits.entities door: open / target / speed, status, setOpen) whose panels slide apart along their `slide`
// directions, `travel` m at full opening
class SlidingDoor extends door(Entity) {
    init(renderer) {
        this.mesh = this.world.mesh(this.def.model);
        this.instance = renderer.allocInstances(this.def.panels.length);
        this.lastWave = 0;
    }

    get name() { return this.def.name; }

    update(dt, t) {
        const d = this.step(dt);
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

// Point light (kits.entities LightSource), optionally tied to the room lights, a door's opening or the alarm colour, or
// flickering / pulsing
class PointLight extends Entity {
    constructor(def, world) {
        super(def, world);
        this.source = new LightSource(def, world);
    }

    lights(out, t) {
        const L = this.source;
        out.push([...L.pos, L.intensityAt(t), ...L.colorNow, 0]);
    }
}

// Drone (kits.entities drone) flying an elliptical patrol loop, pinging the radar and lighting its surroundings red
class PatrolDrone extends drone(ModelEntity) {
    init(renderer) {
        super.init(renderer);
        this.tint = [1, 0, 0, 0];   // blinking eye
    }

    get position() { return this.at; }

    update(dt, t) {
        super.update(dt, t);
        this.matrix = M4.facing(this.at, this.fwd);
    }

    ping() { this.world.waves.emit('drone', this.at[0], this.at[2]); }

    lights(out, t) {
        const L = this.light;
        if (L) out.push([...L.pos, L.intensityAt(t), ...L.colorNow, 0]);
    }
}

// Security camera (kits.entities securityCamera) that pans, with a tally light; the CCTV system renders through the
// selected one
class SecurityCamera extends securityCamera(ModelEntity) {
    update(dt, t) {
        super.update(dt, t);
        this.matrix = M4.facing(this.def.pos, this.fwd);
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
