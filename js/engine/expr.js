'use strict';
// Expr: the small, safe expression language scenarios use wherever data has to compute something: HUD templates,
// sound parameters, links between features, conditions. It is parsed here (never eval'd), so a dropped scenario
// can't run code.
//
//   literals     1.5  2e3  'text'  "text"  true  false  null
//   names        rain  fps  river.flow.volume  sky['rain']      (looked up in the scope; missing -> undefined)
//   operators    ?:  ||  &&  ??  == != < <= > >=  + - * / %  unary - ! ; ( )
//   functions    min max abs floor ceil round sqrt pow exp log sin cos clamp lerp mix smoothstep step sign hypot
//                len (array length) contains(text, part) rand(a, b) fixed(x, digits) num(x) dist(x) pct(x) onoff(x)
//
// Templates: "flow {river.flow.volume|num} m³ · {fps|0} fps" — each {expr|format} is evaluated and formatted
// (format: a digit count, or one of the formatter names below, optionally with an argument after ':').

const Expr = (() => {
    const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
    const FUNCS = {
        min: Math.min, max: Math.max, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round,
        sqrt: Math.sqrt, pow: Math.pow, exp: Math.exp, log: Math.log, sin: Math.sin, cos: Math.cos, sign: Math.sign,
        hypot: Math.hypot,
        clamp: (x, a = 0, b = 1) => clamp(x, a, b),
        lerp: (a, b, t) => a + (b - a) * t,
        mix: (a, b, t) => a + (b - a) * t,
        smoothstep: (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); },
        step: (e, x) => (x < e ? 0 : 1),
        len: a => (a == null ? 0 : a.length),
        rand: (a = 0, b = 1) => a + Math.random() * (b - a),
        contains: (s, x) => String(s ?? '').includes(String(x)),
        fixed: (x, d = 0) => Number(x).toFixed(d),
        num: x => FORMATS.num(x),
        dist: x => FORMATS.dist(x),
        pct: x => FORMATS.pct(x),
        onoff: x => FORMATS.onoff(x),
    };

    // value formatters for templates: {x|name} or {x|name:arg}
    const FORMATS = {
        num(x, unit = '') {
            if (typeof x !== 'number' || !isFinite(x)) return String(x ?? '-');
            const a = Math.abs(x);
            if (a >= 1e9) return `${(x / 1e9).toFixed(2)}G${unit}`;
            if (a >= 1e6) return `${(x / 1e6).toFixed(2)}M${unit}`;
            if (a >= 1e4) return `${(x / 1e3).toFixed(1)}k${unit}`;
            return `${x.toFixed(a < 10 ? 1 : 0)}${unit}`;
        },
        dist(m) {
            if (typeof m !== 'number' || !isFinite(m)) return '-';
            const a = Math.abs(m);
            if (a < 1) return `${(m * 100).toFixed(1)} cm`;
            if (a < 1e4) return `${m.toFixed(a < 100 ? 2 : 0)} m`;
            if (a < 1e8) return `${(m / 1e3).toFixed(a < 1e6 ? 2 : 0)} km`;
            return `${(m / 1.495978707e11).toFixed(3)} AU`;
        },
        pct: x => `${Math.round((x || 0) * 100)}%`,
        int: x => (typeof x === 'number' ? Math.round(x).toLocaleString() : String(x ?? '-')),
        onoff: x => (x ? '<span class="on">on</span>' : '<span class="off">off</span>'),
        yesno: x => (x ? 'yes' : 'no'),
        ms: x => (typeof x === 'number' ? `${x.toFixed(2)} ms` : '-'),
        upper: x => String(x ?? '').toUpperCase(),
        raw: x => String(x ?? ''),
    };

    // ------------------------------------------------------------------------------------------- tokenizer
    const TOKEN = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|([A-Za-z_$][\w$]*)|(\?\?|\|\||&&|==|!=|<=|>=|[-+*/%<>!?:().,[\]]))/y;
    function tokenize(src) {
        const out = [];
        TOKEN.lastIndex = 0;
        while (TOKEN.lastIndex < src.length) {
            const at = TOKEN.lastIndex, m = TOKEN.exec(src);
            if (!m) {
                if (/^\s*$/.test(src.slice(at))) break;
                throw new Error(`Expr: unexpected '${src.slice(at, at + 8)}' in "${src}"`);
            }
            if (m[1] !== undefined) out.push({ t: 'num', v: Number(m[1]) });
            else if (m[2] !== undefined) out.push({ t: 'str', v: m[2].slice(1, -1).replace(/\\(.)/g, '$1') });
            else if (m[3] !== undefined) out.push({ t: 'id', v: m[3] });
            else out.push({ t: 'op', v: m[4] });
        }
        return out;
    }

    // ------------------------------------------------------------------------------------------- parser
    // Recursive descent straight into closures: each node is (scope) => value.
    function parse(src) {
        const toks = tokenize(src);
        let i = 0;
        const peek = v => toks[i] && toks[i].t === 'op' && toks[i].v === v;
        const take = v => { if (!peek(v)) throw new Error(`Expr: expected '${v}' in "${src}"`); i++; };

        const ternary = () => {
            const c = binary(0);
            if (!peek('?')) return c;
            i++;
            const a = ternary();
            take(':');
            const b = ternary();
            return s => (c(s) ? a(s) : b(s));
        };
        const LEVELS = [['??'], ['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/', '%']];
        const OPS = {
            '??': (a, b) => s => a(s) ?? b(s),
            '||': (a, b) => s => a(s) || b(s),
            '&&': (a, b) => s => a(s) && b(s),
            '==': (a, b) => s => a(s) == b(s),      // eslint-disable-line eqeqeq
            '!=': (a, b) => s => a(s) != b(s),      // eslint-disable-line eqeqeq
            '<': (a, b) => s => a(s) < b(s),
            '<=': (a, b) => s => a(s) <= b(s),
            '>': (a, b) => s => a(s) > b(s),
            '>=': (a, b) => s => a(s) >= b(s),
            '+': (a, b) => s => a(s) + b(s),
            '-': (a, b) => s => a(s) - b(s),
            '*': (a, b) => s => a(s) * b(s),
            '/': (a, b) => s => a(s) / b(s),
            '%': (a, b) => s => a(s) % b(s),
        };
        const binary = level => {
            if (level === LEVELS.length) return unary();
            let a = binary(level + 1);
            while (toks[i] && toks[i].t === 'op' && LEVELS[level].includes(toks[i].v)) {
                const op = toks[i++].v, b = binary(level + 1);
                a = OPS[op](a, b);
            }
            return a;
        };
        const unary = () => {
            if (peek('-')) { i++; const a = unary(); return s => -a(s); }
            if (peek('+')) { i++; const a = unary(); return s => +a(s); }
            if (peek('!')) { i++; const a = unary(); return s => !a(s); }
            return postfix(primary());
        };
        const postfix = node => {
            for (;;) {
                if (peek('.')) {
                    i++;
                    const t = toks[i++];
                    if (!t || t.t !== 'id') throw new Error(`Expr: expected a name after '.' in "${src}"`);
                    const k = t.v, o = node;
                    node = s => { const v = o(s); return v == null ? undefined : safeGet(v, k); };
                } else if (peek('[')) {
                    i++;
                    const key = ternary(), o = node;
                    take(']');
                    node = s => { const v = o(s); return v == null ? undefined : safeGet(v, key(s)); };
                } else return node;
            }
        };
        const primary = () => {
            const t = toks[i++];
            if (!t) throw new Error(`Expr: unexpected end of "${src}"`);
            if (t.t === 'num' || t.t === 'str') { const v = t.v; return () => v; }
            if (t.t === 'op' && t.v === '(') { const a = ternary(); take(')'); return a; }
            if (t.t === 'id') {
                if (t.v === 'true') return () => true;
                if (t.v === 'false') return () => false;
                if (t.v === 'null') return () => null;
                if (peek('(')) {
                    const fn = FUNCS[t.v];
                    if (!fn) throw new Error(`Expr: unknown function ${t.v}() in "${src}"`);
                    i++;
                    const args = [];
                    if (!peek(')')) { do { args.push(ternary()); } while (peek(',') && ++i); }
                    take(')');
                    return s => fn(...args.map(a => a(s)));
                }
                const k = t.v;
                return s => (s == null ? undefined : safeGet(s, k));
            }
            throw new Error(`Expr: unexpected '${t.v}' in "${src}"`);
        };

        const root = ternary();
        if (i < toks.length) throw new Error(`Expr: unexpected '${toks[i].v}' in "${src}"`);
        return root;
    }

    // property reads only: no prototype walking into functions / constructors
    function safeGet(o, k) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') return undefined;
        const v = o instanceof Map ? o.get(k) : o[k];
        return typeof v === 'function' ? undefined : v;
    }

    const cache = new Map();
    function compile(src) {
        if (typeof src === 'number' || typeof src === 'boolean') return () => src;
        let fn = cache.get(src);
        if (!fn) { fn = parse(String(src)); cache.set(src, fn); }
        return fn;
    }

    // {expr} / {expr|fmt} / {expr|fmt:arg} inside text; {{ and }} are literal braces
    function template(text) {
        const parts = [];
        let last = 0;
        const re = /\{\{|\}\}|\{([^{}]+)\}/g;
        let m;
        while ((m = re.exec(text))) {
            if (m.index > last) parts.push(text.slice(last, m.index));
            if (m[0] === '{{') parts.push('{');
            else if (m[0] === '}}') parts.push('}');
            else {
                const bar = m[1].lastIndexOf('|');
                const hasFmt = bar > 0 && !/[|&]$/.test(m[1].slice(0, bar)) && /^[\w:.³²°%/ -]*$/.test(m[1].slice(bar + 1));
                const ex = compile(hasFmt ? m[1].slice(0, bar) : m[1]);
                let fmt = null;
                if (hasFmt) {
                    const [name, arg] = m[1].slice(bar + 1).split(':');
                    if (/^\d+$/.test(name)) { const d = +name; fmt = v => (typeof v === 'number' ? v.toFixed(d) : String(v ?? '-')); }
                    else if (FORMATS[name]) fmt = v => FORMATS[name](v, arg);
                    else throw new Error(`Expr: unknown format '${name}' in "${text}"`);
                }
                parts.push(s => { const v = ex(s); return fmt ? fmt(v) : String(v ?? '-'); });
            }
            last = re.lastIndex;
        }
        if (last < text.length) parts.push(text.slice(last));
        return s => parts.map(p => (typeof p === 'string' ? p : p(s))).join('');
    }

    return {
        compile,
        template,
        eval: (src, scope) => compile(src)(scope),
        FORMATS,
        FUNCS,
    };
})();

if (typeof module !== 'undefined') module.exports = Expr;
