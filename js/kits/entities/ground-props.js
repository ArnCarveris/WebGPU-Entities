'use strict';
// Props standing on a world's ground: single models, mesh-vs-imposter comparisons and seeded scatters.

Features.kit('entities', (engine, kit) => {
const { Common, kits } = engine;
const { DEG, lerp, quat } = Common;
const { seededRandom } = kits.noise;
const { spinQuat } = kit;

// The ground props over a world's own entity base (Base). They draw through the world's meshes (the common mesh
// interface, kits.mesh: instance(model, { pos, q, scale }, { lod }) -> set(pose), rotation(rot)). Their world has
// heightAt(x, z), terrain (contains, slope; or null), occupy(x, z, r) / occupied(x, z, r) (footprints) and
// warnings.
function groundProps(Base) {
    // A model at pos (y above the ground unless `absolute`), rot (degrees), scale; `lod` forces mesh / imposter;
    // `spin` { axis, speed (deg/s) | rpm } turns it; `footprint` keeps scatters away
    class Prop extends Base {
        spawn() {
            const e = this.def, w = this.world, p = e.pos || [0, 0, 0];
            this.base = [p[0], p[1] + (e.absolute ? 0 : w.heightAt(p[0], p[2])), p[2]];
            this.rot0 = w.meshes.rotation(e.rot);
            this.scale = e.scale ?? 1;
            this.inst = w.meshes.instance(e.model, { pos: this.base, q: this.rot0, scale: this.scale }, { lod: e.lod });
            if (e.footprint) w.occupy(p[0], p[2], e.footprint);
        }

        spinRot(t) {
            const s = this.def.spin;
            return s ? spinQuat(quat, this.rot0, s, t, { speed: 20 }) : this.rot0;
        }

        update(dt, t) { if (this.def.spin) this.inst.set({ pos: this.base, q: this.spinRot(t), scale: this.scale }); }
    }

    // The same model twice, `gap` metres apart along x: forced mesh on the left, forced imposter on the right
    class Compare extends Prop {
        spawn() {
            const e = this.def, w = this.world, p = e.pos || [0, 0, 0], gap = e.gap ?? 12;
            this.rot0 = w.meshes.rotation(e.rot);
            this.scale = e.scale ?? 1;
            this.slots = [[-gap / 2, 'mesh'], [gap / 2, 'imposter']].map(([dx, lod]) => {
                const x = p[0] + dx, z = p[2], pos = [x, p[1] + w.heightAt(x, z), z];
                if (e.footprint) w.occupy(x, z, e.footprint);
                return { pos, inst: w.meshes.instance(e.model, { pos, q: this.rot0, scale: this.scale }, { lod }) };
            });
        }

        update(dt, t) {
            if (!this.def.spin) return;
            const q = this.spinRot(t);
            for (const s of this.slots) s.inst.set({ pos: s.pos, q, scale: this.scale });
        }
    }

    // `count` copies in the ring inner..outer around `center` [x, z], random yaw, scale in `scale` [min, max],
    // optional `tilt` (degrees), sunk `sink` metres; darts closer than `spacing` * scale to anything are rejected,
    // and so are ground steeper than `maxSlope` (1 - normal.y) or higher than `maxHeight` (treeline)
    class Scatter extends Base {
        spawn() {
            const e = this.def, w = this.world, rnd = seededRandom(e.seed ?? 1);
            const [cx, cz] = e.center || [0, 0], inner = e.inner ?? 0, outer = e.outer ?? 100, count = e.count ?? 100;
            const [s0, s1] = Array.isArray(e.scale) ? e.scale : [e.scale ?? 1, e.scale ?? 1], spacing = e.spacing ?? 2, sink = e.sink ?? 0.15;
            let placed = 0;
            for (let tries = 0; placed < count && tries < count * 12; tries++) {
                const a = rnd() * Math.PI * 2, r = Math.sqrt(lerp(inner * inner, outer * outer, rnd()));
                const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r, s = lerp(s0, s1, rnd()), yaw = rnd() * Math.PI * 2;
                const tilt = e.tilt ? quat.axisAngle([rnd() - 0.5, 0, rnd() - 0.5], e.tilt * DEG * rnd()) : null;
                if (w.terrain && !w.terrain.contains(x, z, spacing * s)) continue;
                if (e.maxHeight !== undefined && w.heightAt(x, z) > e.maxHeight) continue;
                if (e.maxSlope !== undefined && w.terrain && w.terrain.slope(x, z) > e.maxSlope) continue;
                if (w.occupied(x, z, spacing * s)) continue;
                w.occupy(x, z, spacing * s);
                let q = quat.axisAngle([0, 1, 0], yaw);
                if (tilt) q = quat.mul(tilt, q);
                w.meshes.instance(e.model, { pos: [x, w.heightAt(x, z) - sink * s, z], q, scale: s });
                placed++;
            }
            if (placed < count) w.warnings.push(`scatter "${e.id || e.model}": placed ${placed} of ${count}`);
        }
    }

    return { Prop, Compare, Scatter };
}

return { groundProps };
});
