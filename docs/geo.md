# Real places

A cloud world can stand on a real place at 1:1 (1 m = 1 m): its ground from elevation data, its roads and buildings from
OpenStreetMap. [`scenarios/cloud-oahu.json`](../scenarios/cloud-oahu.json) is the island of Oʻahu, a 73.7 km square
about 21.4835 N 157.9645 W.

## Importing a place

```bash
node tools/geo-import.mjs oahu
```

The region is data, in [`tools/geo-regions.json`](../tools/geo-regions.json): its centre (lat, lon), the square's
size (m), the grid (cells a side), the elevation tiles' zoom, the OpenStreetMap extract (a Geofabrik `.osm.pbf` URL),
the sea level. The tool has no dependencies (its own PBF and PNG readers) and downloads its sources once into a cache
(`--cache <dir>`, default `<tmp>/webgpu-entities-geo`; `--pbf <file>` uses an extract already on disk). It writes:

| File | What | From |
|---|---|---|
| `scenarios/data/<region>/terrain.js` | heights (dm, int16), land cover planes (built-up, woods, water), place names and peaks | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium), area-averaged into the cells; the sea outside OpenStreetMap's coastline, flat at the sea level; land cover from landuse / natural / water polygons and the share of each cell under roofs |
| `scenarios/data/<region>/coast.js` | the signed distance to the coastline (u8, ±`band` m, + on land) on a grid twice as fine as the terrain's (18 m for Oʻahu) | OpenStreetMap's coastline rings, the exact distance to their segments within the band: filtered linearly, its zero line follows the coast well inside a cell |
| `scenarios/data/<region>/roads.js` | every `highway=*` way: class, bridge / tunnel / one-way flags, layer, lanes, width, points | OpenStreetMap |
| `scenarios/data/<region>/buildings.js` | every building footprint (ways and multipolygons): kind, height, levels, min height, roof levels, outer ring | OpenStreetMap |

Coordinates are metres about the centre, x east, z south (a local projection with WGS84 metres per degree at each
latitude). Each file is a classic script calling `ScenarioData.put(id, meta, base64)` with the payload deflated, so the
page opened from disk can load it too ([`js/engine/scenario-data.js`](../js/engine/scenario-data.js)); the host loads
every id a scenario's entities name in `data` before it builds the worlds.

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL; each data file carries its
attribution in its meta.

## Entities (the geo kit)

[`js/kits/geo/`](../js/kits/geo/), over any terrain world's entity base (the cloud world's):

| Type | What |
|---|---|
| `geoTerrain` `{ data }` | sets the heights (cell for cell on a field of the data's size and resolution, else sampled) and paints the land cover; stamps after it shape the ground further |
| `geoRoads` `{ data, skip, minor, curves, marks }` | each road a ribbon along its line, its corners rounded into arcs (a radius per class: 450 m on a motorway down to a few metres on a path), sampled every 5 m and kept where it would leave the ground as drawn by more than 5 cm; widths from lanes / width tags or the class; bridges as decks straight between their ends on piers (walkable), tunnels left out; US markings: white edges and lane dashes, double yellow between two-way traffic. `skip`: highway classes to leave out |
| `geoBuildings` `{ data, seed }` | each footprint's walls stood up from the ground to its height (mapped `height`, else `building:levels`, else its kind's), a flat roof (ear-clipped) or a hipped one on a small rectangular house; walls 7 m and taller get rows of windows (the renderer's `facade` material, some lit by night). The walls are Solids for the walker, made per building when asked |
| `geoCanopy` `{ data }` | the tree canopy (cover and height on an 18 m grid, from Meta / WRI's canopy height map v2, CC BY 4.0) given to the field: with the terrain's `vegetation`, plants grow where it covers, sized to its height (low canopy: scrub), the ground's forest shade and the far canopy follow it. Without it, the land use's woods stand in |
| `geoCoast` `{ data }` | the coastline's distance field given to the field (`LandField.setCoast`, sharing the smooth mask's texels: `smoothTex` g): the shore is drawn along it per pixel instead of along the 36 m cells, with the sea's level off it and a beach rising 5 cm per m on land that gives way to the data's heights within 40 m (CPU `surface` and the shader alike, so roads and buildings stay on it); sand of wandering width, wet sand and surf at the water's edge, dark rock where the shore is steep, shallows by distance; plants keep 3 m off it |
| `geoPlaces` `{ data, kinds, height }` | place labels (`place` entities) for the data's places of `kinds` (`{ kind: range m }`, 0 always shown) |

Roads and buildings go into `Structures.bulk`, a [`TiledMesh`](../js/kits/mesh/tiled.js): compact indexed triangles
(position + a colour word with the material) in 2 km tiles, drawn by the tiles in view (the renderer's `vsBulk` /
`fsBulk`, flat-shaded from screen derivatives). Oʻahu: 97,640 buildings and 7,142 km of roads (footways and paths
skipped), about 3 s to build.

## The terrain block

What a real place needs of the cloud world's `terrain`:

| Key | |
|---|---|
| `step` | the finest terrain lod's vertex spacing (m; default 1 with `rough`, else a quarter of a data cell) |
| `detail` | how far each terrain lod reaches (default 1, at least 1): the finest out to 64 x `detail` vertex spacings, each next lod twice as coarse and twice as far. Oʻahu: 2 (1 m out to 128 m, about 8 m at 1 km) |
| `rough` | procedural detail over the data (m, default 0: none): value-noise octaves of 29 to 1.7 m wavelength, about `rough` x 0.25 m on gentle ground and up to 2.25x on cliffs; kept off roads, buildings (`keepSmooth`, painted by geoRoads / geoBuildings), the shore and open water. The heights are drawn bicubic either way |
| `vegetation` | plants (default false): broadleaf trees, kiawe, coconut palms and shrubs scattered each frame on a 6 m lattice about the eye from the land cover (woods, built-up, water, the shore), full meshes within 250 m, octahedral imposters (the imposter kit) to 1.5 km, then the canopy carpet: the same lattice's crowns ray-marched in a thin layer over the terrain, out to the horizon (`VegetationPass`, shaders/vegetation.js) |
| `style: "natural"` | open ground as grass and scrub (greener up the slopes; `moisture` 0..1), built-up ground as yards and paving, sand along the shore: no farm sections, no street grid |
| `outside: "sea"` | the sea beyond the map, out to the horizon (with `base` at the sea level) |
