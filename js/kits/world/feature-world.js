'use strict';
// The base of every feature's adapter to the host (FeatureWorld, js/engine/host.js).

Features.kit('world', (engine, kit) => {
const { v3 } = engine.Common;
// One world of a feature, as the host runs it. A feature extends this with createApp() (its engine: an App or Game with
// start(), frame(now, dt, opts), and load(native) when it takes its scenario after starting) and what else the host
// asks of it: depth(), stats(), handheld(), set(key, v), anchor(id), drop(files), ground(p), sheltered(p), views(). The host reads and moves the
// camera through view / setView, and walks or flies it through moves / move / setMove; all go to the app's camera (a
// FirstPersonView: kits.view) unless the feature overrides them.
class FeatureWorld {
    constructor(fx, hudHtml = '') {
        this.fx = fx;
        this.hudHtml = hudHtml;
    }

    createApp(fx) { throw new Error(`${this.constructor.name}: no createApp()`); }

    async init() {
        const app = this.app = this.createApp(this.fx);
        await app.start();
        if (app.load) app.load(this.fx.native);
    }

    frame(now, dt, opts) { this.app.frame(now, dt, opts); }

    // { pos, fwd, up, fov (radians) } in the world's frame
    get view() { return this.app.camera.view; }
    setView(v) { this.app.camera.setView(v); }

    // Walking and flying, the engine's to switch (Host.setMove): the modes this world's camera has, the one it is in, and
    // switching it. By default its app's camera, a FirstPersonView, which walks on fx.floor (every shown world's ground).
    get moves() { return this.app?.camera?.setMode ? ['fly', 'walk'] : ['fly']; }
    get move() { return this.app?.camera?.mode || 'fly'; }
    setMove(mode) { this.app.camera.setMode(mode); }

    // the viewpoints this world offers (the engine's View list, Host.viewList): [{ name, sub (a live line), go() }], from
    // its scenario's view entities; a view that follows an entity with `each` is one per member of it (Entity.members).
    // By default its native `views` ({ name, pos, look, fov (degrees) } in its frame), each moving the camera there.
    views() {
        return (this.fx.native?.views || []).map((v, i) => ({ key: i, name: v.name || `view ${i + 1}`, go: () => this.setView(FeatureWorld.lookFrom(v)) }));
    }

    // the ground under p (this world's frame): the height of the highest thing to stand on at or below p[1] (null: none
    // here). The engine walks its camera on the highest ground of every shown world (Host.floorAt).
    ground(p) { return null; }

    // the interior (kits.interior) that shelters p (this world's frame) from the weather, or null. The engine keeps an
    // atmosphere world's rain and snow off the camera while any other shown world's interior holds it (Host.shelter)
    sheltered(p) { return null; }
}

// a view entity { pos, look, fov (degrees) } as a view { pos, fwd, up, fov (radians) }
FeatureWorld.lookFrom = v => {
    const pos = [...(v.pos || [0, 2, 0])], fwd = v3.norm(v3.sub(v.look || [pos[0], pos[1], pos[2] - 1], pos));
    const up = v3.cross(v3.norm(v3.cross(fwd, [0, 1, 0])), fwd);
    return v.fov ? { pos, fwd, up, fov: v.fov * Math.PI / 180 } : { pos, fwd, up };
};

// the HUD elements a world can ask for in its hudHtml: in-world labels (LabelLayer), toasts (Toast), a crosshair
FeatureWorld.HUD = {
    labels: '<canvas class="labels" data-hud="labels"></canvas>',
    toast: '<div data-hud="toast" class="panel"></div>',
    crosshair: '<div data-hud="crosshair"></div>',
};

return { FeatureWorld };
});
