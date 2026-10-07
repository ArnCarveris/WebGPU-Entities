'use strict';
// The phone pages (js/engine/handheld.js): the readout, runtime, lighting and bake options of the imposter world.

Features.part('imposter', (engine, feature) => {
const { kits } = engine;
const { Pages } = kits.world;
const { LOD_MODES, ATLAS_VIEWS, CASCADES, GRID_CHOICES, RES_CHOICES } = feature;

// the readout and every control, on the engine's handheld (js/engine/handheld.js)
function phonePages(g) {
    const st = g.settings, L = g.lighting, w = g.world, P = g.panel;
    if (!st) return [];
    const set = k => v => g.set(k, v);
    const names = w ? w.list.filter(a => a.asset.settings.enabled).map(a => a.name) : [];
    const a = w && w.archetypes.get(st.focus), at = a && a.asset.atlas;
    const pick = (list, k) => ({ options: list.map(String), index: list.indexOf(P.bake[k]), pick: i => { P.bake[k] = list[i]; } });
    return [
        Pages.status('Frame, LOD, models and atlases', [[52, 199, 89], 'I'], g.hud),
        { id: 'runtime', title: 'Runtime', sub: `LOD ${st.lodMode} · ${st.lodDistance.toFixed(0)} m · shadows ${st.shadows ? 'on' : 'off'}`, icon: [[0, 122, 255], 'R'], sections: [
            { header: 'LOD', cells: [
                { choice: 'LOD', options: LOD_MODES, index: LOD_MODES.indexOf(st.lodMode), pick: i => g.set('lodMode', LOD_MODES[i]) },
                { slider: 'LOD distance', value: st.lodDistance, min: 2, max: 300, fmt: v => `${v.toFixed(0)} m`, set: v => g.set('lodDistance', Math.round(v)) },
                { slider: 'Fade band', value: st.fade, min: 0, max: 0.8, fmt: v => v.toFixed(2), set: set('fade') },
                { slider: 'Far', value: st.far, min: 100, max: 3000, fmt: v => `${v.toFixed(0)} m`, set: v => g.set('far', Math.round(v / 10) * 10) }] },
            { header: 'IMPOSTERS', cells: [
                { toggle: 'Blend 3 frames', on: st.blend, set: set('blend') },
                { toggle: 'Depth parallax', on: st.parallax, set: set('parallax') },
                { toggle: 'Pixel depth offset', on: st.depthOffset, set: set('depthOffset') },
                { toggle: 'LOD tint + billboards', on: st.tint, set: set('tint') },
                { choice: 'Atlas view', options: ATLAS_VIEWS, index: ATLAS_VIEWS.indexOf(st.atlasView), pick: i => g.set('atlasView', ATLAS_VIEWS[i]) }] },
            { header: 'SHADOWS', cells: [
                { toggle: `${CASCADES} cascades`, key: 'shadows', on: st.shadows, set: set('shadows') },
                { slider: 'Distance', value: st.shadowDistance, min: 40, max: 2500, fmt: v => `${v.toFixed(0)} m`, set: v => g.set('shadowDistance', Math.round(v / 10) * 10) },
                { toggle: 'Tint by cascade', on: st.cascadeTint, set: set('cascadeTint') }] },
        ] },
        { id: 'lighting', title: 'Lighting', sub: `${L.name} · never rebakes`, icon: [[255, 149, 0], 'L'], sections: [
            { cells: [
                { choice: 'Preset', options: L.names, index: L.names.indexOf(L.name), pick: i => g.relight('preset', L.names[i]) },
                { slider: 'Sun azimuth', value: L.target.azimuth, min: 0, max: 360, fmt: v => `${v.toFixed(0)}°`, set: v => g.relight('azimuth', v) },
                { slider: 'Sun elevation', value: L.target.elevation, min: 2, max: 90, fmt: v => `${v.toFixed(0)}°`, set: v => g.relight('elevation', v) },
                { slider: 'Lights', value: L.target.emission, min: 0, max: 2, fmt: v => v.toFixed(2), set: v => g.relight('emission', v) }],
              footer: 'Runtime only: the atlases keep their bake.' }] },
        { id: 'bake', title: 'Bake', sub: st.focus || 'no model', icon: [[175, 82, 222], 'B'], sections: [
            { cells: [
                names.length && { choice: 'Model', options: names, index: names.indexOf(st.focus), pick: i => g.set('focus', names[i]) },
                { choice: 'Frames', ...pick(GRID_CHOICES, 'grid'), value: P.bake.grid },
                { choice: 'Resolution', ...pick(RES_CHOICES, 'res'), value: P.bake.res },
                { choice: 'Hemisphere', ...pick(['hemi', 'full'], 'mode'), value: P.bake.mode },
                { action: g.baking ? 'Baking…' : 'Rebake', run: () => g.action('rebake') },
                at && { label: '', value: `${at.grid * at.res}px atlas, ${at.levels} mips, ${a.asset.mesh.triangles} tris, baked in ${at.bakeMs.toFixed(0)} ms` }] },
            { header: 'DATA', cells: [
                { action: 'Load model / scenario…', run: () => g.action('load') },
                { action: 'Export scenario JSON', run: () => g.action('export') },
                { action: 'Reset camera', run: () => g.onKey('KeyR') }],
              footer: 'Drop a .glb / .gltf / .obj on the page to bake it.' }] },
    ];
}

return { phonePages };
});
