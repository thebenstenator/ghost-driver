// Master list of playable vehicles. Import this wherever you need to enumerate cars
// (garage UI, save/load, GameScene creation). Stats live in their own per-vehicle file.
import { PROWLER } from './prowler/stats.js';
import { RAZORBACK } from './razorback/stats.js';

export const VEHICLES = [
  {
    id:      'prowler',
    name:    'The Prowler',
    flavor:  'Nothing to see here.',
    stats:   PROWLER,
    speed: 3, accel: 3, handling: 3,
  },
  {
    id:      'razorback',
    name:    'The Razorback',
    flavor:  'Fast enough to outrun the mistake of driving it.',
    stats:   RAZORBACK,
    speed: 5, accel: 4, handling: 3,
  },
];

export function vehicleById(id) {
  return VEHICLES.find(v => v.id === id) ?? VEHICLES[0];
}
