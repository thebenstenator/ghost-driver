import { Vehicle } from './Vehicle.js';

// The player's car — a Vehicle driven by keyboard input. Uses the default
// Pilgrim baseline stats; all tuning lives on the instance so the debug panel
// can bind to it directly.
export class PlayerCar extends Vehicle {
  constructor(scene, x, y) {
    super(scene, x, y, {
      texture: 'player_car',
      displayWidth: 38,
      displayHeight: 60,
      bodySize: 30,
      depth: 10,
    });
  }
}
