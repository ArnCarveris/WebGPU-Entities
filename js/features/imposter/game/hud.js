'use strict';
// The HUD and the control panel.

Features.part('imposter', (engine, feature) => {
const { Common, kits } = engine;
const { fmtK } = Common;

// The screen keeps toasts; the readout (lines) and every control are on the engine's handheld (FeatureWorld.handheld)
class Hud extends kits.world.WorldHud {
    constructor(game) {
        super(game.ui);
        this.game = game;
        this.next = 0;
        this.frames = 0;
        this.prev = 0;
        this.fps = 0;
    }

    update(now) {
        this.frames++;
        if (now < this.next) return;
        this.fps = this.frames * 1000 / Math.max(1, now - this.prev);
        this.frames = 0;
        this.prev = now;
        this.next = now + 250;
        const g = this.game, st = g.settings, w = g.world, on = (b, s) => `<span class="${b ? 'on' : 'off'}">${s}</span>`;
        const L = [`<span class="t">ENTITY IMPOSTER // ${(w ? w.sc.name || 'scenario' : 'loading').toUpperCase()}</span>`,
            `fps ${this.fps.toFixed(0).padStart(3)}  cpu ${g.cpuMs.toFixed(2)} ms  pos ${g.camera.pos.map(x => x.toFixed(0)).join(' ')}`
                + (g.renderer.gpuTimes ? `  gpu cull ${g.renderer.gpuTimes.cull.toFixed(2)} shadow ${g.renderer.gpuTimes.shadow ? g.renderer.gpuTimes.shadow.map(x => x.toFixed(2)).join('/') : '-'} main ${g.renderer.gpuTimes.main.toFixed(2)} ms` : ''),
            `lod <span class="w">${st.lodMode.toUpperCase()}</span> ${st.lodDistance.toFixed(0)} m/5m radius  ${on(st.blend, 'blend')} ${on(st.parallax, 'parallax')} ${on(st.depthOffset, 'depth')} ${on(st.tint, 'tint')}`,
            `light <span class="w">${g.lighting.name.toUpperCase()}</span> sun ${g.lighting.env.azimuth.toFixed(0)}/${g.lighting.env.elevation.toFixed(0)} deg  relights ${g.lighting.changes}  atlas bakes ${g.bakes} <span class="${g.bakesAfterRelight ? 'w' : 'on'}">(${g.bakesAfterRelight} after relighting)</span>`, ''];
        if (w) {
            L.push('<span class="muted">MODEL            INST   MESH    IMP  SHADOW   TRIS/INST  ATLAS</span>');
            let drawn = 0, all = 0, mem = 0, shadowTris = 0;
            const ground = { n: 0, m: 0, cast: 0, tris: 0, casts: false };
            for (const a of w.list) {
                const t = a.asset.mesh.triangles, at = a.asset.atlas, [m, i] = a.visible, [cm, ci] = a.casters;
                drawn += m * t + i * 2;
                shadowTris += cm * t + ci * 2;
                all += (m + i) * t;
                if (a.asset.kind === 'generated') {              // terrain chunks: one row
                    ground.n++; ground.m += m; ground.cast += cm; ground.tris += t; ground.casts ||= a.asset.castShadows;
                    continue;
                }
                if (at) mem += at.bytes;
                const atlas = at ? `${at.grid}x${at.grid}@${at.res} ${at.full ? 'full' : 'hemi'} ${at.layers}L ${(at.bytes / 1048576).toFixed(0)}MB` : '<span class="off">none</span>';
                const name = a.name.replace(/^terrain:.*/, 'terrain').slice(0, 15);
                const cast = a.asset.castShadows && st.shadows ? String(cm + ci) : '-';
                L.push(`${(a.name === st.focus ? '<span class="w">' + name.padEnd(15) + '</span>' : name.padEnd(15))} ${String(a.count).padStart(5)} ${String(m).padStart(6)} ${String(i).padStart(6)} ${cast.padStart(7)} ${fmtK(t).padStart(11)}  ${atlas}`);
            }
            if (ground.n) L.splice(L.length - w.list.length + ground.n, 0,
                `${'terrain'.padEnd(15)} ${String(ground.n).padStart(5)} ${String(ground.m).padStart(6)} ${'0'.padStart(6)} ${(ground.casts && st.shadows ? String(ground.cast) : '-').padStart(7)} ${fmtK(ground.tris).padStart(11)}  <span class="off">${ground.n} chunks</span>`);
            L.push('', `triangles drawn ${fmtK(drawn)}  <span class="muted">(all as mesh: ${fmtK(all)})</span>  shadows ${st.shadows ? fmtK(shadowTris) : 'off'}  atlases ${(mem / 1048576).toFixed(0)} MB`);
            const f = g.focusInfo;
            if (f) L.push(`focus ${f.name}: frames ${f.sel.cells.map((c, k) => `(${c[0]},${c[1]}) ${f.sel.w[k].toFixed(2)}`).join('  ')}`);
            if (w.warnings.length) L.push(`<span class="d">${w.warnings.length} warning(s), see console</span>`);
        }
        this.lines = L;
    }
}

// What the bake controls are set to (the handheld's Bake page): they follow the focused model
class ControlPanel {
    constructor(game) {
        this.game = game;
        this.bake = { grid: 8, res: 256, mode: 'hemi' };
        this.focus = null;
    }

    sync() {
        const g = this.game, st = g.settings, a = g.world && g.world.archetypes.get(st.focus), s = a && a.asset.settings;
        if (s && s.enabled && st.focus !== this.focus) { this.focus = st.focus; this.bake = { grid: s.grid, res: s.res, mode: s.mode }; }
    }

    bakeSettings() {
        return { ...this.bake };
    }
}

return { Hud, ControlPanel };
});
