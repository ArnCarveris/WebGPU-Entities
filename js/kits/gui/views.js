'use strict';
// Views: pictures a world draws of itself for its screens and the phone (CCTV feeds, the phone's camera).

Features.kit('gui', (engine, kit) => {
// A view target: a colour texture of the canvas format that a world renders a view into, shown by GUIs as `material`
// (a world never samples it while drawing into it). Like Doom 3 subviews, the systems that own one (CctvSystem,
// PhoneCamera) only render it when something shows it.
//
// The scene contract, whatever world renders (the gui feature's facility, the portal feature's island):
//   scene.renderView(enc, target, shot)
//     shot: { eye, dir, up, fovY, near, far, showAvatar, skip (an entity to leave out: the camera itself) }
//   When it returns, the target holds the picture for every command encoded on `enc` after the call: a world may
//   encode its passes into enc, or submit its own work first.
// The materials contract (the world's renderer, mirrored to the handheld's): device, format,
//   registerMaterial(name, shading, view), setMaterialTexture(name, view); shadings: gui, cctv, video (2d-array).

class ViewTarget {
    constructor(device, format, width, height, { material = null, copySrc = false } = {}) {
        this.width = width;
        this.height = height;
        this.aspect = width / height;
        this.material = material;
        this.texture = device.createTexture({
            size: [width, height], format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | (copySrc ? GPUTextureUsage.COPY_SRC : 0)
        });
        this.colorView = this.texture.createView();
    }
}

return { ViewTarget };
});
