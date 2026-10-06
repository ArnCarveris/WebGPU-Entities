> **In WebGPU Entities** this is the README of the original [WebGPU-EntityGUI](https://github.com/ArnCarveris/WebGPU-EntityGUI) demo, kept as the
> feature's technical reference. Its engine now lives in [`js/features/gui/`](../../js/features/gui/) (one part per responsibility, run by the
> host in [`js/engine/host.js`](../../js/engine/host.js)), and its scenario is [`scenarios/gui-sector-07.json`](../../scenarios/gui-sector-07.json) as a list of
> entities: every native key below is an entity of type `gui.<key>` (see the main [README](../../README.md#everything-is-an-entity)).
> Paths and run instructions below refer to the original repository.

# Entity GUI // WebGPU

Doom 3-style world-space GUIs in WebGPU: an airlock terminal with CCTV, a paint easel and a handheld
debug phone (radar, camera, gallery, IPTV), in a small facility built entirely from data.

Open `index.html` in a WebGPU browser (Chrome/Edge 113+, or Brave with
WebGPU enabled). It uses classic `<script>` files, so it also runs straight from disk.

## How a GUI surface works (`EntityGUI`)

Every screen is an `EntityGUI` (`js/gui/entity-gui.js`), modelled on Doom 3:

- **Surface**: a rectangle on an entity. Its texture coordinates define the GUI frame.
- **GUI model**: each frame the GUI draws textured quads into its own virtual screen (e.g. 640x480)
  through a `DeviceContext` (`idDeviceContext`), producing a `GuiModel` split into per-material
  surfaces (`idGuiModel`).
- **Placement**: the model is put on the surface with a matrix from the surface's texture axes
  (`R_SurfaceToTextureAxis` / `R_RenderGuiSurf`).
- **Cursor**: the view ray is traced against the surface (`GuiTrace`); the nearest GUI in use range
  gets the cursor (`InteractionSystem`).
- **Compositing**: the surface geometry writes the GUI's own stencil value where it is visible; the
  GUI quads then draw with depth ALWAYS + stencil EQUAL. No z-fighting, correct occlusion, and GUIs
  can't draw through each other.

Subclasses implement `draw(dc, now)` and input hooks (`onPress`, `pointerDrag`, `pointerUp`, `wheel`,
`drawRangeHint`, `drawCursor`): `TerminalGUI`, `EaselGUI`, `PhoneGUI`.

GUI materials are named textures: `atlas` (fonts / images), `cctv`, `viewfinder`, `photos`, `video`
(texture array), `tv`, `paint:<easel id>`. `dc.setMaterial(name)` starts a new surface.

## Layout

```
js/core/        math, audio
js/render/      MaterialTable, geometry (MeshBuilder, GuiSurface), WGSL shaders, Renderer / RenderView / RenderTarget / ScenePass
js/gui/         GuiAtlas, DeviceContext + GuiModel, EntityGUI, TerminalGUI, EaselGUI, PhoneGUI, phone apps
js/systems/     render-target systems: CctvSystem, PhoneCamera + MediaLibrary, IptvPlayer, PaintCanvas
js/world/       entity classes (ENTITY_TYPES) and World (facility state, actions, lights, sound waves)
js/game/        PlayerController, InputSystem, InteractionSystem, PhoneDevice, Bindings, Game (frame loop)
js/scenario.js  the whole demo as data
js/main.js      entry point
```

## Changing the scenario (`js/scenario.js`)

- **Geometry / models**: `models.<name>` is a list of `box` / `cylinder` parts with material names.
- **Materials**: `materials.<name>` gives a world material its `albedo`, `spec`, `shin`, a procedural
  `pattern` (`flat`, `panels`, `grating`, `mottled`, `plates`, `door`, `tiles`, `hazard`, `bands`,
  `wood`, tuned by `args`) and an optional `emissive` block driven by a `signal` (`constant`, `wave`,
  `blink`, `alarm`, `light0`). The table is uploaded to a storage buffer that the scene shader indexes
  with each vertex's material id (`js/render/materials.js`).
- **Entities**: `entities` lists `{ type, id, ... }`; `type` maps to a class in `ENTITY_TYPES`
  (`static`, `door`, `lamp`, `alarmBeacon`, `light`, `drone`, `securityCamera`, `avatar`,
  `terminal`, `easel`). Add a camera, light or easel by adding an entry. Up to 6 lights; the first
  one also lights the bulb material.
- **GUI surfaces**: `terminal` / `easel` entries carry a `gui` block (`size` in metres, `virtual`
  resolution, `range`, `crt`, `zOffset`) and their content (texts, codes, brushes, palette...).
- **Phone pages**: `phone.pages` are data. Cells (`nav`, `switch`, `slider`, `label`, `action`,
  `picker`, `text`) read and write game state through named bindings in `js/game/bindings.js`;
  pages with `app` are drawn by a `PhoneApp` (`js/gui/phone-apps.js`).
- **Systems**: `cctv`, `media`, `iptv` (channels), `radar` (tracked objects), `waves`, `places`.

### The phone is the engine's handheld (WebGPU Entities)

In WebGPU Entities the phone is not this world's: it is the engine's handheld ([`js/engine/handheld.js`](../../js/engine/handheld.js)),
in every scenario, and `EntityGUI`, `PhoneGUI` and the rest of the toolkit live in [`js/engine/gui-kit.js`](../../js/engine/gui-kit.js).
This facility lends it its `phone.pages` (their root sections lead the root page), its `Bindings`, its apps (radar,
camera, gallery, viewer, IPTV) and its render targets, and, while its player has the camera, its stride and lights.
`gui.phone` keeps `links` and `pages`; the handheld's own look (model, screen, pose, `startShown`) is the `handheld`
entity. A scenario's HUD is `handheld.page` entities (see the main [README](../../README.md#engine-entities)).

## Adding a new kind of screen

1. Subclass `EntityGUI` and implement `draw(dc, now)` (+ `onPress` etc.).
2. Add an entity class that creates it, returns it from `get guis()` and calls `gui.setTransform()`.
3. Register the entity in `ENTITY_TYPES` and place it in `scenario.entities`.
