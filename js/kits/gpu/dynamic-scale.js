'use strict';
// Dynamic resolution: a render scale kept under a GPU time budget.

Features.kit('gpu', (engine, kit) => {

// The scale between a preset's (q.scale) and its floor (q.dynamic), stepped by 0.05 to keep the GPU time per frame
// (a profiler's, smoothed) under `budget` ms. Down at once by as much as the overshoot needs (what it scales costs
// about the scale squared); up a step only when that estimate of the next step's cost (an overestimate: part of the
// frame does not scale) still leaves a margin, and at most every half second, so it settles instead of hunting.
class DynamicScale {
    constructor(budget) { this.budget = budget; this.scale = 0; this.at = -1e9; }
    update(q, gpuMs, now) {
        const B = this.budget;
        if (!this.scale || this.scale > q.scale || this.scale < q.dynamic) this.scale = q.scale;
        if (gpuMs > 0 && now - this.at > 0.5) {
            let s = this.scale;
            if (gpuMs > B) s = Math.floor(s * Math.sqrt(B / gpuMs) * 20) / 20;
            else if (gpuMs * ((s + 0.05) / s) ** 2 < B * 0.95) s = s + 0.05;
            s = Math.min(q.scale, Math.max(q.dynamic, Math.round(s * 20) / 20));
            if (s !== this.scale) { this.scale = s; this.at = now; }
        }
        return this.scale;
    }
}

return { DynamicScale };
});
