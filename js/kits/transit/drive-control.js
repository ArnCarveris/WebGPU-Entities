'use strict';
// At the wheel: F by a vehicle that has a driver's seat (a bus) takes it off its line and seats the player there, the
// camera first-person as before (the Walker's seat: the mouse looks round, the view turns with it); W S A D drive it,
// Space brakes, F gets out by its door (the vehicle goes back to its route: LineVehicle.leaveWheel).

Features.kit('transit', (engine, kit) => {

// over its host app: world (buses), walker (Walker: seat, bus, place, eye), camera, hud (toast), reset
class DriveControl {
    constructor(app, { reach = 3 } = {}) {
        this.app = app;
        this.reach = reach;
        this.vehicle = null;         // the one driven
        this.prompt = '';            // what F would do here (the HUD shows it on foot or flying)
    }

    get active() { return !!this.vehicle; }

    // the vehicle with a driver's seat whose body is within reach of the eye, nearest first (or null)
    within() {
        const p = this.app.camera.pos;
        let best = null, bd = this.reach;
        for (const v of this.app.world.buses) {
            if (!v.driverSeat || !v.spec.cabin) continue;
            const q = v.toLocal(p), { lo, hi } = v.spec.cabin;
            const d = Math.hypot(Math.max(lo[0] - q[0], 0, q[0] - hi[0]), Math.max(lo[1] - q[1], 0, q[1] - hi[1]), Math.max(lo[2] - q[2], 0, q[2] - hi[2]));
            if (d < bd) { bd = d; best = v; }
        }
        return best;
    }

    // F: get out, or take the wheel of the vehicle within reach; false if there is none
    toggle() {
        if (this.vehicle) { this.leave(); return true; }
        const v = this.within();
        if (!v) return false;
        this.take(v);
        return true;
    }

    take(v) {
        const a = this.app, wk = a.walker;
        v.takeWheel();
        Object.assign(wk, { active: true, bus: v, seat: v.driverSeat, car: null, ladder: null, vy: 0, lag: 0, busYaw: v.yaw });
        wk.feet = [v.driverSeat.x + 0.3, 0.36, 0];
        a.camera.yaw = v.yaw;
        a.camera.pitch = -0.05;
        wk.eye(a);
        this.vehicle = v;
        a.reset = true;
        a.hud.toast(`At the wheel of ${v.label}: W S A D drive, Space brake, F get out`);
    }

    leave() {
        const a = this.app, v = this.vehicle;
        this.vehicle = null;
        v.leaveWheel();
        const p = v.toWorld(v.exitSpot);
        a.walker.place(a, p[0], p[2]);
        a.walker.eye(a);
        a.camera.lookAt(v.toWorld([0, 1.5, 0]));
        a.reset = true;
        a.hud.toast(`${v.label}: ${v.describe()}`);
    }

    // each frame, after the walker: the controls into the vehicle driven (its next step takes them); the driver gone
    // from the seat (stood up, flew off, jumped to a view) lets go of it
    update(keys) {
        const a = this.app, v = this.vehicle;
        if (!v) { const n = a.walker.seat ? null : this.within(); this.prompt = n ? `F drive ${n.label}` : ''; return; }
        this.prompt = '';
        if (!a.walker.active || a.walker.bus !== v || a.walker.seat !== v.driverSeat) { this.vehicle = null; v.leaveWheel(); return; }
        const k = c => keys.has(c) ? 1 : 0;
        v.control = { throttle: k('KeyW') - k('KeyS'), steer: k('KeyD') - k('KeyA'), brake: k('Space') };
    }
}

return { DriveControl };
});
