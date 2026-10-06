'use strict';
// Entity Imposter, as a feature of WebGPU Entities: octahedral imposters for any 3D model or scene, light-agnostic
// G-buffer atlases, GPU LOD selection and cascaded shadows. The engine is the one from the WebGPU-EntityImposter demo;
// the host (js/engine/host.js) gives it its device, canvas target, input and HUD root, and builds its scenario from
// entities ("imposter.*", see js/engine/scenario-format.js).
//
// This file: the feature's adapter to the host (FeatureWorld). The engine's parts load before it, in the order of
// Features.PARTS.imposter (js/engine/features.js).
//
// Entity Imposter // WebGPU
//
// Octahedral imposters for any model or scene. Every model is baked once into an atlas of N x N views
// (albedo + coverage, normal + depth) taken around an octahedron (full sphere) or hemi-octahedron (upper
// half). At runtime a camera-facing quad per instance picks the three frames nearest the view direction,
// reprojects every pixel's view ray into each frame (with depth parallax), blends them, relights with the
// baked normals and writes the reconstructed depth. A compute pass culls every instance and splits it
// into a mesh list and an imposter list (with a dithered cross-fade band) that feed indirect draws, plus
// caster lists for 4 cascaded shadow maps, into which imposters render their reconstructed depth.
//
// Sections: config, math, noise, octahedral mapping | textures, materials, geometry, models, loaders |
// WGSL, GPU mesh, baker, renderer | archetypes, entities, world | camera, input, HUD, panel, game | main

Features.part('imposter', (engine, feature) => {
const { Common } = engine;
const { DEG, clamp, v3, yawPitch } = Common;
const { MSAA, CASCADES, LOD_MODES, ATLAS_VIEWS, GRID_CHOICES, RES_CHOICES, Game, phonePages } = feature;

// This demo as one world of the engine (js/engine/host.js calls these).
const HUD_HTML = `<div data-hud="toast" class="panel"></div>
    <input data-hud="file" type="file" multiple accept=".glb,.gltf,.bin,.obj,.mtl,.json,.png,.jpg,.jpeg,.webp" hidden>`;

class FeatureWorld {
    constructor(fx) {
        this.fx = fx;
        this.hudHtml = HUD_HTML;
    }

    async init() {
        this.game = new Game(this.fx);
        await this.game.start();
    }

    frame(now, dt, opts) { this.game.frame(now, dt, opts); }

    // dropped models (the engine keeps scenario .json drops)
    drop(files) { this.game.loadFiles(files); }

    // reversed-Z, infinite far plane, 4x MSAA, metres
    depth() {
        const r = this.game.renderer;
        return r.depthView && { view: r.depthView, kind: 'reversed', near: 0.1, samples: MSAA };
    }

    get view() {
        const c = this.game.camera, fwd = c.forward(), right = c.right();
        return { pos: [...c.pos], fwd, up: v3.cross(right, fwd), fov: c.fov * DEG };
    }

    setView(v) {
        const c = this.game.camera;
        c.pos = [...v.pos];
        Object.assign(c, yawPitch(v.fwd));
        if (v.fov) c.fov = v.fov / DEG;
    }

    stats() {
        const g = this.game, st = g.settings, w = g.world, cam = g.camera.pos;
        let inst = 0, meshes = 0, imposters = 0;
        if (w) for (const a of w.list) { inst += a.count; meshes += a.visible[0]; imposters += a.visible[1]; }
        return {
            name: w ? w.sc.name : '', fps: g.hud.fps, loading: g.loading, baking: g.baking, bakes: g.bakes,
            lod: st.lodMode, lodDistance: st.lodDistance, shadows: st.shadows, light: g.lighting.name,
            instances: inst, meshes, imposters, height: w ? cam[1] - w.heightAt(cam[0], cam[2]) : 0,
        };
    }

    // the readout and every control, on the engine's handheld (js/engine/handheld.js)
    handheld() { return phonePages(this.game); }

    set(key, v) {
        const g = this.game;
        if (key === 'light' && g.lighting.names.includes(v) && v !== g.lighting.name) g.relight('preset', v);
        else if (key === 'lod' && LOD_MODES.includes(v)) g.set('lodMode', v);
        else if (key === 'shadows') g.set('shadows', !!v);
        else if (key === 'sunDir' && Array.isArray(v)) {
            // a direction in this world's frame (another world's sun, through a link): the sun's azimuth and elevation
            const d = v3.norm(v), el = Math.asin(clamp(d[1], -1, 1)) / DEG, az = (Math.atan2(d[0], d[2]) / DEG + 360) % 360;
            g.lighting.tweak('azimuth', az);
            g.lighting.tweak('elevation', Math.max(el, 2));
        }
    }
}

return { create: ctx => new FeatureWorld(ctx) };
});
