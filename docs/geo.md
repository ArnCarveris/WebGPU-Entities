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
| `geoPlaces` `{ data, kinds, height }` | place labels (`place` entities) for the data's places of `kinds` (`{ kind: range m }`, 0 always shown) |

Roads and buildings go into `Structures.bulk`, a [`TiledMesh`](../js/kits/mesh/tiled.js): compact indexed triangles
(position + a colour word with the material) in 2 km tiles, drawn by the tiles in view (the renderer's `vsBulk` /
`fsBulk`, flat-shaded from screen derivatives). Oʻahu: 97,640 buildings and 7,142 km of roads (footways and paths
skipped), about 3 s to build.

## The terrain block

What a real place needs of the cloud world's `terrain`:

| Key | |
|---|---|
| `grid` | the terrain mesh's vertices a side (default 512): Oʻahu draws 1024, 72 m apart, for its cliffs |
| `style: "natural"` | open ground as grass and scrub (greener up the slopes; `moisture` 0..1), built-up ground as yards and paving, sand along the shore: no farm sections, no street grid |
| `outside: "sea"` | the sea beyond the map, out to the horizon (with `base` at the sea level) |
