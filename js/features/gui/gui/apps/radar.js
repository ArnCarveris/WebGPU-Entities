'use strict';
// The phone's radar app.

Features.part('gui', (engine, feature) => {
const { clamp, rad, col, pad3, bearingOf, IOS, PHONE_NAV_H, PhoneApp } = engine.kits.gui;
const { ENTITY_TYPES } = feature;

// The facility's phone apps (PhoneApp, the gui kit: js/kits/gui/): pages the gui world adds to the engine's handheld.

// Far Cry-style radar: heading-up, rotating compass ring, tracked objects and sound waves
class RadarApp extends PhoneApp {
    static DISC = { x: 135, y: 254, R: 92 };

    get cfg() { return this.game.scenario.radar; }

    point(wx, wz) {
        const p = this.game.player, D = RadarApp.DISC;
        const dx = wx - p.pos[0], dz = wz - p.pos[2];
        const dist = Math.hypot(dx, dz);
        const a = Math.atan2(dx, -dz) - p.yaw;
        const r = (dist / this.cfg.range) * D.R;
        return { x: D.x + Math.sin(a) * r, y: D.y - Math.cos(a) * r, r, dist, a, bearingDeg: bearingOf(dx, dz) };
    }

    // Scenario-listed objects, resolved to current positions
    tracked() {
        const { world, player } = this.game;
        return this.cfg.tracked.map((t) => {
            if (t.nearest) {
                const pick = world.ofType(ENTITY_TYPES[t.nearest])
                    .map((e) => ({ e, d: Math.hypot(e.position[0] - player.pos[0], e.position[2] - player.pos[2]) }))
                    .sort((a, b) => a.d - b.d)[0].e;
                return { ...t, name: `${t.prefix}${pick.label}`, x: pick.position[0], z: pick.position[2] };
            }
            const e = world.get(t.entity);
            return { ...t, x: e.position[0], z: e.position[2] };
        });
    }

    draw(dc, now) {
        const t = now / 1000, G = [120, 255, 150];
        const { x: cx, y: cy, R } = RadarApp.DISC;
        const { player, world, cctv } = this.game;
        const range = this.cfg.range;
        const top = PHONE_NAV_H;

        dc.roundRect(12, top + 8, 246, 304, 14, col([8, 16, 10]));

        // Noise meter + heading readout
        dc.text('NOISE', 26, top + 28, 11, col(G), 'left', false, 'sansBold');
        dc.roundRect(70, top + 20, 100, 8, 4, col(G, 0.15));
        const n = clamp(player.noise, 0, 1);
        const nc = n < 0.4 ? G : n < 0.75 ? [255, 214, 10] : [255, 69, 58];
        if (n > 0.01) dc.roundRect(70, top + 20, 100 * n, 8, 4, col(nc));
        dc.text(`HDG ${pad3(player.heading)}°`, 246, top + 28, 12, col(G), 'right', false, 'sansBold');

        // Disc, range rings, crosshair
        dc.circle(cx, cy, R, col([12, 42, 20]), 48);
        for (const k of [1, 2]) dc.ring(cx, cy, (R * k) / 3, 1, col(G, 0.22));
        dc.ring(cx, cy, R, 1.5, col(G, 0.6));
        dc.fillRect(cx - R, cy - 0.5, R * 2, 1, col(G, 0.15));
        dc.fillRect(cx - 0.5, cy - R, 1, R * 2, col(G, 0.15));
        dc.text(`${range / 3}m`, cx + 3, cy - R / 3 - 3, 9, col(G, 0.5), 'left', false, 'sans');
        dc.text(`${(range * 2) / 3}m`, cx + 3, cy - (R * 2) / 3 - 3, 9, col(G, 0.5), 'left', false, 'sans');

        // Sweep
        const sw = t * 2.2;
        dc.polygon([[cx, cy], ...dc.arcPts(cx, cy, R - 1, sw - 0.6, sw, 10)], col(G, 0.08));
        dc.line(cx, cy, cx + Math.cos(sw) * (R - 1), cy + Math.sin(sw) * (R - 1), 1.2, col(G, 0.45));

        // Rotating compass ring
        for (let d = 0; d < 360; d += 15) {
            const a = rad(d) - player.yaw;
            const len = d % 90 === 0 ? 10 : d % 45 === 0 ? 7 : 4;
            const s = Math.sin(a), c = -Math.cos(a);
            dc.line(cx + s * (R + 3), cy + c * (R + 3), cx + s * (R + 3 + len), cy + c * (R + 3 + len), d % 90 === 0 ? 2 : 1, col(G, d % 45 === 0 ? 0.9 : 0.45));
        }
        for (const [d, label] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
            const a = rad(d) - player.yaw;
            dc.text(label, cx + Math.sin(a) * (R + 22), cy - Math.cos(a) * (R + 22) + 4.5, 13, col(label === 'N' ? [255, 69, 58] : G), 'center', false, 'sansBold');
        }

        // Sound waves (world-anchored rings), clipped to the disc
        for (const w of world.waves.list) {
            const age = t - w.t0;
            if (age < 0 || age > w.life) continue;
            const c = this.point(w.x, w.z);
            const rr = ((w.speed * age) / range) * R;
            const alpha = w.alpha * (1 - age / w.life);
            const pts = dc.arcPts(c.x, c.y, rr, 0, Math.PI * 2, 40);
            for (let i = 0; i < pts.length - 1; i++) {
                const p0 = pts[i], p1 = pts[i + 1];
                if (Math.hypot(p0[0] - cx, p0[1] - cy) > R - 1 || Math.hypot(p1[0] - cx, p1[1] - cy) > R - 1) continue;
                dc.line(p0[0], p0[1], p1[0], p1[1], 1.6, col(w.color, alpha));
            }
        }

        // Cameras as small squares
        for (const cam of cctv.cameras) {
            const p = this.point(cam.position[0], cam.position[2]);
            if (p.r > R - 3) continue;
            dc.fillRect(p.x - 2.5, p.y - 2.5, 5, 5, col([255, 214, 10], cam.offline ? 0.35 : 0.85));
        }
        // Tracked objects (clamped to the rim when out of range)
        const tracked = this.tracked();
        for (const o of tracked) {
            if (o.shape === 'camera') continue;
            const p = this.point(o.x, o.z);
            const out = p.r > R - 6;
            const bx = out ? cx + Math.sin(p.a) * (R - 6) : p.x;
            const by = out ? cy - Math.cos(p.a) * (R - 6) : p.y;
            const alpha = out ? 0.5 : 1;
            if (o.shape === 'pulse') {
                const pulse = (t * 1.5) % 1;
                if (!out) dc.ring(bx, by, 5 + pulse * 10, 1.2, col(o.color, 0.8 * (1 - pulse)), 24);
                dc.circle(bx, by, 5, col(o.color, alpha), 16);
            } else if (o.shape === 'diamond') {
                dc.polygon([[bx, by - 6], [bx + 6, by], [bx, by + 6], [bx - 6, by]], col(o.color, alpha));
            } else {
                dc.fillRect(bx - 6, by - 3, 12, 6, col(o.color, alpha));
            }
        }

        // Player
        dc.polygon([[cx, cy - 10], [cx + 7, cy + 7], [cx, cy + 3], [cx - 7, cy + 7]], col([255, 255, 255]));

        // Tracking list
        dc.text('TRACKING', 28, top + 338, 11.5, col(IOS.sub), 'left', false, 'sans');
        const listTop = top + 346;
        dc.roundRect(12, listTop, 246, tracked.length * 32, 10, col(IOS.cell));
        tracked.forEach((o, i) => {
            const y = listTop + i * 32;
            const p = this.point(o.x, o.z);
            dc.circle(30, y + 16, 5, col(o.color), 14);
            dc.text(o.name, 44, y + 21, 13.5, col(IOS.text), 'left', false, 'sans');
            dc.text(`${p.dist.toFixed(1)} m  ${pad3(p.bearingDeg)}°`, 244, y + 21, 12, col(IOS.sub), 'right', false, 'sans');
            if (i < tracked.length - 1) dc.fillRect(44, y + 30.5, 214, 1.5, col(IOS.sep, 0.55));
        });
    }
}

return { RadarApp };
});
