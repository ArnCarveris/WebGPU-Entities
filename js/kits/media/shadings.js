'use strict';
// The media's GUI shadings (the gui kit's GuiShadings): the security-camera look and video frames, built by a GUI
// renderer (a world's, the handheld's) when a material of theirs first registers there.

Features.kit('media', (engine, kit) => {
const { GuiShadings } = engine.kits.gui;

// Security-camera look (a CCTV feed, the 'cctv' material). color.r = signal strength (0 = static). After the scene
// shader's GUI stage (vs_gui, clipped, crt)
const WGSL_CCTV = /* wgsl */`
    @fragment
    fn fs_cctv(i : GuiOut) -> @location(0) vec4f {
        if (clipped(i)) { discard; }
        let t = U.params.x;
        let uv = i.uv;
        let tear = (hash(vec2f(floor(uv.y * 120.0), floor(t * 24.0))) - 0.5) * 0.004;
        let s = textureSample(guiTex, guiSampler, vec2f(uv.x + tear, uv.y));
        let noise = hash(uv * vec2f(391.0, 283.0) + fract(t * 7.3) * vec2f(17.0, 29.0));
        var v = dot(s.rgb, vec3f(0.3, 0.59, 0.11)) * 1.35 + (noise - 0.5) * 0.1;
        v = v * (0.9 + 0.1 * sin(uv.y * 5.0 - t * 1.7)) * (0.85 + 0.15 * sin(uv.y * 384.0 * 3.14159));
        let d = uv - vec2f(0.5);
        v = v * (1.0 - dot(d, d) * 1.3);
        let feed = vec3f(v * 0.72, v, v * 0.8);
        let rgb = mix(vec3f(noise * 0.75), feed, clamp(i.color.r, 0.0, 1.0));
        return vec4f(crt(rgb, i.gpos, 1.0), 1.0);
    }
`;

// Texture-array GUI material (video frames, the 'video' material): a fragment stage of its own after the scene shader's
// vs_gui; color.r carries the layer
const WGSL_VIDEO = /* wgsl */`
    struct GuiOut {
        @builtin(position) pos : vec4f,
        @location(0) uv    : vec2f,
        @location(1) color : vec4f,
        @location(2) gpos  : vec2f,
        @location(3) @interpolate(flat) fx : f32,
    };
    @group(0) @binding(2) var guiSampler : sampler;
    @group(0) @binding(3) var frames : texture_2d_array<f32>;

    @fragment
    fn fs_video(i : GuiOut) -> @location(0) vec4f {
        let c = textureSample(frames, guiSampler, i.uv, i32(i.color.r + 0.5));
        return vec4f(c.rgb, i.color.a);
    }
`;

GuiShadings.set('cctv', { layout: '2d', chunks: { CCTV: [WGSL_CCTV, ['SCENE']] }, module: ['CCTV'], fs: 'fs_cctv' });
GuiShadings.set('video', { layout: '2d-array', chunks: { VIDEO: [WGSL_VIDEO, []] }, fsModule: ['VIDEO'], fs: 'fs_video' });

return {};
});
