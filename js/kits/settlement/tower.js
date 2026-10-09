'use strict';
// A skyscraper's layout: its lobby, its sections stepping in, the kinds of their storeys, and its lifts' zoning.

Features.kit('settlement', (engine, kit) => {
const { coreLayout } = engine.kits.interior;

// The plan of a skyscraper, as data a world builds it from (its buildings, their storeys, its lifts):
//   storey g: 0 the lobby (one storey `lobby` m high, `podium` m wide), then 1..G in `sections` (widths, m) of
//   zonesPerSection zones of `zone` storeys (storeyHeight m) each. Storey g is a sky lobby (an open hall where the
//   express stops and its zone's locals start) for g = 1 + zone k, k >= 1; the top storey is the observation deck
//   (an open hall, no stairs up); the rest are rooms off a corridor.
//   core: one core all the way up (kits.interior coreLayout): a switchback stairwell, express shuttles (the left bank)
//   and local lifts (the right bank: each zone's pair in the same shafts, one zone above the other).
//   lifts: { kind, group, name, shaft (the core's), stops (storey numbers) }; liftDoor(shaft, info): whether a shaft has a
//   landing door on a storey of that kind (express: lobbies and the deck only).
// spec: lobby, zone, sections, zonesPerSection, podium, storeyHeight (default 4), stairWidth, name
function towerPlan(spec) {
    const Z = spec.zone, per = spec.zonesPerSection ?? 6, H = spec.storeyHeight ?? 4, LH = spec.lobby, name = spec.name || 'Tower';
    const G = spec.sections.length * per * Z, sky = g => g > Z && (g - 1) % Z === 0;
    const label = g => g === 0 ? 'L' : g === G ? 'TOP' : sky(g) ? `S${(g - 1) / Z}` : String(g);
    const core = coreLayout({ stairs: { lane: spec.stairWidth ?? 1.3 }, banks: [2, 2], shaft: [2.4, 2.6], lobby: 3.4 }, Math.max(H, LH));
    const info = g => g === 0 ? { key: 'lobby', kind: 'hall', stairsUp: true, ground: true }
        : g === G ? { key: 'deck', kind: 'hall', stairsUp: false }
        : sky(g) ? { key: 'sky', kind: 'hall', stairsUp: true } : { key: 'rooms', kind: 'rooms', stairsUp: true };
    // each section: its width, storeys, first storey g0, the kinds of its storeys, the code WGSL's bldHall reads them
    // by ({ zone, off, min (first sky lobby), first (its ground is a hall), top (its top is) }), the width of the next
    const sections = spec.sections.map((w, k) => {
        const n = per * Z, g0 = 1 + k * n, last = k === spec.sections.length - 1;
        return { w, n, g0, last, next: last ? null : spec.sections[k + 1], storeyInfo: s => info(g0 + s),
            hall: { zone: Z, off: (g0 - 1) % Z, min: Math.max(0, Z + 1 - g0), first: 0, top: last ? 1 : 0 } };
    });
    const lifts = [];
    for (const shaft of core.shafts) {
        if (shaft.bank === 0) {
            lifts.push({ kind: 'express', group: `${name} express`, name: `Express ${shaft.index + 1}`, shaft,
                stops: [0, ...Array.from({ length: G / Z - 1 }, (_, k) => 1 + (k + 1) * Z), G] });
            continue;
        }
        for (let z = 0; z < G / Z; z++) {
            const lo = z === 0 ? 0 : 1 + z * Z, hi = Math.min(G, (z + 1) * Z);
            lifts.push({ kind: 'local', group: `${name} zone ${z + 1}`, name: `Zone ${z + 1} ${'AB'[shaft.index] || shaft.index + 1}`, shaft,
                stops: Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) });
        }
    }
    return { name, G, Z, H, LH, core, sections, lifts, sky, label, lobbyInfo: () => info(0),
        liftDoor: (shaft, si) => shaft.bank === 1 || si.key !== 'rooms' };
}

return { towerPlan };
});
