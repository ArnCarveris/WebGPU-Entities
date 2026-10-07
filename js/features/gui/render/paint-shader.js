'use strict';
// WGSL: the paint stamp the easel's brush draws with.

Features.part('gui', (engine, feature) => {
const { kits } = engine;
const { NoiseWGSL } = kits.noise;
// Brush stamping: every dab is an instanced quad drawn into the paint render target. The brush type
// picks the dab's shape; flow is how much paint one dab lays down.
const stampShader = (width, height) => /* wgsl */`
    struct Dab {
        @location(0) a : vec4f,     // x, y (paint px), radius (px), brush type
        @location(1) col : vec4f,
        @location(2) b : vec4f,     // seed, angle, flow, -
    };
    struct O {
        @builtin(position) pos : vec4f,
        @location(0) local : vec2f,
        @location(1) px : vec2f,
        @location(2) col : vec4f,
        @location(3) @interpolate(flat) info : vec4f,   // type, seed, angle, flow
    };
    const SIZE = vec2f(${width}.0, ${height}.0);

${NoiseWGSL.hashSin2('hash')}

    @vertex
    fn vs_stamp(@builtin(vertex_index) vi : u32, d : Dab) -> O {
        var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
                                      vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
        let c = corners[vi];
        let px = d.a.xy + c * d.a.z;
        var o : O;
        o.pos = vec4f(px.x / SIZE.x * 2.0 - 1.0, 1.0 - px.y / SIZE.y * 2.0, 0.0, 1.0);
        o.local = c;
        o.px = px;
        o.col = d.col;
        o.info = vec4f(d.a.w, d.b.x, d.b.y, d.b.z);
        return o;
    }

    @fragment
    fn fs_stamp(i : O) -> @location(0) vec4f {
        let dist = length(i.local);
        let flow = i.info.w;
        var a = 0.0;
        switch u32(i.info.x + 0.5) {
            case 0u: { a = (1.0 - smoothstep(0.3, 1.0, dist)) * flow; }             // round brush: soft edge
            case 1u: { a = 1.0 - smoothstep(0.8, 1.0, dist); }                       // ink pen: hard, opaque
            case 2u: {                                                               // airbrush: speckled spray
                let n = hash(floor(i.px) + i.info.y);
                a = pow(max(1.0 - dist, 0.0), 2.0) * flow * step(0.55, n);
            }
            case 3u: {                                                               // marker: fixed chisel tip
                let cs = cos(i.info.z);
                let sn = sin(i.info.z);
                let q = vec2f(cs * i.local.x + sn * i.local.y, -sn * i.local.x + cs * i.local.y);
                a = step(abs(q.x), 1.0) * step(abs(q.y), 0.32) * flow;
            }
            case 4u: {                                                               // charcoal: grain fixed to the paper
                let n = hash(floor(i.px * 0.8));
                a = (1.0 - smoothstep(0.55, 1.0, dist)) * step(0.3 + 0.45 * dist, n) * flow;
            }
            default: { a = 1.0 - smoothstep(0.8, 1.0, dist); }                       // eraser (paper colour)
        }
        if (a <= 0.002) { discard; }
        return vec4f(i.col.rgb, a * i.col.a);
    }
`;

return { stampShader };
});
