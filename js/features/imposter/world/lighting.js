'use strict';
// Lighting scenarios and the animated switch between them.

Features.part('imposter', (engine, feature) => {
const { Common } = engine;
const { DEG, lerp, smoothstep, v3 } = Common;
const { lin } = feature;

// A lighting scenario: sun (azimuth / elevation in degrees, colour, intensity), sky, ambient, fog, exposure
// and emission (how bright emissive surfaces glow: lights on at night). All of it is applied per frame by the
// shaders to the surfaces the meshes and imposter atlases carry; nothing of it is baked.
const sunDirFrom = (az, el) => [Math.sin(az * DEG) * Math.cos(el * DEG), Math.sin(el * DEG), Math.cos(az * DEG) * Math.cos(el * DEG)];

function parseEnv(e = {}) {
    const sun = e.sun || {}, sky = e.sky || {}, amb = e.ambient || {}, fog = e.fog || {};
    let az = sun.azimuth, el = sun.elevation;
    if (az === undefined || el === undefined) {
        const d = v3.norm(sun.dir || [0.45, 0.58, 0.62]);
        az = Math.atan2(d[0], d[2]) / DEG;
        el = Math.asin(d[1]) / DEG;
    }
    return {
        azimuth: az, elevation: el, sunDir: sunDirFrom(az, el), sunColor: lin(sun.color || '#fff1dc'), sunIntensity: sun.intensity ?? 2.8,
        skyTop: lin(sky.top || '#3d6fb6'), skyHorizon: lin(sky.horizon || '#bfd3e4'),
        ambientSky: lin(amb.sky || '#a8c4e6'), ambientGround: lin(amb.ground || '#6a604c'), ambientStrength: amb.strength ?? 0.55,
        fogColor: lin(fog.color || '#bccfde'), fogDensity: fog.density ?? 0.002, exposure: e.exposure ?? 1, emission: e.emission ?? 1,
    };
}

function lerpEnv(a, b, t) {
    const o = {};
    for (const k in b) o[k] = Array.isArray(b[k]) ? b[k].map((x, i) => lerp(a[k][i], x, t)) : lerp(a[k], b[k], t);
    o.sunDir = v3.norm(o.sunDir);
    return o;
}

// Lighting: the scenario's named presets, the current environment and animated switches between them
class Lighting {
    constructor() {
        this.presets = {};
        this.name = '';
        this.env = parseEnv();
        this.target = this.env;
        this.from = null;
        this.t = 1;
        this.changes = 0;               // relights since start (switches + sun / emission tweaks)
    }

    get names() { return Object.keys(this.presets); }

    // `environment` names a preset of `lighting`, or is an environment object itself
    load(sc) {
        this.presets = { ...(sc.lighting || {}) };
        let name = sc.environment;
        if (name && typeof name === 'object') { this.presets = { custom: name, ...this.presets }; name = 'custom'; }
        if (!this.presets[name]) name = this.names[0];
        if (!name) { this.presets = { default: {} }; name = 'default'; }
        this.set(name, false);
    }

    set(name, animate = true) {
        if (!this.presets[name]) return;
        this.name = name;
        this.target = parseEnv(this.presets[name]);
        if (animate) { this.from = this.env; this.t = 0; this.changes++; }
        else { this.env = { ...this.target }; this.t = 1; }
    }

    cycle() { const n = this.names; this.set(n[(n.indexOf(this.name) + 1) % n.length]); }

    // azimuth, elevation or emission
    tweak(key, value) {
        this.target[key] = value;
        this.target.sunDir = sunDirFrom(this.target.azimuth, this.target.elevation);
        if (this.t >= 1) this.env = { ...this.target };
        this.changes++;
    }

    update(dt) {
        if (this.t >= 1) return;
        this.t = Math.min(1, this.t + dt / 1.5);
        this.env = lerpEnv(this.from, this.target, smoothstep(0, 1, this.t));
    }
}

return { Lighting };
});
