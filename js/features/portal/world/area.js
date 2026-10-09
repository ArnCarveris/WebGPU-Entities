'use strict';
// Areas and their lights.

Features.part('portal', (engine, feature) => {
const { kits } = engine;

// Areas (FarCry1 VisArea / SECTR Sector) are the interior kit's; the point lights that live in them are kits.entities
// LightSources (signal flicker | pulse; they may ride a vehicle)
const { Area } = kits.interior;
const PointLight = kits.entities.LightSource;

return { PointLight, Area };
});
