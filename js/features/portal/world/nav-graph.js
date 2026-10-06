'use strict';
// The navigation graph drones fly.

Features.part('portal', (engine, feature) => {
const { Common } = engine;
const { v3 } = Common;

// SECTR_Graph: shortest path over areas and portals (Dijkstra between area hubs through portal nav points).
// Portals stop navigation when closed (unless automatic), locked, windows or sky-only; vehicle areas and
// areas with `nav: false` are never entered.

class NavGraph {
    constructor(world) {
        this.world = world;
    }

    // [{ area, portal }, ...] from area `from` to area `to`, or null
    findPath(from, to) {
        const { areas, portals } = this.world;
        const N = areas.length, dist = new Array(N).fill(Infinity), prev = new Array(N).fill(null), done = new Array(N).fill(false);
        dist[from] = 0;
        for (;;) {
            let u = -1;
            for (let i = 0; i < N; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
            if (u < 0 || u === to) break;
            done[u] = true;
            for (const pi of areas[u].portals) {
                const P = portals[pi];
                if (!P.navigable) continue;
                const v = P.front === u ? P.back : P.front, pp = P.navPoint();
                if (areas[v].vehicle || areas[u].vehicle) continue;
                if (!areas[v].nav) continue;
                const cost = dist[u] + v3.dist(areas[u].hub, pp) + v3.dist(pp, areas[v].hub);
                if (cost < dist[v]) { dist[v] = cost; prev[v] = { area: u, portal: P }; }
            }
        }
        if (dist[to] === Infinity) return null;
        const path = [];
        for (let a = to; a !== from; a = prev[a].area) path.unshift({ area: a, portal: prev[a].portal });
        return path;
    }
}

return { NavGraph };
});
