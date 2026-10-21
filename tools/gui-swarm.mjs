// Generates scenarios/gui-swarm.json from scenarios/gui-stress.json's facility (materials, models, sounds, apps,
// handheld): hundreds of world-space EntityGUIs of every kind, size, orientation and page.
// scenarios/gui-swarm.json is generated: edit this, then run it and the embed tool.
//
//   node tools/gui-swarm.mjs && node tools/embed-scenarios.mjs
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = JSON.parse(readFileSync(join(root, 'scenarios/gui-stress.json'), 'utf8'));
const keep = new Set(['waves', 'material', 'model', 'sound.bed', 'sound.cue', 'cctv', 'media', 'iptv', 'handheld', 'phone', 'radar']);
const out = [];
for (const e of base.entities) {
    if (!e.type && e.$comment) { out.push(e); continue; }
    if (keep.has(e.type) && !(e.type === 'model' && e.id === 'floor')) out.push(structuredClone(e));
}

let seed = 0x5eed;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = a => a[Math.floor(rand() * a.length)];
const r3 = v => Math.round(v * 1000) / 1000;
const P = a => a.map(r3);

// models: the terminal at other scales, and a panel (the terminal's screen and bezel, no stand or pipes) for wall
// mounts and hovering screens
const terminal = out.find(e => e.type === 'model' && e.id === 'terminal');
const scalePart = (p, s) => p.box ? { ...p, box: p.box.map(v => r3(v * s)) }
    : { ...p, cylinder: p.cylinder.map(v => r3(v * s)), r: r3(p.r * s), len: r3(p.len * s) };
const model = (id, parts, s) => ({ type: 'model', id, parts: parts.map(p => scalePart(p, s)) });
const panelParts = terminal.parts.filter(p => p.box && p.box[1] > -0.85);
const models = {};
const terminalModel = s => {
    const id = s === 1 ? 'terminal' : `terminal-x${s}`;
    if (s !== 1 && !models[id]) out.push(models[id] = model(id, terminal.parts, s));
    return id;
};
const panelModel = s => {
    const id = `panel-x${s}`;
    if (!models[id]) out.push(models[id] = model(id, panelParts, s));
    return id;
};

out.push({ type: 'facility', log: ['GUI SWARM HALL ONLINE', 'EVERY SCREEN HERE IS ITS OWN ENTITYGUI', 'TIP: TAB, ENGINE: GUI RENDER MODE'] });
out.push({ type: 'model', id: 'hall', parts: [
    { box: [-70, -0.1, -70, 70, 0, 70], mat: 'floorGrate' },
    { box: [-12, 0, -31.4, 12, 6.2, -31], mat: 'wall' }
] });
out.push({ type: 'static', id: 'hall', model: 'hall' });
out.push({ type: 'door', id: 'hatchB', name: 'Hatch B', model: 'doorPanel', pos: [14, 1.3, -31.2], travel: 1, speed: 0.7,
    panels: [{ pos: [13.5, 1.3, -31.1], slide: [-1, 0, 0] }, { pos: [14.5, 1.3, -31.1], slide: [1, 0, 0] }] });

const PAGES = ['main', 'cctv', 'keypad'];
const MEMOS = [
    ['EACH SCREEN IS ITS OWN ENTITYGUI', 'ITS OWN MODEL, BUFFER AND STENCIL VALUE'],
    ['HATCH CODE ON THE PLAZA RING', 'IS STILL 3-9-6'],
    ['STENCIL VALUES RUN OUT AT 255', 'THE REST FALL BACK TO THE DEPTH TEST'],
    ['MAINTENANCE: SCREENS 140-160', 'FLICKER AT GRAZING ANGLES']
];
const SCOPES = ['REACTOR FEED // CH-2', 'COOLANT LOOP // CH-4', 'SWARM LOAD // CH-7', 'GRID BUS // CH-9'];
let n = 0;
const terminals = [];
// a terminal (or panel) with its GUI: s its scale (screen 1.6 x 1.2 m at 1), o { page, crt, title, maxVerts, anchor }
function screen(group, mdl, s, pos, yaw, o = {}) {
    const id = `${group}-${String(n++).padStart(3, '0')}`;
    const t = {
        type: 'terminal', id, model: mdl, pos: P(pos), yaw: r3(yaw),
        gui: { id, size: P([1.6 * s, 1.2 * s]), virtual: [640, 480], crt: o.crt ?? true, range: r3(Math.max(3.6, 3.6 * s)),
            anchorMaterial: o.anchor || 'glass', maxVerts: o.maxVerts || 8000, hintRange: r3(Math.max(12, 12 * s)) },
        content: {
            door: 'hatchB', hatchCode: '396', page: o.page || 'main',
            titles: { main: o.title || `SWARM // ${id.toUpperCase()}`, cctv: `${id.toUpperCase()} // SECURITY`, keypad: 'AUTHORIZATION REQUIRED' },
            scopeLabel: pick(SCOPES), memo: pick(MEMOS)
        }
    };
    terminals.push(t);
    return t;
}
const face = (x, z, cx = 0, cz = 0) => Math.atan2(cx - x, cz - z);     // the yaw whose +z points at (cx, cz)

// 1. the plaza ring: 36 full-size terminals facing the centre, every page, CRT and flat
for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2, x = Math.sin(a) * 14, z = Math.cos(a) * 14;
    screen('ring', 'terminal', 1, [x, 1.5, z], face(x, z), { page: PAGES[i % 3], crt: i % 4 !== 3 });
}

// 2. the video wall: 12 x 6 half-size panels on the wall at z = -31
for (let row = 0; row < 6; row++) for (let col = 0; col < 12; col++) {
    const x = (col - 5.5) * 1.0, y = 0.7 + row * 0.82;
    screen('wall', panelModel(0.5), 0.5, [x, y, -30.94], 0,
        { page: (row + col) % 5 === 0 ? 'cctv' : (row * 12 + col) % 7 === 0 ? 'keypad' : 'main', crt: (row + col) % 2 === 0 });
}

// 3. the swarm: 144 small panels hovering at random heights and yaws east of the plaza (grazing angles, overlaps)
for (let i = 0; i < 144; i++) {
    const s = pick([0.15, 0.25, 0.25, 0.35, 0.5]);
    const x = 22 + rand() * 20, z = -12 + rand() * 24, y = 0.4 + rand() * 4.2;
    screen('swarm', panelModel(s), s, [x, y, z], rand() * Math.PI * 2,
        { page: pick(PAGES), crt: rand() < 0.6, anchor: rand() < 0.2 ? 'darkMetal' : 'glass' });
}

// 4. the overlap stack: 16 panels 0.2 m apart, each 0.25 m to the side of the one in front (GUIs behind GUIs)
for (let i = 0; i < 16; i++)
    screen('stack', panelModel(1), 1, [-26 + i * 0.25, 1.6 + (i % 2) * 0.15, 6 - i * 0.2], 0, { page: PAGES[i % 3], crt: i % 2 === 0 });

// 5. the giants: terminals at 4x to 16x out on the floor's corners, facing the plaza
[[4, -45, 45], [6, 45, 45], [10, 50, -50], [16, -50, -55]].forEach(([s, x, z]) =>
    screen('giant', terminalModel(s), s, [x, 1.5 * s, z], face(x, z), { page: s === 6 ? 'cctv' : 'main',
        title: `GIANT x${s} // ${(1.6 * s).toFixed(1)} M WIDE` }));
out.push(...terminals);

// 6. the easel gallery: 24 easels in two facing rows west of the plaza, each its own paint target at its own resolution,
// palette and brushes
const easelBase = JSON.parse(readFileSync(join(root, 'scenarios/gui/gui-sector-07.json'), 'utf8')).entities.find(e => e.type === 'easel');
const RES = [[508, 456], [1016, 912], [1016, 912], [2032, 1824]];
const PAPERS = [[0.95, 0.93, 0.88], [0.98, 0.98, 0.98], [0.86, 0.82, 0.72], [0.12, 0.12, 0.14], [0.8, 0.88, 0.95]];
const easels = [];
for (let i = 0; i < 24; i++) {
    const side = i < 12 ? -1 : 1, k = i % 12, id = `easel-${String(i).padStart(2, '0')}`;
    const paint = structuredClone(easelBase.paint);
    paint.resolution = i === 23 ? [2032, 1824] : RES[i % 3];
    paint.paper = PAPERS[i % PAPERS.length];
    const pal = paint.palette.length, from = i % pal, count = 4 + (i % 9);
    paint.palette = Array.from({ length: count }, (_, j) => paint.palette[(from + j) % pal]);
    paint.initialColor = 0;
    paint.brushes = paint.brushes.filter((b, j) => j === 0 || (i + j) % 3 !== 0);
    paint.size.initial = 6 + (i * 5) % 30;
    const x = -40 + k * 2.2, z = side * 3.2;
    easels.push({ type: 'easel', id, model: 'easel', pos: P([x, 1.45, z - 18]), yaw: side < 0 ? 0 : Math.PI, collider: 0.75,
        gui: { ...easelBase.gui, id }, paint });
}
out.push(...easels);

// security cameras over every area: the CCTV pages' feeds (one feed a frame, the selected camera's)
[
    ['cam01', 'PLAZA RING', 'HALL / CENTRE', [0, 7, 18], [0, 1.5, 0], 0.4, 0.2],
    ['cam02', 'VIDEO WALL', 'HALL / NORTH', [8, 5.5, -22], [0, 2.7, -31], 0.25, 0.3],
    ['cam03', 'THE SWARM', 'HALL / EAST', [20, 6, 10], [32, 2.2, 0], 0.35, 0.25],
    ['cam04', 'OVERLAP STACK', 'HALL / WEST', [-20, 3, 10], [-24.5, 1.7, 4], 0.1, 0.5],
    ['cam05', 'EASEL GALLERY', 'HALL / NORTH-WEST', [-14, 4, -18], [-40, 1.4, -18], 0.2, 0.3],
    ['cam06', 'GIANT X16', 'HALL / FAR CORNER', [-20, 12, -20], [-50, 24, -55], 0, 0]
].forEach(([id, name, loc, pos, target, sweep, speed]) => out.push({ type: 'securityCamera', id, label: id.toUpperCase().replace('CAM', 'CAM-'),
    name, loc, model: 'securityCamera', pos, target, sweep, speed }));

// six lights (the facility's limit), over the areas
out.push(
    { type: 'light', id: 'plaza', pos: [0, 6, 0], color: [0.75, 0.82, 1], intensity: 2.2 },
    { type: 'light', id: 'wallGlow', pos: [0, 3, -27], color: [0.3, 0.75, 1], intensity: 2.5 },
    { type: 'light', id: 'swarmGlow', pos: [32, 3, 0], color: [0.35, 1, 0.6], intensity: 2.5 },
    { type: 'light', id: 'stackGlow', pos: [-24, 2.5, 8], color: [1, 0.6, 0.3], intensity: 1.6 },
    { type: 'light', id: 'gallery', pos: [-28, 4, -18], color: [1, 0.86, 0.66], intensity: 2.4 },
    { type: 'light', id: 'fill', pos: [0, 30, 0], color: [0.4, 0.45, 0.55], intensity: 0.6, roomLights: true }
);

const phone = out.find(e => e.type === 'phone');
phone.links = { door: 'hatchB', terminal: 'ring-000', easel: 'easel-00' };
const radar = out.find(e => e.type === 'radar');
radar.range = 30;
radar.tracked = [
    { name: 'Plaza terminal', entity: 'ring-000', color: [90, 200, 250], shape: 'diamond' },
    { name: 'Hatch B', entity: 'hatchB', color: [255, 149, 0], shape: 'bar' },
    { name: 'Easel gallery', entity: 'easel-00', color: [175, 82, 222], shape: 'diamond' }
];
out.find(e => e.type === 'handheld').startShown = false;

out.push(
    { type: 'player', start: { pos: [0, 1.6, 0], yaw: Math.PI, pitch: 0 }, fovDeg: 60, far: 2000, walkSpeed: 4, runSpeed: 12,
        stride: { walk: 0.72, run: 0.95 }, bounds: { x: [-68, 68], z: [-30.5, 68] } },
    { type: 'hud.toast', text: `${terminals.length + easels.length} world-space GUIs · TAB: views and the GUI render mode`, ms: 6000 },
    { type: 'view', of: 'gui', name: 'Overview', sub: 'the whole hall from above', pos: [0, 38, 52], look: [0, 0, -6] },
    { type: 'view', of: 'gui', name: 'Plaza ring', sub: '36 terminals facing in', pos: [0, 1.6, 0], look: [0, 1.5, -14] },
    { type: 'view', of: 'gui', name: 'Plaza from outside', sub: 'the ring through itself', pos: [0, 4, 26], look: [0, 1.5, 0] },
    { type: 'view', of: 'gui', name: 'Video wall', sub: '72 panels on one wall', pos: [0, 2.7, -21], look: [0, 2.7, -31] },
    { type: 'view', of: 'gui', name: 'Video wall, close', sub: 'a few panels at reading distance', pos: [-1, 2.3, -29.4], look: [-1, 2.3, -31] },
    { type: 'view', of: 'gui', name: 'Swarm', sub: '144 hovering panels at every angle', pos: [14, 2.5, 0], look: [32, 2.2, 0] },
    { type: 'view', of: 'gui', name: 'Inside the swarm', sub: 'GUIs overlapping GUIs', pos: [32, 2, 0], look: [40, 2.4, 6] },
    { type: 'view', of: 'gui', name: 'Overlap stack', sub: '16 panels one behind the other', pos: [-23, 1.7, 9], look: [-24.5, 1.7, 4] },
    { type: 'view', of: 'gui', name: 'Overlap stack, grazing', sub: 'the stack edge-on', pos: [-17, 1.7, 5], look: [-26, 1.7, 3.5] },
    { type: 'view', of: 'gui', name: 'Easel gallery', sub: '24 easels, 24 paint targets', pos: [-16, 1.7, -18], look: [-40, 1.4, -18] },
    { type: 'view', of: 'gui', name: 'Giant x16', sub: '25.6 m terminal', pos: [-28, 8, -30], look: [-50, 24, -55] },
    { type: 'view', of: 'gui', name: 'Giants', sub: 'x4 to x16 from the plaza', pos: [0, 10, 0], look: [-45, 6, 45] }
);

const total = terminals.length + easels.length;
const scenario = {
    name: 'GUI swarm stress',
    group: 'Entity GUI',
    description: `${total} world-space EntityGUIs at once: a ring of terminals, a 72-panel video wall, 144 hovering panels at every angle, ` +
        'a stack of overlapping screens, giants up to 25 m wide and 24 easels with their own paint targets, on every terminal page, ' +
        'CRT and flat. More GUIs than the 8-bit stencil has values: the rest fall back to the depth test.',
    entities: out
};
writeFileSync(join(root, 'scenarios/gui-swarm.json'), JSON.stringify(scenario, null, 4) + '\n');
console.log(`gui-swarm.json: ${terminals.length} terminals, ${easels.length} easels, ${out.length} entities`);
