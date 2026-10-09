'use strict';
// A building's core from its corePlan: the stairwell, the lift banks (each shaft's car run, its technical space beside
// it with the counterweight and the emergency ladder, the landing door), the lift lobby; laid along local x.

Features.kit('building', (engine, kit) => {
const PARTITION = 0.12;              // m: a wall between rooms (shaft walls too)

// The core of corePlan C for storeys up to H m high, centred on the footprint and laid along local x: [stairwell |
// bank 0 | lift lobby | bank 1], each the core's full depth along z. C: { stairs { lane, landing } | false, lobby (m),
// banks [{ shafts, shaft { width (along z), depth (along x), tech }, car { width, depth, height }, door { width,
// height } }], pit, overrun, machine (m), ladder, shaftLight { perStorey, y (m over a storey's floor), color, intensity,
// range (m) } | false (the shafts' own lamps up their technical side wall: a shaft is dark but for them). Returns { w, d
// (along x, z), stair { rect, lane, landing }, lobby (rect), shafts, pit, overrun, machine, ladder, light }, each shaft:
//   bank, index, key, rect [x0, x1, z0, z1] (its walls' centre lines), face ('+x' / '-x': its door opens onto the lobby
//   that way), sx (+1 / -1 the same), wall (x of the door wall's centre line), back (x of the back wall's), car { rect
//   (the car's outside), w, d, h, front (x of its front face), zc }, door { c (z of its centre), w, h }, tech { rect,
//   side (-1 / +1 along z) }, ladder { x (centre of its rungs along x), z (the plane of its rungs), n ([nx, nz]: from
//   the rungs toward the climber), w, rail }, counterweight { rect, h }, rails (z of the car's guide rails), lamp { x, z
//   (its fixture's centre on the technical space's side wall), n ([nx, nz] into the shaft) }
function coreLayout(C, H) {
    const st = C.stairs === false || !C.stairs ? null : { lane: 1.2, landing: 1.25, ...C.stairs };
    const banks = (C.banks || []).map(b => b && b.shafts ? {
        shafts: b.shafts, shaft: { width: 2.6, depth: 2.6, tech: 0.75, ...b.shaft }, car: { width: 1.8, depth: 1.9, height: 2.5, ...b.car },
        door: { width: 1.0, height: 2.1, ...b.door } } : null);
    const lobby = C.lobby ?? 3.0;
    const steps = Math.ceil(H / 2 / 0.18), run = steps * 0.28;
    const d = Math.max(st ? run + 2 * st.landing : 0, ...banks.map(b => b ? b.shafts * b.shaft.width : 0), 4.5);
    const stairW = st ? 2 * st.lane + 0.2 : 0;
    const w = stairW + (banks[0] ? banks[0].shaft.depth : 0) + lobby + (banks[1] ? banks[1].shaft.depth : 0);
    let x = -w / 2;
    const light = C.shaftLight === false ? null : { perStorey: 1, y: 2.2, color: [1.0, 0.86, 0.66], intensity: 0.08, range: 7, ...(C.shaftLight || {}) };
    const parts = { w, d, shafts: [], pit: C.pit ?? 1.5, overrun: C.overrun ?? 1.0, machine: C.machine ?? 2.0, ladder: C.ladder !== false, partition: PARTITION, light };
    if (st) { parts.stair = { rect: [x, x + stairW, -d / 2, d / 2], ...st }; x += stairW; }
    const bank = (b, side) => {
        const D = b.shaft.depth, W = b.shaft.width, x0 = x, x1 = x + D, z0 = -b.shafts * W / 2, face = side === 0 ? '+x' : '-x', sx = side === 0 ? 1 : -1;
        const wall = sx > 0 ? x1 : x0, back = sx > 0 ? x0 : x1, h = PARTITION / 2;
        for (let i = 0; i < b.shafts; i++) {
            const rz0 = z0 + i * W, rz1 = rz0 + W;
            // the technical space on the shaft's outer side along z (away from the bank's middle), the car beside it
            const ts = b.shafts === 1 ? 1 : i < b.shafts / 2 ? -1 : 1, tech = b.shaft.tech;
            const tz = ts < 0 ? [rz0 + h, rz0 + h + tech] : [rz1 - h - tech, rz1 - h];
            const run = ts < 0 ? [tz[1], rz1 - h] : [rz0 + h, tz[0]], zc = (run[0] + run[1]) / 2, cw = Math.min(b.car.width, run[1] - run[0] - 0.24);
            const front = wall - sx * (h + 0.07), cd = Math.min(b.car.depth, Math.abs(front - back) - h - 0.12);
            const car = { rect: [Math.min(front, front - sx * cd), Math.max(front, front - sx * cd), zc - cw / 2, zc + cw / 2], w: cw, d: cd, h: b.car.height, front, zc };
            const inner = ts < 0 ? rz0 + h : rz1 - h, lz = inner - ts * 0.16;
            parts.shafts.push({
                bank: side, index: i, key: `${side}:${i}`, rect: [x0, x1, rz0, rz1], face, sx, wall, back, car,
                door: { c: zc, w: Math.min(b.door.width, cw - 0.1), h: b.door.height },
                tech: { rect: [Math.min(wall, back) + (sx > 0 ? h : h), Math.max(wall, back) - h, tz[0], tz[1]], side: ts },
                ladder: { x: wall - sx * 0.55, z: lz, n: [0, -ts], w: 0.46, rail: 0.05 },
                counterweight: { rect: [Math.min(back + sx * (h + 0.08), back + sx * (h + 0.38)), Math.max(back + sx * (h + 0.08), back + sx * (h + 0.38)), tz[0] + 0.08, tz[1] - 0.08], h: 2.2 },
                rails: [zc - cw / 2 - 0.08, zc + cw / 2 + 0.08],
                lamp: { x: (wall + back) / 2, z: inner - ts * 0.03, n: [0, -ts] },
            });
        }
        x += D;
    };
    if (banks[0]) bank(banks[0], 0);
    parts.lobby = [x, x + lobby, -d / 2, d / 2];
    x += lobby;
    if (banks[1]) bank(banks[1], 1);
    return parts;
}

return { coreLayout, PARTITION };
});
