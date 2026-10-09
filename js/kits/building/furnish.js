'use strict';
// Furnishing a room: where the items of its program (a roomType's furniture, data) stand, as boxes in the building's
// frame. Any world draws them with its own boxes (a structure mesh's, a sector world's props).

Features.kit('building', (engine, kit) => {
const EPS = 1e-4;
const overlaps = (a, b) => a[0] < b[1] && a[1] > b[0] && a[2] < b[3] && a[3] > b[2];

// Furnishes room rectangle r = [x0, x1, z0, z1] (local) with program { wall: [[item, n]], free: [[item, n]], grid
// (an item in rows facing the façade), row (an item side by side along the longest wall, and more rows across a deep
// room) }, items from lib (PlanLibrary.item: { w, d, parts [u0, u1, v0, v1, y0, y1, colour, finish] }), keeping clear
// of `keep` (rectangles: doorways' swing, the stairs) and each other. put(x0, x1, z0, z1, y0, y1, colour, finish): a
// box (local; y from the floor). rnd: a seeded generator
function furnishRoom(r, program, lib, rnd, put, keep = []) {
    if (!program) return;
    const [x0, x1, z0, z1] = r, W = x1 - x0, D = z1 - z0;
    if (W < 1.4 || D < 1.4) return;
    const taken = keep.slice();
    const fits = q => q[0] >= x0 - EPS && q[1] <= x1 + EPS && q[2] >= z0 - EPS && q[3] <= z1 + EPS && !taken.some(t => overlaps(q, t));
    // an item in its own frame (u across its width, v out from its back) centred at (cx, cz), its back toward `back`
    // (a unit local direction)
    const place = (it, cx, cz, back) => {
        const ux = -back[1], uz = back[0], vx = -back[0], vz = -back[1];
        for (const [u0, u1, v0, v1, ya, yb, col, fin] of it.parts) {
            const pc = [cx + ux * (u0 + u1) / 2 + vx * ((v0 + v1) / 2 - it.d / 2), cz + uz * (u0 + u1) / 2 + vz * ((v0 + v1) / 2 - it.d / 2)];
            const hu = (u1 - u0) / 2, hv = (v1 - v0) / 2, hx = Math.abs(ux) * hu + Math.abs(vx) * hv, hz = Math.abs(uz) * hu + Math.abs(vz) * hv;
            put(pc[0] - hx, pc[0] + hx, pc[1] - hz, pc[1] + hz, ya, yb, col, fin);
        }
    };
    const foot = (it, cx, cz, back, pad = 0.1) => {
        const hw = it.w / 2 + pad, hd = it.d / 2 + pad;
        return back[0] ? [cx - hd, cx + hd, cz - hw, cz + hw] : [cx - hw, cx + hw, cz - hd, cz + hd];
    };
    const sides = [[0, -1], [0, 1], [-1, 0], [1, 0]];       // backs toward the -z, +z, -x, +x walls
    const along = name => {
        const it = lib.item(name);
        if (!it) return;
        const s0 = Math.floor(rnd() * 4);
        for (let n = 0; n < 4; n++) {
            const back = sides[(s0 + n) % 4], horiz = back[1] !== 0, len = horiz ? W : D;
            if (len < it.w + 0.4) continue;
            for (let tries = 0; tries < 6; tries++) {
                const u = (rnd() - 0.5) * (len - it.w - 0.3);
                const cx = horiz ? (x0 + x1) / 2 + u : back[0] < 0 ? x0 + it.d / 2 + 0.02 : x1 - it.d / 2 - 0.02;
                const cz = horiz ? (back[1] < 0 ? z0 + it.d / 2 + 0.02 : z1 - it.d / 2 - 0.02) : (z0 + z1) / 2 + u;
                const q = foot(it, cx, cz, back);
                if (!fits(q)) continue;
                taken.push(q);
                place(it, cx, cz, back);
                return;
            }
        }
    };
    const free = name => {
        const it = lib.item(name);
        if (!it) return;
        for (let tries = 0; tries < 10; tries++) {
            const back = sides[Math.floor(rnd() * 4)], cx = x0 + 1.0 + rnd() * Math.max(0, W - 2), cz = z0 + 1.0 + rnd() * Math.max(0, D - 2);
            const q = foot(it, cx, cz, back, 0.5);
            if (!fits(q)) continue;
            taken.push(q);
            place(it, cx, cz, back);
            return;
        }
    };
    // side by side along the longest wall that has room, then rows across the room 1.2 m apart (stalls, racks)
    const row = name => {
        const it = lib.item(name);
        if (!it) return;
        const horiz = W >= D, L = horiz ? W : D, A = horiz ? D : W;
        for (let a = 0.02, k = 0; a + it.d < A - 0.9 && k < 4; a += 2 * it.d + 1.2, k++) {
            for (let u = 0.3; u + it.w < L - 0.3; u += it.w + 0.02) {
                for (const flip of k === 0 ? [false] : [false, true]) {
                    const v = flip ? a + it.d : a;
                    if (flip && v + it.d > A - 0.9) continue;
                    const back = horiz ? [0, flip ? 1 : -1] : [flip ? 1 : -1, 0];
                    const cx = horiz ? x0 + u + it.w / 2 : x0 + v + it.d / 2, cz = horiz ? z0 + v + it.d / 2 : z0 + u + it.w / 2;
                    const q = foot(it, cx, cz, back, 0.02);
                    if (!fits(q)) continue;
                    taken.push(q);
                    place(it, cx, cz, back);
                }
            }
        }
    };
    for (const [name, n] of program.wall || []) for (let c = 0; c < n; c++) along(name);
    if (program.row) row(program.row);
    if (program.grid) {
        // desks in rows facing one way, 1.9 m apart, side by side along them
        const it = lib.item(program.grid);
        if (it) {
            const rows = W > D, L = rows ? W : D, A = rows ? D : W;
            for (let a = 1.4; a + it.d + 0.8 < A; a += 1.9) for (let u = 1.0; u + it.w + 0.6 < L; u += it.w + 0.3) {
                const cx = rows ? x0 + u + it.w / 2 : x0 + a + it.d / 2, cz = rows ? z0 + a + it.d / 2 : z0 + u + it.w / 2;
                const back = rows ? [0, -1] : [-1, 0], q = foot(it, cx, cz, back, 0.05);
                if (!fits(q)) continue;
                taken.push(q);
                place(it, cx, cz, back);
            }
        }
    }
    for (const [name, n] of program.free || []) for (let c = 0; c < n; c++) free(name);
}

return { furnishRoom };
});
