import { Vehicle } from './Vehicle.js';
import { PROWLER } from '../vehicles/prowler/stats.js';

// The player's car — a Vehicle driven by keyboard input. Stats are loaded from
// the per-vehicle stats file (src/vehicles/<name>/stats.js); all fields live on
// the instance so the debug panel can bind to it directly.
export class PlayerCar extends Vehicle {
  constructor(scene, x, y, vehicleStats = PROWLER) {
    super(scene, x, y, {
      texture:       vehicleStats.texture,
      displayWidth:  vehicleStats.displayWidth,
      displayHeight: vehicleStats.displayHeight,
      bodySize:      vehicleStats.bodySize,
      depth: 10,
      stats: vehicleStats,
    });
  }
}
