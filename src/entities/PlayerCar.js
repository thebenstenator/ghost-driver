import { Vehicle } from './Vehicle.js';

// The player's car — a Vehicle driven by keyboard input. Uses the default
// Pilgrim baseline stats; all tuning lives on the instance so the debug panel
// can bind to it directly.
export class PlayerCar extends Vehicle {
  constructor(scene, x, y) {
    super(scene, x, y, {
      texture: 'player_car',
      displayWidth: 33,    // new prowler art is sleeker (0.51 aspect) — keep length, narrower
      displayHeight: 66,
      bodySize: 30,        // square backstop ≈ the (narrower) car width; capsule does the real work
      depth: 10,
    });
  }
}
