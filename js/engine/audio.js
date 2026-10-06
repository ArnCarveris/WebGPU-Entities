'use strict';
// AudioEngine: sound as entities. Nothing here knows any feature; scenarios say what to play and when.
//
//   sound.master { gain, muted }
//   sound.bed    a looped source that plays all the time, its level (and filter / pitch) following data each frame:
//                { id, source: white | brown | osc, wave (osc: sine square sawtooth triangle), freq (osc Hz),
//                  filters: [[type, Hz, Q], ...], gain: expr, filter: [index, expr Hz], pitch: expr Hz,
//                  smooth: s (how fast it follows), pan: expr (-1..1) }
//   sound.cue    a one-shot played when a world emits an event: { on: "event" | ["a", "b"], when: expr,
//                  every: [min, max] s (instead of `on`: played again and again, at random intervals, while `when` holds),
//                  parts: [ { tone: [Hz, s, wave, volume, slide-to Hz] , delay },
//                           { noise: { filter, freq, q, vol, dur, offset }, delay },
//                           { shot: { source, filter, freq, q, env: [[t, v], ...], rate, sweep: [Hz, s] }, delay },
//                           { thunder: { near, far, bolt } } ] }
//                Every number can be an expression (a string). Events are "<world id>.<name>" or just "<name>"; the
//                cue scope has the event's fields at top level, `event` (its name) and every world's stats by id.
//
// Bed and cue expressions read the frame scope: { time, dt, fps, focus, <world id>: that world's stats() }.

class AudioEngine {
    static SOUND_SPEED = 343;

    constructor() {
        this.ctx = null;
        this.on = true;
        this.gain = 0.9;
        this.beds = [];
        this.cues = [];
        this.pending = [];
    }

    configure(entities) {
        for (const e of entities) {
            if (e.type === 'sound.master') { this.gain = e.gain ?? this.gain; if (e.muted) this.on = false; }
            else if (e.type === 'sound.bed') this.beds.push({ def: e, node: null, gain: Expr.compile(e.gain ?? 0),
                filter: e.filter ? [e.filter[0], Expr.compile(e.filter[1])] : null, pitch: e.pitch != null ? Expr.compile(e.pitch) : null,
                pan: e.pan != null ? Expr.compile(e.pan) : null, when: e.when != null ? Expr.compile(e.when) : null });
            else if (e.type === 'sound.cue') this.cues.push({ def: e, on: [].concat(e.on || []), when: e.when != null ? Expr.compile(e.when) : null, next: 0 });
        }
    }

    // browsers only allow audio after a user gesture: the first key or click starts it
    start() {
        if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = this.ctx = new AC(), sr = ctx.sampleRate, n = sr * 6;
        this.master = ctx.createGain();
        this.master.gain.value = this.on ? this.gain : 0;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 8; comp.attack.value = 0.002; comp.release.value = 0.35;
        this.master.connect(comp).connect(ctx.destination);
        this.white = ctx.createBuffer(1, n, sr);
        this.brown = ctx.createBuffer(1, n, sr);
        const wd = this.white.getChannelData(0), bd = this.brown.getChannelData(0);
        let last = 0;
        for (let i = 0; i < n; i++) {
            const r = Math.random() * 2 - 1;
            wd[i] = r;
            last = (last + 0.02 * r) / 1.02;
            bd[i] = last * 3.5;
        }
        for (const b of this.beds) b.node = this.bed(b.def);
        for (const [name, payload] of this.pending.splice(0)) this.emit(name, payload);
    }

    toggle() {
        this.on = !this.on;
        this.start();
        if (this.ctx) this.master.gain.setTargetAtTime(this.on ? this.gain : 0, this.ctx.currentTime, 0.05);
        return this.on;
    }

    buffer(name) { return name === 'brown' ? this.brown : this.white; }

    // a looped source (noise or an oscillator) through filters into a gain, silent until update sets it
    bed(def) {
        const ctx = this.ctx, gain = ctx.createGain();
        gain.gain.value = 0;
        let src;
        if (def.source === 'osc') {
            src = ctx.createOscillator();
            src.type = def.wave || 'sine';
            src.frequency.value = def.freq || 110;
        } else {
            src = ctx.createBufferSource();
            src.buffer = this.buffer(def.source);
            src.loop = true;
        }
        let node = src;
        const filters = (def.filters || []).map(([type, f, q]) => {
            const b = ctx.createBiquadFilter();
            b.type = type; b.frequency.value = f; b.Q.value = q ?? 0.7;
            node.connect(b); node = b;
            return b;
        });
        let pan = null;
        if (def.pan != null && ctx.createStereoPanner) { pan = ctx.createStereoPanner(); node.connect(pan); node = pan; }
        node.connect(gain).connect(this.master);
        if (def.source === 'osc') src.start(); else src.start(0, Math.random() * src.buffer.duration);
        return { src, gain, filters, pan };
    }

    // beds follow the frame's data
    update(scope) {
        if (!this.ctx || !this.on) return;
        const t = this.ctx.currentTime;
        for (const b of this.beds) {
            if (!b.node) continue;
            const tc = b.def.smooth ?? 0.25;
            const live = !b.when || b.when(scope);
            const g = live ? num(b.gain(scope)) : 0;
            b.node.gain.gain.setTargetAtTime(Math.max(0, g), t, tc);
            if (b.filter && b.node.filters[b.filter[0]]) b.node.filters[b.filter[0]].frequency.setTargetAtTime(Math.max(10, num(b.filter[1](scope))), t, tc);
            if (b.pitch && b.node.src.frequency) b.node.src.frequency.setTargetAtTime(Math.max(1, num(b.pitch(scope))), t, tc);
            if (b.pan && b.node.pan) b.node.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, num(b.pan(scope)))), t, tc);
        }
        // ambient cues: again and again at random intervals
        for (const c of this.cues) {
            const ev = c.def.every;
            if (!ev) continue;
            const [lo, hi] = [].concat(ev, ev).map(Number);
            if (!c.next) { c.next = t + lo + Math.random() * (hi - lo); continue; }
            if (t < c.next) continue;
            c.next = t + lo + Math.random() * (hi - lo);
            const s = { ...scope, event: 'every' };
            if (c.when && !c.when(s)) continue;
            for (const part of c.def.parts || []) this.play(part, s);
        }
    }

    // an event from a world: "<world>.<name>" (cues may name either form)
    emit(name, payload = {}, scope = {}) {
        if (!this.ctx) { if (this.pending.length < 16) this.pending.push([name, payload]); return; }
        if (!this.on) return;
        const short = name.slice(name.indexOf('.') + 1);
        for (const c of this.cues) {
            if (c.def.every || (!c.on.includes(name) && !c.on.includes(short))) continue;
            const s = { ...scope, ...payload, event: short };
            if (c.when && !c.when(s)) continue;
            for (const part of c.def.parts || []) this.play(part, s);
        }
    }

    play(part, s) {
        const v = x => (typeof x === 'string' ? num(Expr.eval(x, s)) : x);
        // a name (filter type, source, waveform) as is, or an expression giving one
        const name = (x, known, dflt) => (x == null ? dflt : known.includes(x) ? x : String(Expr.eval(x, s) ?? dflt));
        const FILTERS = ['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass'];
        const delay = Math.max(0, v(part.delay ?? 0));
        if (part.tone) {
            const [f, dur, wave, vol, slide] = part.tone;
            this.tone(v(f), v(dur), name(wave, ['sine', 'square', 'sawtooth', 'triangle'], 'square'), v(vol ?? 0.04), slide != null ? v(slide) : null, delay);
        } else if (part.noise) {
            const n = part.noise;
            this.noise({ filter: name(n.filter, FILTERS, 'bandpass'), freq: v(n.freq ?? 1000), q: v(n.q ?? 1), vol: v(n.vol ?? 0.1), dur: v(n.dur ?? 0.1), delay,
                offset: v(n.offset ?? 0), source: name(n.source, ['white', 'brown'], 'white') });
        } else if (part.shot) {
            const sh = part.shot, env = sh.env.map(([t, a]) => [v(t), v(a)]);
            const t0 = this.ctx.currentTime + delay;
            const f = this.shot(this.buffer(name(sh.source, ['white', 'brown'], 'white')), name(sh.filter, FILTERS, 'lowpass'), v(sh.freq ?? 1000), v(sh.q ?? 1), t0, env, v(sh.rate ?? 1));
            if (sh.sweep) f.frequency.linearRampToValueAtTime(v(sh.sweep[0]), t0 + v(sh.sweep[1]));
        } else if (part.thunder) {
            const th = part.thunder;
            this.thunder(v(th.near), v(th.far ?? th.near), !!v(th.bolt ?? 1), delay);
        }
    }

    tone(freq, dur, type = 'square', vol = 0.04, slideTo = null, delay = 0) {
        if (vol <= 0) return;
        const ctx = this.ctx, t0 = ctx.currentTime + delay;
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t0);
        if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
        gain.gain.setValueAtTime(vol, t0);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(gain).connect(this.master);
        osc.start(t0);
        osc.stop(t0 + dur);
    }

    // a filtered noise burst
    noise({ filter = 'bandpass', freq = 1000, q = 1, vol = 0.1, dur = 0.1, delay = 0, offset = 0, source = 'white' }) {
        if (vol <= 0) return;
        const ctx = this.ctx, t0 = ctx.currentTime + delay;
        const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        src.buffer = this.buffer(source);
        f.type = filter; f.frequency.value = freq; f.Q.value = q;
        g.gain.setValueAtTime(vol, t0);
        g.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
        src.connect(f).connect(g).connect(this.master);
        src.start(t0, offset);
        src.stop(t0 + dur + 0.02);
    }

    // a buffer through a filter, its gain ramping through env [[t, v], ...] from t0; returns the filter
    shot(buf, type, freq, q, t0, env, rate = 1) {
        const ctx = this.ctx, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        src.buffer = buf; src.playbackRate.value = rate;
        f.type = type; f.frequency.value = freq; f.Q.value = q;
        g.gain.setValueAtTime(0, t0);
        for (const [t, v] of env) g.gain.linearRampToValueAtTime(v, t0 + t);
        src.connect(f).connect(g).connect(this.master);
        const len = env[env.length - 1][0] + 0.05;
        src.start(t0, Math.random() * Math.max(buf.duration - len * rate - 0.1, 0), len);
        return f;
    }

    // thunder for a flash whose channel is near..far metres away: the near end is heard first and loudest, the rest
    // rolls in after it; a strike within 1.5 km cracks first, with its return strokes
    thunder(near, far, bolt, delay = 0) {
        if (near > 22000) return;
        const t0 = this.ctx.currentTime + delay + near / AudioEngine.SOUND_SPEED;
        const amp = Math.min(1.3, 1500 / (near + 350)) * (bolt ? 1 : 0.55);
        const cut = 110 + 4500 * Math.exp(-near / 1600);
        const len = Math.min(10, Math.max(2.2, 2 + (far - near) / AudioEngine.SOUND_SPEED * 0.8 + near / 3500));
        if (bolt && near < 1500) {
            const k = amp * 1.6 * (1 - near / 1500);
            for (const dt of [0, 0.07 + Math.random() * 0.05, 0.16 + Math.random() * 0.08])
                this.shot(this.white, 'highpass', 900 + 2500 * (1 - near / 1500), 0.5, t0 + dt, [[0.004, k * (dt ? 0.6 : 1)], [0.05, k * 0.35], [0.35, 0]]);
        }
        const env = [[near < 1500 ? 0.03 : 0.3, amp * 0.8]];
        for (let i = 1; i <= 24; i++) {
            const u = i / 24, roll = Math.random() < 0.25 ? 1.3 : 0.45 + 0.5 * Math.random();
            env.push([0.3 + u * len, amp * Math.exp(-2.8 * u) * roll]);
        }
        env.push([len + 0.4, 0]);
        this.shot(this.brown, 'lowpass', cut, 0.8, t0, env, 0.8 + Math.random() * 0.3);
        this.shot(this.brown, 'lowpass', 80, 1.2, t0, [[0.08, amp * 1.4], [len * 0.4, amp * 0.5], [len, 0]], 0.5);
    }
}

function num(x) { return typeof x === 'number' && isFinite(x) ? x : Number(x) || 0; }
