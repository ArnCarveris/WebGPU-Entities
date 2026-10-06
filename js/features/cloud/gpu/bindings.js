'use strict';
// The frame uniform's layout and the bind group layouts every pass shares.

Features.part('cloud', (engine, feature) => {
const {
    MAX_LAYERS, MAX_MOTHERSHIPS, MAX_SHELVES, MAX_FLASHES, MAX_BLOCKERS, BLOCK_GRID, MAX_LIGHTS, LIGHT_GRID,
    MAX_GLOWS, MAX_RAIN_ZONES, MAX_DRIPS,
} = feature;

// GPU layout shared by JS and WGSL
// Per-frame uniform block. The WGSL struct is generated from this list, so offsets can never drift apart.
const FRAME_LAYOUT = [
    ['viewProj', 'mat4x4f'],
    ['prevViewProj', 'mat4x4f'],
    ['cam', 'vec4f'],       // xyz, real time (s)
    ['fwd', 'vec4f'],       // xyz, near
    ['right', 'vec4f'],     // right * tan(fovx / 2), frame index
    ['up', 'vec4f'],        // up * tan(fovy / 2), weather time (s)
    ['sunDir', 'vec4f'],    // xyz (the moon's by night), moon: 0 by day, else night and the moon's lit fraction
    ['sunCol', 'vec4f'],    // rgb irradiance, exposure
    ['zenith', 'vec4f'],    // rgb sky radiance, haze extinction at the ground (1/m)
    ['horizon', 'vec4f'],   // rgb sky radiance, haze scale height (m)
    ['ambient', 'vec4f'],   // rgb sky ambient, lightning veil (a flash close by floods the view)
    ['screen', 'vec4f'],    // full w, h, volumetric w, h
    ['cloud', 'vec4f'],     // base, layer top, extinction (1/m), coverage
    ['noise', 'vec4f'],     // shape scale, detail scale, detail strength, slab top
    ['wind', 'vec4f'],      // wind x, z (m/s), noise offset x, z (m)
    ['precip', 'vec4f'],    // freezing level, slant (s/m), rain extinction, snow extinction
    ['wdomain', 'vec4f'],   // weather map origin x, z, size, resolution
    ['tdomain', 'vec4f'],   // terrain origin x, z, size, resolution
    ['ground', 'vec4f'],    // field size, pivot chance, ground state resolution, render mode
    ['cirrus', 'vec4f'],    // altitude, coverage, scale, drizzle
    ['flash', `array<vec4f, ${MAX_FLASHES}>`], // xyz, intensity
    ['march', 'vec4f'],     // steps, light steps, max distance, radar on
    ['near', 'vec4f'],      // near rain, near snow, history reset, storm cell count
    ['misc', 'vec4f'],      // sea-level temperature, streak scroll (m), ground reference height, weather dt (s)
    ['layers', `array<vec4f, ${MAX_LAYERS * 3}>`], // per genus: [base, top, coverage, extinction] [map scale, shape scale, stretch, erosion] [kind, ambient, precip, seed]
    ['layerInfo', 'vec4f'], // lowest genus base, highest genus top, lowest cloud of any kind, -
    ['ms', `array<vec4f, ${MAX_MOTHERSHIPS * 3}>`],  // [x, z, radius, spin] [stack bottom, top, plates, twist] [wall drop, wall radius, strength, seed]
    ['shelves', `array<vec4f, ${MAX_SHELVES * 4}>`], // [end a, end b] [bow control, motion dir] [lip height, depth, tiers, strength] [bbox]
    ['features', 'vec4f'],  // motherships, shelf lines, highest cloud top (m), -
    ['hurricane', 'array<vec4f, 3>'], // [eye x, z, eye radius, strength (0 off)] [eyewall top, turn (rad), rain bands, outer radius] [precipitation, band top, eye floor cover, raggedness]
    ['tornado', 'array<vec4f, 4>'], // [x, z, ground, top] [radius at the ground, at the top, condensed share, flare] [lean x, z, debris radius, height] [strength (0 off), spin (rad/s), subvortices, seed]
    ['lod', 'vec4f'],       // march interleave (1, 2, 4), shadow map slices, slice this frame, detail distance (m)
    ['froxel', 'vec4f'],    // near, far (m), froxels on, -
    ['post', 'vec4f'],      // cloud blur radius (volumetric texels), cloud tile pre-pass on, radar top (fraction of the screen height), bolt bloom gain
    ['bloom', 'vec4f'],     // strength (0 off), threshold, soft knee (exposed radiance), levels in the chain
    ['blocks', 'vec4f'],    // structure boxes: count, lowest bottom, highest top (m), -
    ['blockBox', 'vec4f'],  // their bounds x0, z0, x1, z1, padded for the shadows and rain shadows they cast
    ['rain', 'vec4f'],      // drop size (0 drizzle .. 1 downpour), rain fall speed (m/s), genus layer precipitation scale, rain particles
    ['zoneInfo', 'vec4f'],  // rain zones in rainZones, their fade (0 .. 1), their radius (m), a clear stretch's opening along the route (m)
    ['rainZones', `array<vec4f, ${MAX_RAIN_ZONES}>`], // points along the bus route (mixed rain): x, z, genus layer cover scale, precipitation scale
    ['zoneDirs', `array<vec4f, ${MAX_RAIN_ZONES / 2}>`], // the route's direction at them, two per vec4: x, z
    ['drips', 'vec4f'],     // roof edges in dripEdges, first splash particle (after the rain and drip ones), -, -
    ['dripEdges', `array<vec4f, ${MAX_DRIPS * 3}>`], // [x, z, half x, half z] [cos yaw, sin yaw, edge height, drop to the ground] [share of drops up to this edge, edges (0 all four, 1 along local x), share of its drops kept, -]
    ['blockers', `array<vec4f, ${MAX_BLOCKERS * 3}>`], // [x, z, half x, half z] [cos yaw, sin yaw, bottom, top] [sky occlusion, slope, moving, enclosed]
    ['blockGrid', `array<vec4u, ${BLOCK_GRID * BLOCK_GRID}>`], // per cell of blockBox: bit k set if box k can shade a point in it
    // the bus nearest the camera, or the one ridden (BusLine): world to its frame (each bus is drawn with its own, wgslBus)
    ['busInv', 'mat4x4f'],
    ['lightInfo', 'vec4f'], // lights in lights, lamps on (night), the distance their fade ends (m, farLampReal), the air's scattering for their halos and beams (1/m)
    // [x, y, z, range (m)] [rgb intensity (adapted to the exposure), cos of the cone's edge] [cone axis, cos of its full core]
    ['lights', `array<vec4f, ${MAX_LIGHTS * 4}>`],    // ... [flags, size squared (m^2: softens the falloff close to it), -, -]
    ['lightMask', `array<vec4u, ${MAX_LIGHTS}>`],
    ['lightBox', 'vec4f'],  // bounds of the lights' reach x0, z0, x1, z1
    ['lightGrid', `array<vec4u, ${LIGHT_GRID * LIGHT_GRID / 2}>`], // per cell of lightBox (two to a vec4u): bit k set if light k reaches into it // per light: bit k set if box k of blockers can stand between it and what it lights
    ['cabinLo', 'vec4f'],   // its body in its frame (inCabin): min corner, bus on
    ['cabinHi', 'vec4f'],   // max corner, -
    ['glowInfo', 'vec4f'],  // light-pollution domes in glows (0 by day), their gain (adapted to the exposure), -, -
    ['glows', `array<vec4f, ${MAX_GLOWS}>`], // x, z, radius (m), total intensity of their lamps
];

class FrameBlock {
    constructor() {
        const size = t => t === 'mat4x4f' ? 16 : t === 'vec4f' ? 4 : 4 * parseInt(t.match(/(\d+)>$/)[1]);
        this.offsets = {};
        let o = 0;
        for (const [name, type] of FRAME_LAYOUT) { this.offsets[name] = o; o += size(type); }
        this.data = new Float32Array(o);
    }
    set(name, values, at = 0) { this.data.set(values, this.offsets[name] + at); }
    setBits(name, words) { new Uint32Array(this.data.buffer, this.offsets[name] * 4, words.length).set(words); }
    static wgsl() { return `struct Frame {\n${FRAME_LAYOUT.map(([n, t]) => `    ${n}: ${t},`).join('\n')}\n};\n`; }
}

// Shared resources. A shader asks for the subset it uses by name; binding numbers are the table index, so a module's
// declarations and its bind group layout come from the same list.
const WORLD_BINDINGS = [
    ['F', 'uniform', 'var<uniform> F: Frame'],
    ['shapeTex', 'tex3d', 'var shapeTex: texture_3d<f32>'],
    ['detailTex', 'tex3d', 'var detailTex: texture_3d<f32>'],
    ['weatherTex', 'tex', 'var weatherTex: texture_2d<f32>'],
    ['shadowTex', 'tex', 'var shadowTex: texture_2d<f32>'],
    ['heightTex', 'tex', 'var heightTex: texture_2d<f32>'],
    ['landTex', 'tex', 'var landTex: texture_2d<f32>'],
    ['repSamp', 'sampler', 'var repSamp: sampler'],
    ['clampSamp', 'sampler', 'var clampSamp: sampler'],
    ['cells', 'read', 'var<storage, read> cells: array<Cell>'],
    ['ground', 'read', 'var<storage, read> ground: array<vec2f>'],
    ['bolts', 'read', 'var<storage, read> bolts: array<vec4f>'],
    ['anvilTex', 'tex', 'var anvilTex: texture_2d<f32>'],     // anvil coverage, anvil top, shelf coverage, shelf wedge
    ['layerTex', 'tex', 'var layerTex: texture_2d<f32>'],     // coverage of each cloud genus layer
    ['styleTex', 'tex', 'var styleTex: texture_2d<f32>'],     // laminar plates, green tint, wall cloud lowering (m), -
    ['occ', 'read', 'var<storage, read> occ: array<u32>'],     // per column, bit k: height cell k may hold noise cloud
    ['buildings', 'read', 'var<storage, read> buildings: array<vec4f>'],   // every building's frame, storeys and windows (WGSL_BUILDING)
];

function layoutEntry(binding, visibility, kind) {
    const [k, arg] = kind.split(':'), e = { binding, visibility };
    if (k === 'uniform') e.buffer = { type: 'uniform' };
    else if (k === 'read') e.buffer = { type: 'read-only-storage' };
    else if (k === 'storage') e.buffer = { type: 'storage' };
    else if (k === 'tex') e.texture = { sampleType: arg || 'float', viewDimension: '2d' };
    else if (k === 'tex3d') e.texture = { sampleType: 'float', viewDimension: '3d' };
    else if (k === 'depth') e.texture = { sampleType: 'depth', viewDimension: '2d' };
    else if (k === 'sampler') e.sampler = { type: 'filtering' };
    else if (k === 'write') e.storageTexture = { access: 'write-only', format: arg, viewDimension: '2d' };
    else if (k === 'write3d') e.storageTexture = { access: 'write-only', format: arg, viewDimension: '3d' };
    else throw new Error(`layout kind ${kind}`);
    return e;
}

const asResource = r => r instanceof GPUBuffer ? { buffer: r } : r;

class BindingSet {
    constructor(device, names, group = 0) {
        this.device = device;
        this.slots = names.map(n => {
            const b = WORLD_BINDINGS.findIndex(x => x[0] === n);
            if (b < 0) throw new Error(`unknown binding ${n}`);
            return { name: n, binding: b, kind: WORLD_BINDINGS[b][1], decl: WORLD_BINDINGS[b][2] };
        });
        const vis = GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
        this.layout = device.createBindGroupLayout({ entries: this.slots.map(s => layoutEntry(s.binding, vis, s.kind)) });
        this.wgsl = this.slots.map(s => `@group(${group}) @binding(${s.binding}) ${s.decl};`).join('\n') + '\n';
    }
    group(res, label) {
        return this.device.createBindGroup({ label, layout: this.layout, entries: this.slots.map(s => ({ binding: s.binding, resource: asResource(res[s.name]) })) });
    }
}

// private bindings of one pass (outputs, screen textures): kinds in binding order
function makeLayout(device, visibility, kinds) {
    return device.createBindGroupLayout({ entries: kinds.map((k, b) => layoutEntry(b, visibility, k)) });
}
function makeGroup(device, layout, resources, label) {
    return device.createBindGroup({ label, layout, entries: resources.map((r, binding) => ({ binding, resource: asResource(r) })) });
}

return { FrameBlock, WORLD_BINDINGS, BindingSet, makeLayout, makeGroup };
});
