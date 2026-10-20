'use strict';
// The structures of a world under the atmosphere: what its entities build on the terrain (the settlement kit's
// Structures: buildings with their interiors, lifts and doors, villages, the bus station, roads, bridges, a real place's
// buildings and roads), lit by night (their lamps, the lit rooms, the distant lights and the fake street lamps of the lit
// town). On in a world whose entities build (their implementations need 'structures': the kit manifest), or whose data
// has buildings, plans or street lights; without them none of this, nor the settlement and building kits, loads.
//
// StructuresWorld (world.ext.structures): builds them (world.structures, world.far), runs the lifts, gives the walker
// their colliders and the lift cars it rides, says what shelters a point. StructuresApp (app.ext.structures): the doors
// and lifts the camera uses, what it draws each frame (the portal traversal of the planned buildings: their rooms, lift
// boxes and panels, each building in its Origin's frame), the cabin it is in, their sun and rain shadows, their lights.

Features.feature('atmosphere/structures', (engine, kit) => {
const { Common, kits } = engine;
const { clamp, m4 } = Common;
const { GridHash } = kits.interior;
const { pcgRandom } = kits.noise;
const { LAMPS, Structures, Buildings, ShelterBoxes, cloudMeshes, DoorControl, DOOR_REACH, INTERIOR_DRAW, DRIP_PARTICLES } = kits.settlement;
const { LiftControl, RoomVis } = kits.building;
const { FarLights, BUS_UNIFORM, LIGHT_RANGE, ROOM_LIGHTS, ROOM_RANGE, POLE_DRAW, MAX_POLES, MAX_FAR_DYN, FAR_FLOATS, GLOW_GAIN } = kit;

class StructuresWorld {
    static key = 'structures';

    constructor(world) { this.world = world; }

    // what draws and lights itself draws through the structures' meshes and lamps (a bus)
    created() {
        this.world.meshes = cloudMeshes;
        this.world.lamps = LAMPS;
    }

    // what the entities build (each its build(structures)), after they stamped the terrain
    build() {
        const w = this.world, S = w.structures = new Structures(w.field, w.scenario.buildings, w.scenario.plans);
        for (const e of w.entities) e.build(S);
        S.finish();
    }

    // the distant lights by night: the structures' lamps and the lit town's fake street lamps
    townLit() {
        const w = this.world;
        w.far = new FarLights(w.field, w.structures, w.streetLights);
    }

    // the lifts (Z runs them ten times as fast too)
    after(dt) { this.world.structures.lifts.update(dt, this.world.busBoost); }

    // a walker at feet p walks on and into the boxes near it, the lift cars and the doors that are shut
    colliders(p, out) {
        const S = this.world.structures;
        for (const b of S.solids.near(p[0], p[2], 2, p[1])) out.push(b);
        for (const b of S.lifts.colliders(p)) out.push(b);
        for (const b of S.innerDoors.colliders(p)) out.push(b);
    }

    // the lift car a walker at p stands in or on (its frame carries it)
    carrierAt(p) { const L = this.world.structures.lifts; return L.carAt(p, 0.3) || L.roofAt(p); }

    // their buildings' and buses' interiors shelter what is in them (the InteriorIndex, O(1))
    sheltered(p) { return this.world.structures.interiors.sheltered(p) || null; }
}

class StructuresApp {
    static key = 'structures';

    constructor(app) {
        this.app = app;
        const R = () => app.renderer.ext.structures;
        app.doors = new DoorControl(app, { moved: () => { const S = app.world.structures; R().writeDoors(S.doors.mesh()); R().writeBuildings(S.buildings); } });
        app.liftControl = new LiftControl(app, { reach: DOOR_REACH, cars: () => app.frameWriter.roomVis?.cars, view: () => app.frameWriter.view(), gui: R });
        // the portal visibility's inspector (the building kit's RoomVis has one: floor map, traversal, frames): a tap on
        // the map walks (or flies) the camera there, onto the floor of the area tapped
        app.inspect = { map: { teleport: (x, z, area) => {
            const A = app.world.structures.areas.areas[area], y = A ? A.y : app.camera.pos[1] - (app.walker.active ? 1.62 : 0);
            if (app.walker.active) app.walker.place(app, x, z, y + 0.05);
            else app.camera.pos = [x, y + 1.62, z];
        } } };
        this.poleData = new Float32Array(MAX_POLES * 8);
        this.poleAt = null;             // where the camera was when the poles were last listed
        this.farDyn = new Float32Array(MAX_FAR_DYN * FAR_FLOATS);
    }

    // How world-space GUIs are drawn: the scenario's `render.gui` (StructuresRenderer.setGui)
    configure(cfg) { this.app.renderer.ext.structures.setGui(cfg.gui || {}); }

    // the lifts' panels and buttons (E), then the doors (E)
    afterWalk(dt, io, now) {
        this.app.liftControl.update(dt, io, now);
        this.app.doors.update(dt, io);
    }

    // ---------------------------------------------------------------------------------------------- the frame
    // building interiors: the rooms of the planned ones the portal traversal reaches (the building kit's RoomVis: the
    // interior kit's PortalVis, from the camera's room, or from outside through the windows of the storeys within
    // INTERIOR_DRAW, the same test fsWindow and fsPane make); the unplanned ones (one room each) within INTERIOR_DRAW of
    // their box that the camera is in or sees into through a portal in the view frustum: only the InteriorIndex cells
    // within INTERIOR_DRAW are visited, whatever the number of buildings
    draws(fw, { proj, near, basis, aspect, planes }) {
        const a = this.app, r = a.renderer, R = r.ext.structures, S = a.world.structures, cam = a.camera, { fwd, right, up } = basis, inside = [];
        if (fw.roomVis?.world !== S) fw.roomVis = new RoomVis(S, { range: INTERIOR_DRAW, inspect: a.inspect });
        fw.rooms = fw.roomVis.compute(cam.pos, fw.viewProj, r.width, r.height, inside, near, { basis, aspect, fov: cam.fov });
        // the outdoors as the traversal sees it (the renderer leaves it out, or draws it within the portals' rectangle);
        // the unplanned buildings are seen from it
        fw.outdoors = fw.roomVis.outdoors;
        if (fw.outdoors?.seen !== false) for (const [, it] of S.interiors.seen(cam.pos, planes, INTERIOR_DRAW, 'building')) S.buildings.draws(it.owner, inside);
        // its sector and portal frames, about the eye
        r.lineLayer.write(fw.roomVis.inspector.lines(cam.pos), m4.mul(proj, m4.view([0, 0, 0], right, up, fwd)));
        // the lift cars the traversal reached (their areas), the landing doors and counterweights near
        // each building drawn in the frame of its storey nearest the eye (its Origin's level, kits.interior), so what is
        // near the camera is a few metres from its origin in f32 at any height
        const frameOf = b => b.interior.origin.level(b.interior.origin.levelNear(cam.pos));
        R.boxGroups = S.lifts.instances(cam.pos, R.boxData, fw.roomVis.cars, fw.roomVis.ranges, b => frameOf(b).M[13]);
        // the doors' leaves in the rooms drawn, after them (the same boxes)
        const lifted = R.boxGroups.reduce((n, g) => n + g.count, 0);
        R.boxGroups.push(...S.innerDoors.instances(cam.pos, R.boxData, lifted, fw.roomVis.seen, b => frameOf(b).M[13]));
        R.boxCount = R.boxGroups.reduce((n, g) => n + g.count, 0);
        // each building drawn, in its Origin's frame: its model-view built in doubles about the camera, in an object frame
        // of busData (the interiors' and the lifts' draws name it)
        const slots = new Map(), cap = R.frames();
        const slotOf = b => {
            let k = slots.get(b);
            if (k !== undefined) return k;
            if (slots.size >= cap) return -1;
            k = R.frameBase + slots.size;
            slots.set(b, k);
            // its storey's frame (its Origin's level nearest the eye): vsInterior stands each storey (s - that level)
            // storeys up in it
            const O = b.interior.origin, s = O.levelNear(cam.pos), M = O.level(s).M, o = k * BUS_UNIFORM / 4;
            r.busData.set(m4.mul(proj, m4.aboutEye(M, cam.pos, right, up, fwd)), o);
            r.busData.set(M, o + 16);
            r.busData.set([0, 0, s, 0], o + 48);
            return k;
        };
        R.interiorDraws = inside.map(d => [d[0], d[1], d[2], d[3], d[4], slotOf(d[4])]).filter(d => d[5] >= 0).sort((p, q) => p[5] - q[5]);
        for (const g of R.boxGroups) g.slot = slotOf(g.b);
        R.boxGroups = R.boxGroups.filter(g => g.slot >= 0);
        R.originCount = slots.size;
        r.useFrames(R, slots.size);
        R.setPanels(a.liftControl.shown || []);
    }

    // the cabin the rain and the march leave out: the lift car the camera is in (its own air: nothing of the shaft's or
    // the weather's in it; first), else the building the camera is in (last, after a bus)
    cabin() {
        const a = this.app, car = a.rideCar;
        if (car) {
            const M = car.matrix(), [x0, x1, z0, z1] = car.out;
            return { rank: 0, inv: [M[0], 0, M[8], 0, 0, 1, 0, 0, M[2], 0, M[10], 0, -(M[0] * M[12] + M[2] * M[14]), -M[13], -(M[8] * M[12] + M[10] * M[14]), 1],
                lo: [x0, -0.2, z0, 1], hi: [x1, car.h + 0.15, z1, 0] };
        }
        const b = a.indoors;
        if (!b) return null;
        const { cs, sn, c } = b.f, tx = c[0], tz = c[1];
        return { rank: 2, inv: [cs, 0, -sn, 0, 0, 1, 0, 0, sn, 0, cs, 0, -(cs * tx + sn * tz), -b.floor, -(-sn * tx + cs * tz), 1],
            lo: [-b.hx + b.t, -0.2, -b.hz + b.t, 1], hi: [b.hx - b.t, b.top - b.floor, b.hz - b.t, 0] };
    }

    // their sun and rain shadows near the camera (ShelterBoxes.write: the boxes, their grid), and the roof edges the rain
    // runs off (DRIP_PARTICLES drops falling off them)
    shelter(fw, F, { cam, sun, wind, freezing, fall }) {
        fw.drips = this.app.world.structures.boxes.write(F, cam, sun, wind, freezing, fall);
        fw.dripParticles = DRIP_PARTICLES;
    }

    // where the camera is: in a building (its box, storeys)
    surround(p) { this.app.indoors = this.app.world.structures.buildings.inside(p); }

    // under a roof or a deck (the way the drops come is blocked), or in an interior
    shelters(p, dir) {
        const S = this.app.world.structures;
        return !!S.interiors.sheltered(p) || S.boxes.shelters(p, dir);
    }

    // ---------------------------------------------------------------------------------------------- the lights
    // by night: their lamps that can reach the camera, the lit rooms of the buildings near, the fake street lamps near
    // (real lights now)
    lights(all, cam) {
        const w = this.app.world;
        all.push(...this.nearLamps(w.structures.fixtures.lights, cam));
        this.roomLights(w.structures.buildings, cam, all);
        w.far.near(cam, LIGHT_RANGE + LAMPS.sodium.range, all);
    }

    // each light's boxes of the frame (ShelterBoxes.write) that can stand between it and what it lights: all those within
    // its reach, but not one holding it that is not enclosed (the bus whose headlights or cabin it is, the bus the
    // flashlight is aboard), so it shines out of it
    lightMasks(lights, mask) {
        const boxes = this.app.world.structures.boxes.listed || [];
        lights.forEach((l, i) => boxes.forEach((b, j) => {
            const e = Math.hypot(b.hx, b.hz), sl = Math.abs(b.slope) * b.hx;
            if (Math.hypot(b.x - l.pos[0], b.z - l.pos[2]) > l.range + e) return;
            if (l.pos[1] - l.range > b.y1 + sl || l.pos[1] + l.range < b.y0 - sl) return;
            if (!b.enclosed && ShelterBoxes.contains(b, l.pos)) return;
            mask[i * 4 + (j >> 5)] |= 1 << (j & 31);
        }));
    }

    // the lit storeys of the buildings within ROOM_RANGE of the camera (the InteriorIndex, not every building), nearest
    // first, at most ROOM_LIGHTS: each a light under its ceiling as wide as the room (LAMPS.room), that the building's
    // shell lets out only through its windows and open doors (lightSeen); its own surfaces have their lamps (LIGHT_ROOM).
    // Lit as storeyLit in WGSL picks them
    roomLights(B, cam, out) {
        const L = LAMPS.room, near = [];
        for (const it of B.S.interiors.near(cam, ROOM_RANGE, 'building')) {
            const b = it.owner, d = Math.hypot(b.centre[0] - cam[0], b.centre[2] - cam[2]);
            if (d < ROOM_RANGE) near.push([d, b]);
        }
        near.sort((p, q) => p[0] - q[0] || p[1].id - q[1].id);
        let n = 0;
        // each building's storeys outward from the camera's height (of a tower's thousand storeys, those near it)
        for (const [, b] of near) {
            const s0 = clamp(Math.floor((cam[1] - b.floor) / b.H), 0, b.n - 1);
            for (let d = 0; d < b.n && n < ROOM_LIGHTS && d * b.H <= ROOM_RANGE; d++) for (const s of d ? [s0 - d, s0 + d] : [s0]) {
                if (s < 0 || s >= b.n || n >= ROOM_LIGHTS || pcgRandom(b.id * 131 + s * 7 + 3) >= Buildings.litShare(b, s)) continue;
                out.push({ pos: b.f.at(0, b.floor + (s + 1) * b.H - 0.5, 0), dir: [0, -1, 0], color: L.color, intensity: L.intensity,
                    range: Math.max(b.hx, b.hz) + L.range, size: L.size * Math.min(b.hx, b.hz), room: true });
                n++;
            }
        }
    }

    // their lamps that can reach within LIGHT_RANGE of the camera, in the order they were built: from a GridHash over them
    // (rebuilt only when lamps are added), so the frame visits the cells near the camera, not every lamp
    nearLamps(lights, cam) {
        if (this.lampCount !== lights.length) {
            this.lampCount = lights.length;
            this.lampGrid = new GridHash(256);
            this.lampReach = 0;
            lights.forEach((l, i) => { l.seq = i; this.lampReach = Math.max(this.lampReach, l.range); this.lampGrid.insert(l, l.pos[0], l.pos[2], l.pos[0], l.pos[2]); });
        }
        const out = [], R = LIGHT_RANGE + this.lampReach;
        this.lampGrid.each(cam[0] - R, cam[2] - R, cam[0] + R, cam[2] + R, l => out.push(l));
        return out.sort((p, q) => p.seq - q.seq);
    }

    // the fake street lamps' poles within POLE_DRAW (vsFarPole), day and night: re-listed when the camera has moved 20 m
    writePoles() {
        const a = this.app, R = a.renderer.ext.structures, cam = a.camera.pos, last = this.poleAt;
        if (last && Math.hypot(cam[0] - last[0], cam[2] - last[2]) < 20 && R.poleWorld === a.world) return;
        this.poleAt = [...cam];
        R.poleWorld = a.world;
        const near = a.world.far.near(cam, POLE_DRAW + 20, []).slice(0, MAX_POLES);
        const data = this.poleData;
        near.forEach((l, i) => data.set(l.pole, i * 8));
        if (near.length) a.renderer.device.queue.writeBuffer(R.poleBuf, 0, data, 0, near.length * 8);
        R.poleCount = near.length;
    }

    // the distant lights by night (WGSL_FAR, cityGlow): the static ones, the lights of what moves into the slots after
    // them (AppExtension.farLights: the buses'), the light-pollution domes into the frame; none by day
    writeFar(F, night, adapt) {
        const a = this.app, R = a.renderer.ext.structures, w = a.world;
        this.writePoles();
        if (!night) { R.farCount = 0; F.set('glowInfo', [0, 0, 0, 0]); return; }
        // as many as there are slots: it stops there, however many there are
        const bl = [];
        for (const x of a.extensions) x.farLights?.(bl, MAX_FAR_DYN);
        const n = Math.min(bl.length, MAX_FAR_DYN), dyn = this.farDyn;
        bl.slice(0, n).forEach((l, i) => dyn.set([...l.pos, l.size ?? 0.5, ...l.color.map(c => c * l.intensity), 0, ...l.dir, l.cone ? l.cone[0] : -2,
            l.cone ? l.cone[1] : 1, l.range, l.pos[1], 0], i * FAR_FLOATS));
        if (n) a.renderer.device.queue.writeBuffer(R.farBuf, R.farStatic * FAR_FLOATS * 4, dyn, 0, n * FAR_FLOATS);
        R.farCount = R.farStatic + n;
        F.set('glows', w.far.glows.flat());
        F.set('glowInfo', [w.far.glows.length, GLOW_GAIN / Math.PI * adapt, 0, 0]);
    }
}

return { extensions: { world: StructuresWorld, app: StructuresApp, renderer: kit.StructuresRenderer } };
});
