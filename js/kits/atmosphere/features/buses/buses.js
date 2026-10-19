'use strict';
// The buses of a world under the atmosphere (its `bus` entities: the transit kit's BusLines and their fleets): drawn each
// in its own frame, boarded, ridden and driven, lighting the street by night, heard. On with a bus entity; it builds on
// the structures feature (the buses run on their roads, stop at their stations and are indexed with their interiors).
//
// BusesApp (app.ext.buses): the wheel (F: the transit kit's DriveControl, app.drive), B to the next bus, what the frame
// draws of them (the buses near, nearest first), the cabin of the bus ridden, their lights, their sounds, their readout.

Features.feature('atmosphere/buses', (engine, kit) => {
const { m4 } = engine.Common;
const { BUS_DRAW, BUS, DriveControl } = engine.kits.transit;
const { BUS_UNIFORM, LIGHT_RANGE } = kit;

class BusesApp {
    static key = 'buses';

    constructor(app) {
        this.app = app;
        app.drive = new DriveControl(app);      // F: at the wheel of a bus
        this.busDoors = new Map();              // each bus's doors (0..1) last frame
        this.busMoving = new Map();             // and whether it has driven faster than 1 m/s since it last stood
    }

    load() { this.app.drive.vehicle = null; }

    // what F would do here (the HUD shows it on foot or flying)
    get prompt() { return this.app.drive.prompt; }

    // after the walker: the controls into the bus driven
    afterWalk() { this.app.drive.update(this.app.input.keys); }

    // B: to the next bus of the fleet (each press another); F: by a bus, drive it (or get out)
    key(code) {
        const a = this.app, w = a.world;
        if (code === 'KeyB') {
            if (!w.buses.length) a.hud.toast('No bus in this scenario');
            else this.toBus(((a.busPick ?? -1) + 1) % w.buses.length);
            return true;
        }
        return code === 'KeyF' && a.drive.toggle();
    }

    // to bus i: at its door (Bus.board)
    toBus(i) {
        const a = this.app, bus = a.world.buses[i];
        if (!bus) return;
        a.busPick = i;
        a.walker.active = false;
        bus.board(a, 'door');
        a.reset = true;
        a.hud.toast(`${bus.label}: ${bus.describe()}`);
    }

    // each bus near enough to see (the InteriorIndex's coarse cells within BUS_DRAW, not every bus): its model-view built
    // in doubles about the camera (its interior a metre away would jitter in f32 world space), in its object frame (its
    // slot after the renderer's buses' frameBase), nearest first
    draws(fw, { proj, basis }) {
        const a = this.app, r = a.renderer, B = r.ext.buses, cam = a.camera, { fwd, right, up } = basis, draws = [];
        a.world.structures.interiors.near(cam.pos, BUS_DRAW, 'vehicle').forEach(({ owner: bus }) => {
            const k = bus.slot;
            const m = bus.model, dist = Math.hypot(m[12] - cam.pos[0], m[13] - cam.pos[1], m[14] - cam.pos[2]);
            if (dist > BUS_DRAW) return;
            const o = (B.frameBase + k) * BUS_UNIFORM / 4;
            r.busData.set(m4.mul(proj, m4.aboutEye(m, cam.pos, right, up, fwd)), o);
            r.busData.set(m, o + 16);
            r.busData.set(bus.inverse, o + 32);
            r.busData.set([bus.v, bus.doors, 0, 0], o + 48);
            draws.push([dist, k]);
        });
        B.draws = draws.sort((p, q) => p[0] - q[0] || p[1] - q[1]).map(e => e[1]);
        r.useFrames(B, B.draws.length ? Math.max(...B.draws) + 1 : 0);
    }

    // the cabin of the bus ridden, or the nearest (after a lift car, before a building)
    cabin() {
        const b = this.app.rideBus;
        return b ? { rank: 1, inv: b.inverse, lo: [-BUS.hl, BUS.skirt, -BUS.hw, 1], hi: [BUS.hl, BUS.roof, BUS.hw, 0] } : null;
    }

    // the bus nearest the camera within BUS_DRAW (the InteriorIndex's rings, O(1); the sounds and the readout read it);
    // the bus ridden, the one whose cabin the camera is in, or that nearest (its cabin keeps the rain out, the HUD tells
    // of it)
    surround(p) {
        const a = this.app, I = a.world.structures.interiors;
        const near = I.nearest(p, 'vehicle', BUS_DRAW);
        a.nearBus = near ? { bus: near.it.owner, dist: near.d } : { bus: null, dist: Infinity };
        const cabin = I.at(p, 'vehicle');
        a.rideBus = (a.walker.active && a.walker.bus) || cabin?.owner || a.nearBus.bus;
        a.inBus = !!a.rideBus?.interior?.contains(p);
    }

    // by night: the buses within reach (the InteriorIndex, not every bus), in their order
    lights(all, cam) {
        const buses = this.app.world.structures.interiors.near(cam, LIGHT_RANGE + 80, 'vehicle').map(it => it.owner).sort((p, q) => p.slot - q.slot);
        for (const b of buses) if (Math.hypot(b.pose.x - cam[0], b.pose.z - cam[2]) < LIGHT_RANGE + 80) b.lights(all);
    }

    // the distant lights by night: the first buses' lights, as many as there are slots (max)
    farLights(out, max) { for (const b of this.app.world.buses) { if (out.length >= max) break; b.lights(out); } }

    // a bus door starting to open or shut, a bus coming to rest (its air brakes: busHiss), a driven bus bumping into
    // something (busBump: speed m/s): the scenario's sound cues (sound.cue)
    sounds() {
        const a = this.app, cam = a.camera.pos;
        for (const b of a.world.buses) {
            const was = this.busDoors.get(b);
            if (was !== undefined && ((was <= 0 && b.doors > 0) || (was >= 1 && b.doors < 1)))
                a.fx.emit('busDoor', { dist: Math.hypot(b.pose.x - cam[0], b.pose.y - cam[1], b.pose.z - cam[2]) });
            this.busDoors.set(b, b.doors);
            const dist = Math.hypot(b.pose.x - cam[0], b.pose.y - cam[1], b.pose.z - cam[2]), v = Math.abs(b.v);
            if (v > 1) this.busMoving.set(b, true);
            else if (v < 0.05 && this.busMoving.get(b)) { this.busMoving.set(b, false); a.fx.emit('busHiss', { dist }); }
            if (b.bumped) { a.fx.emit('busBump', { dist, speed: b.bumped }); b.bumped = 0; }
        }
    }

    // what the sound beds, HUD panels and links read of the bus nearest (Surroundings)
    stats(out) {
        const a = this.app, { bus, dist } = a.nearBus || { bus: null, dist: Infinity };
        Object.assign(out, {
            busDist: dist, busSpeed: bus ? Math.abs(bus.v) : 0, riding: !!a.inBus && a.rideBus === bus,
            busLoad: bus?.load ?? 0, busBraking: !!bus?.braking && Math.abs(bus.v) > 0.5, driving: !!a.drive?.active,
        });
    }

    // the readout's bus line: the bus ridden or near, and how the walker is aboard
    lines() {
        const a = this.app, b = a.rideBus, wk = a.walker;
        if (!b) return [];
        return [`bus     ${b.label} ${b.describe()}${wk.active ? ` · <span class="w">${wk.seat ? 'seated' : wk.bus ? 'aboard' : 'on foot'}</span>` : ''}${a.world.busBoost > 1 ? ' <span class="w">×10</span>' : ''}`];
    }

    // the View page: the buses ×10 (else while Z is held)
    page(id) {
        const a = this.app;
        return id === 'view' && a.world.buses.length ? { cells: [{ toggle: 'Buses ×10', on: a.busFast, set: v => { a.busFast = v; } }] } : null;
    }
}

return { extensions: { app: BusesApp, renderer: kit.BusesRenderer } };
});
