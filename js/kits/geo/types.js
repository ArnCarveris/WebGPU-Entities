'use strict';
// A real place as entities (its data: tools/geo-import.mjs): the ground, the roads, the buildings and the place names,
// over a world's own entity base (a kits.terrain TerrainEntity on a field with paint / wet, building into Structures).

Features.kit('geo', (engine, kit) => {
const { Common } = engine;
const { clamp, lerp } = Common;
const { terrainData, roadData, buildingData, buildRoads, buildBuildings } = kit;

function geoTypes(Base) {
    // The ground of `data` (a geo terrain id): its heights, and its land cover painted (built-up, woods, water). On a
    // field of the data's size and resolution cell for cell, else sampled bilinearly. It sets the heights: the stamps
    // after it shape them further.
    class GeoTerrain extends Base {
        get anchor() { return null; }

        stamp(f) {
            const T = terrainData(this.def.data), n = T.n, same = n === f.n && Math.abs(T.size - f.size) < 1e-3;
            const cell = T.size / n, o = -T.size / 2;
            const at = (arr, x, z, scale = 1) => {
                const fx = clamp((x - o) / cell - 0.5, 0, n - 1), fz = clamp((z - o) / cell - 0.5, 0, n - 1);
                const i = Math.min(Math.floor(fx), n - 2), j = Math.min(Math.floor(fz), n - 2), tx = fx - i, tz = fz - j;
                return lerp(lerp(arr[j * n + i], arr[j * n + i + 1], tx), lerp(arr[(j + 1) * n + i], arr[(j + 1) * n + i + 1], tx), tz) * scale;
            };
            f.eachAll((idx, x, z) => {
                f.h[idx] = same ? T.heights[idx] : at(T.heights, x, z);
                for (let c = 0; c < 3; c++) {
                    const v = same ? T.planes[c][idx] / 255 : at(T.planes[c], x, z, 1 / 255);
                    if (v <= 0) continue;
                    if (c === 2) f.wet(idx, v); else f.paint(idx, c, v);
                }
            });
        }
    }

    // The roads of `data` (a geo roads id): skip (highway classes left out), minor (driveways, parking aisles), curves,
    // marks (the geo kit's buildRoads)
    class GeoRoads extends Base {
        get anchor() { return null; }
        build(S) {
            const t0 = performance.now();
            this.stats = buildRoads(S, roadData(this.def.data), this.def);
            console.info(`geoRoads ${this.def.data}: ${this.stats.roads} roads (${this.stats.km.toFixed(0)} km, ${this.stats.bridges} bridges) in ${(performance.now() - t0).toFixed(0)} ms`);
        }
    }

    // The buildings of `data` (a geo buildings id) (the geo kit's buildBuildings)
    class GeoBuildings extends Base {
        get anchor() { return null; }
        build(S) {
            const t0 = performance.now();
            this.stats = buildBuildings(S, buildingData(this.def.data), this.def);
            console.info(`geoBuildings ${this.def.data}: ${this.stats.buildings} buildings (${this.stats.houses} hipped roofs) in ${(performance.now() - t0).toFixed(0)} ms`);
        }
    }

    // A named place: its label `labelHeight` m over the ground at pos, shown within `range` m of the eye (0: always)
    class Place extends Base {
        get labelRange() { return this.def.range || 0; }
    }

    // The place names of `data` (a geo terrain id) as Place entities: those of `kinds` ({ kind: range (m) }; the data's
    // kinds: city, town, village, suburb, hamlet, neighbourhood, quarter, island, islet, peak, cape, bay, attraction,
    // viewpoint), each `height` m over the ground (or { kind: m })
    class GeoPlaces extends Base {
        get anchor() { return null; }
        spawn() {
            const d = this.def, kinds = d.kinds || { city: 0, town: 40000, suburb: 9000, peak: 25000 }, hgt = d.height ?? 60;
            for (const p of terrainData(d.data).meta.places) {
                if (!(p.kind in kinds)) continue;
                const label = p.kind === 'peak' && p.ele ? `${p.name} ${Math.round(p.ele)} m` : p.name;
                this.world.add({ type: 'place', label, pos: [p.x, p.z], range: kinds[p.kind], labelHeight: typeof hgt === 'object' ? hgt[p.kind] ?? 60 : hgt });
            }
        }
    }

    return { GeoTerrain, GeoRoads, GeoBuildings, GeoPlaces, Place };
}

return { geoTypes };
});
