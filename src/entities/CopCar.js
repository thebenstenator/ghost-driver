import { Vehicle } from './Vehicle.js';
import { CopAI } from '../ai/CopAI.js';

// A pursuing cop car. Same physics as the player, but driven by a CopAI that
// generates the controls each frame. Slightly lower top speed than the player
// so a skilled driver can pull away on long straights — cops close the gap in
// corners and when the player makes mistakes.
export class CopCar extends Vehicle {
  constructor(scene, x, y, navGrid) {
    super(scene, x, y, {
      texture: 'player_car',
      displayWidth: 38,
      displayHeight: 60,
      bodySize: 30,
      depth: 9,
      tint: 0xffffff,   // flat white silhouette so cops pop against the dark map
      tintFill: true,
      stats: {
        maxSpeed:     570,
        acceleration: 350,
      },
    });

    this.ai = new CopAI(navGrid);
    this.aiTarget = { x, y }; // current steering target, for debug draw
  }

  // target: an object with .x / .y in world space (typically the player sprite)
  update(delta, target) {
    const controls = this.ai.getControls(this, target, delta / 1000);
    super.update(delta, controls);
  }
}
