# Test sequences

Browser tests as data: each test is a JSON file in `tests/sequences/`, an ordered list of steps run on one or more
scenarios in an isolated Brave over CDP, with the deterministic page of `docs/single-world-plan.md` §6.1 (fake clock,
seeded random, stepped frames, counters; real input over the test window dropped). The code lives in the steps, the
`Action` subclasses in `tools/harness/actions.mjs`; the Brave, the snapshot server and the page's prelude in
`tools/harness/browser.mjs` (shared with `tools/pixel-harness.mjs`). A new test is a JSON edit. A check that no
action can express gets a new `Action` subclass, never ad-hoc JS in a scratchpad.

```bash
node tools/seq.mjs list
node tools/seq.mjs run                       # every sequence; exit 1 on a failure
node tools/seq.mjs run smoke camera-*        # names or globs
node tools/seq.mjs run scenario-views --scenario gui-stress --scenario cloud-oahu
node tools/seq.mjs run perf-ab --revs 0cb33ff,HEAD
node tools/seq.mjs record sky-sunlight       # write what a sequence compares with
```

Options: `--scenario id` (repeatable), `--baselines dir` (the baseline PNGs and their `manifest.json`; `baselines/` or
`$BASELINES`: the PNGs are gitignored, so a fresh worktree points at a checkout that has them), `--work dir` (the Brave profile and every output, `<os tmp>/webgpu-entities-seq`
by default), `--rev commit` (serve that commit's files; by default a copy of the checkout made when the run starts,
`--live` the checkout itself), `--revs a,b` (perf), `--query k=v` (added to every page URL), `--report` (pixel
differences printed, not failures), `--frames N` / `--view-frames N`, `--port N` (9371), `--serve-port N` (9381),
`--brave path`, `--keep`, `--bail`. Run long sequences in the background: all of them take about half an hour.

## A sequence

```json
{
  "description": "what it checks and why",
  "scenarios": "*",
  "options": { "query": ["render.depth=reversed"], "report": true, "viewFrames": 20 },
  "steps": [
    { "action": "open" },
    { "action": "step", "frames": 40 },
    { "action": "capture", "name": "start" },
    { "action": "compare", "name": "start", "against": "baseline" },
    { "if": "entities.moves.includes('walk')", "action": "move", "mode": "walk" },
    { "action": "expect", "expr": "entities.controller?.id", "equals": "sector" },
    { "action": "errors" }
  ]
}
```

- `scenarios`: `"*"` (every scenario in `scenarios/index.json`), an id, a list of ids, or `{ "group": "Tours", "exclude": [...] }`.
  The steps run once per scenario (a case), in a fresh tab; a failing step is reported and the case goes on, a step
  that can't go on (no page, an expression that throws) ends the case.
- Any step may have `"if": "<page expression>"`, `"only": [ids]`, `"skip": [ids]` and `"note"`.
- Values: `{ "$": "name" }` reads a variable (stored by `eval`, `eye`, `counts`, `submits`, `kits`, `perf`), and
  `"${scenario}"` in a string is the case's scenario.

## Files

- `tests/sequences/<name>.json`: the sequence (committed).
- `tests/sequences/<name>/`: its sidecar, for what the sequence compares with or needs: JSON goldens (`expect` with
  `golden`), expected pictures (`compare` with `"against": "sidecar"`), fixtures, notes (committed; keep pictures
  small, a `region` capture, and only where they don't depend on the GPU).
- `baselines/<scenario>/*.png`: the pixel baselines of every view (machine-specific, gitignored, about 90 MB), with the
  committed `baselines/manifest.json` (views, counts, kits, the noise between Brave sessions) and the committed format
  goldens `baselines/format/*.json`. `node tools/pixel-harness.mjs record` measures the noise (two sessions per scenario);
  `seq.mjs record` writes pictures, counts and kits but keeps the recorded noise.
- `<work>/<sequence>/<scenario>/`: what a run makes: captures, `diff/` heat maps, `bindings.json`, `trace.json`,
  `perf.json`, `save` outputs; `<work>/report.json` for the whole run. Never committed.

## Actions

| action | params (default) | does |
|---|---|---|
| `open` | `scenario`, `query` [], `perf`, `trace`, `bindings`, `settle` (true) | a tab on the scenario, waits until the engine is up and nothing loads or bakes; a failed start ends the case |
| `settle` | | waits until no request is in flight and no app loads or bakes |
| `step` | `frames` | frames on the fake clock |
| `wait` | `expr`, `frames` (600), `soft` | steps until the expression is truthy |
| `close` | | closes the tab |
| `view` | `key`, `frames` (viewFrames) | jumps to one view of the View list |
| `views` | `frames`, `compare` (null / "baseline"), `report` | every view in turn, captured as `view-<key>`, compared with the baseline's |
| `eye` | `as` ("eye") | stores the camera's position |
| `move` | `mode`, `frames` (10) | `entities.setMove(mode)`, fails if not taken |
| `travel` | `mode`, `turn` ([160, 0]), `at` ([192, 480]), `code` ("KeyW"), `hold` (30), `frames` (20) | the mode (as `move`), then a drag by `turn` from `at` must turn the camera and `code` held must move the eye, on the page's own input; `turn` null: no look |
| `input` | `enabled` (true) | the page takes the harness's input (key and pointer steps turn it on) |
| `key` | `code`, `key`, `hold` (1), `after` (1) | a key press: down, hold frames, up, after frames |
| `keyDown` / `keyUp` | `code`, `key`, `frames` (0) | one key event |
| `click` | `at` (centre), `button`, `after` (1) | a click |
| `drag` | `from` (centre), `to`, `button`, `moves` (1), `after` (1) | a drag |
| `handheld` | `shown` (true), `frames` (30) | Tab until the handheld is shown / put away |
| `eval` | `expr`, `as`, `frames` (0), `print` | an expression's value (awaited, frames stepped while it waits) |
| `expect` | `expr` or `var`; `equals`, `notEquals`, `near` [v, tol], `gte`, `lte`, `includes`, `excludes`, `matches`, `truthy`, `golden` (sidecar file), `tolerance`, `label` | an expectation |
| `log` / `save` | `expr` or `var`; `file` (save) | prints / writes a value |
| `counts` | `expect` ("baseline" or `{ World: 1, ... }`) | World / Renderer / App constructions |
| `submits` | `expect` (1, [min, max] or "baseline"), `frames`, `writes` | queue.submit (writeBuffer) calls per frame over the last frames |
| `kits` | `expect` ("baseline" or a list), `includes`, `excludes` | `Object.keys(Features.kits)` |
| `errors` | `max` (0), `allow` [regex], `warnings` | console errors and exceptions; the failure fallback |
| `bindings` | | the binding budget of every pipeline layout (open with `bindings`) |
| `trace` | | what each host answers through its extensions (open with `trace`) |
| `capture` | `name`, `region` [x, y, w, h] | a screenshot |
| `sky` | `name`, `region` [x, y, w, h], `as` ("sky"), `min`, `atLeast`, `slack` (0.1) | how much of a capture is sky (blue at least as much as red and green), stored; fails under `min` or another capture's less `slack`: the ground drawn over the eye |
| `pixels` | `name`, `region` [x, y, w, h], `where` (an expression of r, g, b), `as` ("pixels"), `min`, `max` | the share of a capture's pixels where `where` holds, stored; fails over `max` or under `min`: light that should not be on the walls, labels drawn over them |
| `sheet` | `names` (every capture), `cols` (4), `width` (240), `file` ("sheet") | a contact sheet of the case's captures, `<work>/<sequence>/<scenario>/sheet.png` |
| `compare` | `name`, `against` ("baseline" / "sidecar" / "capture"), `file`, `other`, `noise` ("baseline", `{ frac, max }`, 0), `report`, `expectDiffer` | a capture against a picture, with a heat map of any difference |
| `perf` | `revs` (["HEAD~1", "HEAD"]), `rounds` (2), `frames` (40), `measure` (20), `expect` `{ maxRatio }` | GPU time per frame A/B, alternated (pageless) |
| `formatGolden` | `dir` ("baselines/format") | the scenario's format golden (pageless) |
| `singleWorld` | | G8, `tools/check-single-world.mjs`: the code on the first case, the case's scenario (pageless) |

## The sequences

| sequence | checks |
|---|---|
| `scenario-views` | G1/G2/G4/G5 on all 16 scenarios: every view against `baselines/`, 1 World / Renderer / App, 1 submit, kits, no errors |
| `smoke` | G6 on all 16: WASD moves the view, E, F, the handheld, Walk where there is one, drag, Esc, no errors |
| `bindings` | the binding budget of every scenario |
| `depth-reversed` | `render.depth=reversed` on the portal and gui scenarios (pixels reported) |
| `format-golden` | G3 (no browser) |
| `single-world` | G8: `tools/check-single-world.mjs` (no browser) |
| `moves` | every scenario looks (a drag) and moves (W) in fly and in walk, where it offers them |
| `perf-ab` | G7: GPU time A/B, previous commit against this one |
| `camera-start` | the camera starts at `camera.start`'s site view, and that site's camera follows |
| `walk-handover` | Walk walks from where the camera is (the engine's camera, or the sector's player in its rooms, its screens taking the cursor), never jumping; Fly hands it back to Sol |
| `loft-walk` | walking shows what flying does (`sky` above the horizon on the deck and the dock, then a `sheet`); fly, walk (falls, no jump), then at the Loft, outdoors and on the cargo ship (sailing): the bunker's player falls to the floor, looks around, walks on there |
| `bus-ride` | aboard a moving bus on the plains (alone and in the Every kit), by day, dusk and night: the sky through its windscreen (`sky`), no salmon light on its walls (`pixels`: its own tail light, the low sun, only through its glass), no label's yellow over its walls and roof (`pixels`: labels only through its windows, `Interior.hides`); a `sheet` |
| `sky-sunlight` | the sky's site lights the other sites through `world.sunlight` (sidecar goldens) |

Traps: the imposter's foliage differs between Brave sessions (the baseline gate allows twice the recorded noise);
GPU timings are only comparable A/B within one run (the laptop's 3050 Ti throttles); compare after `settle`.
