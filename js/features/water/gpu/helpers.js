'use strict';
// GPU helpers: usage flags and textures (bind groups: Common.bindLayout / bindGroup).

Features.part('water', (engine, feature) => {
// GPU helpers
const TU = () => GPUTextureUsage;
const BU = () => GPUBufferUsage;

function makeTex(device, w, h, format, usage, layers = 1) {
    return device.createTexture({ size: [w, h, layers], format, usage });
}

return { TU, BU, makeTex };
});
