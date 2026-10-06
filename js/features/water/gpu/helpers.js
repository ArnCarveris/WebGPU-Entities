'use strict';
// GPU helpers: bind group layouts, bind groups and textures.

Features.part('water', (engine, feature) => {
// GPU helpers
const TU = () => GPUTextureUsage;
const BU = () => GPUBufferUsage;

function makeLayout(device, visibility, kinds) {
    return device.createBindGroupLayout({
        entries: kinds.map((k, binding) => {
            const [kind, arg] = k.split(':'), e = { binding, visibility };
            if (kind === 'uniform') e.buffer = { type: 'uniform' };
            else if (kind === 'storage') e.buffer = { type: 'storage' };
            else if (kind === 'read') e.buffer = { type: 'read-only-storage' };
            else if (kind === 'tex') e.texture = { sampleType: arg || 'float', viewDimension: '2d' };
            else if (kind === 'array') e.texture = { sampleType: 'float', viewDimension: '2d-array' };
            else if (kind === 'sampler') e.sampler = { type: 'filtering' };
            else if (kind === 'write') e.storageTexture = { access: 'write-only', format: arg, viewDimension: '2d' };
            else throw new Error(`layout kind ${k}`);
            return e;
        }),
    });
}

function makeGroup(device, layout, resources, label) {
    return device.createBindGroup({
        label, layout,
        entries: resources.map((r, binding) => ({ binding, resource: r instanceof GPUBuffer ? { buffer: r } : r })),
    });
}

function makeTex(device, w, h, format, usage, layers = 1) {
    return device.createTexture({ size: [w, h, layers], format, usage });
}

return { TU, BU, makeLayout, makeGroup, makeTex };
});
