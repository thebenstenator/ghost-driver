import { Vehicle } from './Vehicle.js';

// The player's car — a Vehicle driven by keyboard input. Uses the default
// Pilgrim baseline stats; all tuning lives on the instance so the debug panel
// can bind to it directly.
export class PlayerCar extends Vehicle {
  constructor(scene, x, y) {
    super(scene, x, y, {
      texture: 'player_car',
      displayWidth: 30,    // prowler art, sleeker (0.51 aspect), scaled down 10%
      displayHeight: 59,
      bodySize: 27,        // square backstop ≈ the (narrower) car width; capsule does the real work
      depth: 10,
      // Rotate about a point behind centre so the nose leads the turn (less floaty). Tunable live
      // in the car panel ("Rear pivot"); cops keep 0 (centre yaw) for their path-following.
      stats: { pivotOffset: 16 },
    });
  }
}
