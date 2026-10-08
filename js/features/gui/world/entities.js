'use strict';
// The scenario's entity types, by name: the entities kit's fixtures (doors, lamps, beacons, lights, drones, cameras, the
// avatar, terminals and easels), drawn through the world's meshes (World.meshes, the common mesh interface).

Features.part('gui', (engine, feature) => {
const { kits } = engine;

// World entities (kits.entities FixtureEntity), each constructed from a scenario definition ({ type, id, ... })
const Entity = kits.entities.FixtureEntity;
const { ModelEntity, SlidingDoor, SwingingLamp, AlarmBeacon, PointLight, PatrolDrone, SecurityCamera, Avatar, Terminal, Easel } =
    kits.entities.fixtureTypes(Entity);

const ENTITY_TYPES = {
    static: ModelEntity,
    door: SlidingDoor,
    lamp: SwingingLamp,
    alarmBeacon: AlarmBeacon,
    light: PointLight,
    drone: PatrolDrone,
    securityCamera: SecurityCamera,
    avatar: Avatar,
    terminal: Terminal,
    easel: Easel
};

return { SecurityCamera, Easel, ENTITY_TYPES };
});
