'use strict';
// Phone apps: custom-drawn pages of the PhoneGUI.

Features.kit('gui', (engine, kit) => {
// Phone apps: custom-drawn pages of the PhoneGUI.

class PhoneApp {
    // game: the world the app belongs to (its player, camera, library...)
    constructor(phone, game) {
        this.phone = phone;
        this.game = game;
    }

    get W() { return this.phone.vw; }
    get H() { return this.phone.vh; }

    draw(dc, now, pageId) {}
    // Handle a press on one of this app's hit regions; return true if handled
    onPress(kind, key, idx) { return false; }
}

return { PhoneApp };
});
