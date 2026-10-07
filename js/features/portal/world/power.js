'use strict';
// The island's power grid: generator units and a breaker per area.

Features.part('portal', (engine, feature) => {
// PowerGrid: the generator units (made by the screens that name one, `unit`) feed a breaker per area of the island's
// grid (every area not aboard a vehicle). An area whose breaker is off, or with no unit up to speed, has its lights
// out but its emergency beacons (signal "pulse"); the screens keep running on their UPS. Without units there is no
// grid: everything is powered, as before. Demand: a base load per area plus its lights; the running units share it.

const RATED_RPM = 1500;

class PowerGrid {
    constructor(world) {
        this.world = world;
        this.units = [];
        this.breakers = new Map();          // area index -> on
        this.time = 0;
    }

    // a unit by id, made on first use: { id, on, rpm, temp (°C), fuel (0..1), capacity (kW), load (kW) }
    unit(id, def = {}) {
        let u = this.units.find(x => x.id === id);
        if (!u) {
            const on = def.on !== false;
            this.units.push(u = { id, on, rpm: on ? RATED_RPM : 0, temp: on ? 78 : 18, fuel: def.fuel ?? 0.82, capacity: def.capacity ?? 60, load: 0, seed: this.units.length * 1.7 });
        }
        return u;
    }

    get areas() { return this.world.areas.filter(a => a.index > 0 && !a.vehicle); }
    get live() { return this.units.some(u => u.rpm > RATED_RPM * 0.8); }
    get capacity() { return this.units.reduce((s, u) => s + (u.rpm > RATED_RPM * 0.8 ? u.capacity : 0), 0); }

    breaker(i) { return this.breakers.get(i) ?? true; }
    setBreaker(i, on) { this.breakers.set(i, !!on); }
    powered(i) { return !this.units.length || this.world.areas[i].vehicle || (this.breaker(i) && this.live); }

    // kW an area draws with its breaker on
    demand(a) { return 1.5 + a.lights.reduce((s, L) => s + L.intensity, 0) * 1.2; }
    get load() { return this.live ? this.areas.reduce((s, a) => s + (this.breaker(a.index) ? this.demand(a) : 0), 0) : 0; }

    update(dt, t) {
        this.time = t;
        if (!this.units.length) return;
        const load = this.load, up = this.units.filter(u => u.rpm > RATED_RPM * 0.8);
        for (const u of this.units) {
            const run = u.on && u.fuel > 0;
            const target = run ? RATED_RPM + Math.sin(t * 1.3 + u.seed) * 6 + Math.sin(t * 7.1 + u.seed) * 2 : 0;
            u.rpm += Math.max(-260 * dt, Math.min((run ? 420 : 260) * dt, target - u.rpm));
            u.load = up.includes(u) ? load / up.length : 0;
            const hot = run ? 74 + 14 * Math.min(1.4, u.load / u.capacity) : 18;
            u.temp += (hot - u.temp) * Math.min(1, dt * (run ? 0.05 : 0.02));
            if (run) u.fuel = Math.max(0, u.fuel - dt * (0.00004 + 0.00025 * u.load / u.capacity));
        }
    }
}

return { PowerGrid, RATED_RPM };
});
