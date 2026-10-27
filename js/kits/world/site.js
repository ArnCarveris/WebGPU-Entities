'use strict';
// A site's adapter to the host (Site, js/engine/host.js): defaults, composed with its kit's world type's own hooks.

Features.kit('world', (engine, kit) => {
const { v3 } = engine.Common;
const { Outdoors } = kit;
// The hooks the host asks of a site, kept beside the one App (a scenario of one site: app.attach('site', Site, fx, spec),
// app.ext.site; of several: one per site, each on its kit's scope of the App), composed, not derived. Its kit gives it a
// spec ({ spec } of its site parts): { hud (the HUD elements it asks for: Site.HUD), app(app, fx) (extends the App with
// its AppExtension: start(), frame(now, dt, opts), and load(native) when it takes its scenario after starting) } and
// whichever hooks the host asks of it it has: stats(), handheld(), set(key, v), anchor(id), drop(files), ground(p),
// sheltered(p), outdoors(p), sunlight(), veil(p, dir, d), footprint(), makesRoom, views(), inspector; view / setView,
// moves / move / setMove. Its hooks (methods and getters, `this` the site: this.app, this.fx) go over the defaults
// here, which read and move the camera through the app's (a FirstPersonView: kits.view).
class Site {
    constructor(app, fx, spec = {}) {
        this.app = app;
        this.fx = fx;
        this.hudHtml = spec.hud || '';
        this.makeApp = spec.app;
        // (as descriptors: its getters stay getters, read when the host asks)
        const hooks = Object.getOwnPropertyDescriptors(spec);
        delete hooks.hud;
        delete hooks.app;
        Object.defineProperties(this, hooks);
    }

    async init() {
        if (!this.makeApp) throw new Error('a site with no app');
        this.makeApp(this.app, this.fx);
        await this.app.start();
        if (this.app.load) this.app.load(this.fx.native);
    }

    frame(now, dt, opts) { this.app.frame(now, dt, opts); }

    // { pos, fwd, up, fov (radians) } in the world's frame
    get view() { return this.app.camera.view; }
    setView(v) { this.app.camera.setView(v); }

    // Walking and flying, the engine's to switch (Host.setMove): the modes this world's camera has, the one it is in, and
    // switching it. By default its app's camera, a FirstPersonView, which walks on fx.floor (every world's ground).
    get moves() { return this.app?.camera?.setMode ? ['fly', 'walk'] : ['fly']; }
    get move() { return this.app?.camera?.mode || 'fly'; }
    setMove(mode) { this.app.camera.setMode(mode); }

    // the keys there are in it, for the engine's toast (Host.keyHelp): [keys, what they do]. Only what has no other way
    // has a key (moving, looking, using what is at hand); every other option is the handheld's. By default its app's
    // camera's, a FirstPersonView, flying or walking
    get keys() { return this.move === 'walk' ? Site.WALK_KEYS : Site.FLY_KEYS; }

    // the viewpoints this world offers (the engine's View list, Host.viewList): [{ name, sub (a live line), go() }], from
    // its scenario's view entities; a view that follows an entity with `each` is one per member of it (Entity.members).
    // By default its native `views` ({ name, pos, look, fov (degrees) } in its frame), each moving the camera there.
    views() {
        return (this.fx.native?.views || []).map((v, i) => ({ key: i, name: v.name || `view ${i + 1}`, go: () => this.setView(Site.lookFrom(v)) }));
    }

    // the ground under p (this world's frame): the height of the highest thing to stand on at or below p[1] (null: none
    // here). The engine walks its camera on the highest ground of every world (Host.floorAt).
    ground(p) { return null; }

    // a world built of areas and portals: its visibility inspector (kits.interior VisInspector: the floor map, the portal
    // traversal, culling and freeze, the sector and portal frames), whose pages the engine's handheld shows; null: none
    get inspector() { return null; }

    // the interior (kits.interior) that shelters p (this site's frame) from the weather, or null. While one holds the
    // camera, the camera is inside for the whole world (Host.shelter: world.shelter): an atmosphere keeps its rain and
    // snow off it, and the other sites see the outdoors only as this one does (outdoors(p))
    sheltered(p) { return null; }

    // what of the outdoors the camera at p (this world's frame, inside one of its interiors) sees from there (Outdoors:
    // null, all of it, or { seen, rect }): what its portal traversal passed out to (its inspector's, VisInspector.outdoors),
    // or, an interior with no traversal, nothing
    outdoors(p) { const I = this.inspector; return I ? I.outdoors() : Outdoors.SEALED; }

    // the ground it covers, its own frame: { lo: [x, z], hi: [x, z], floor (its lowest ground's height), ground (true: its
    // own ground reaches its edges, a terrain; false: it stands on a floor, a building), albedo ([r, g, b], optional: its
    // ground's colour from afar) }, or null (none). An atmosphere's site makes room under it in its own terrain
    // (Host.footprintsIn, fx.footprints); a planet it stands on takes its albedo there (the origin's bodies: covers)
    footprint() { return null; }

    // the clouds it makes, its own frame: { coverage, base, top (its cloud layer's, m), wind ([x, z], m/s), storms: [{
    // hurricane: 12 floats (the weather kit's hurricaneData) } | { cell: { x, z, radius, top, coverage, seed } }], air (how
    // much of them it draws itself about the eye, 0 .. 1), reach (m: out to where) }, or null (none). A planet it stands
    // on draws them over its ground beyond that (the origin's bodies: their clouds), so they are seen from space
    clouds() { return null; }

    // how much of a point d m from p along dir (unit; p and dir in this site's frame) this site hides from an eye at p:
    // 0 .. 1 (an atmosphere's air: its daytime sky hides what is in space). The in-world labels fade by it (Host.veilOf,
    // fx.ui.veil)
    veil(p, dir, d) { return 0; }
}

// a view entity { pos, look, fov (degrees) } as a view { pos, fwd, up, fov (radians) }
Site.lookFrom = v => {
    const pos = [...(v.pos || [0, 2, 0])], fwd = v3.norm(v3.sub(v.look || [pos[0], pos[1], pos[2] - 1], pos));
    const up = v3.cross(v3.norm(v3.cross(fwd, [0, 1, 0])), fwd);
    return v.fov ? { pos, fwd, up, fov: v.fov * Math.PI / 180 } : { pos, fwd, up };
};

// a FirstPersonView's keys (kits.view), flying and walking: every world's the same. Flying, dragging looks; walking, a
// click takes the mouse to look (Host: pointer lock), Esc gives it back
Site.LOOK_KEYS = { fly: ['drag', 'look'], walk: ['click', 'look (Esc frees the mouse)'] };
Site.FLY_KEYS = [Site.LOOK_KEYS.fly, ['WASD', 'move'], ['Space / C', 'up / down'], ['Shift', 'fast'], ['wheel', 'speed']];
Site.WALK_KEYS = [Site.LOOK_KEYS.walk, ['WASD', 'walk'], ['Shift', 'run']];

// the HUD elements a world can ask for in its hudHtml: in-world labels (LabelLayer), toasts (Toast), a crosshair
Site.HUD = {
    labels: '<canvas class="labels" data-hud="labels"></canvas>',
    toast: '<div data-hud="toast" class="panel"></div>',
    crosshair: '<div data-hud="crosshair"></div>',
};

return { Site };
});
