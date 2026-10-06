'use strict';
// Sound effects as events of this world.

Features.part('gui', (engine, feature) => {
class AudioSystem {
    constructor(fx) {
        this.fx = fx;
        this.enabled = true;            // the phone's sound switch
        this.stepVolume = 0.7;
    }

    emit(name, payload = {}) { if (this.enabled) this.fx.emit(name, payload); }
    later(ms, fn) { setTimeout(fn, ms); }

    door() { this.emit('door'); }
    step(run) { if (this.stepVolume > 0) this.emit('step', { run, vol: this.stepVolume }); }
    shutter() { this.emit('shutter'); }
    chime(up) { this.emit('chime', { up }); }
}

return { AudioSystem };
});
