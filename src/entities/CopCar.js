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
        maxSpeed:     660, // faster than the player's 600 so it can run you down
        acceleration: 430, // and out-accelerates the player's 345 off the line
        // Superhuman grip + steering (interceptor) so it corners without
        // bleeding all its speed — less understeer than the player at speed.
        gripLow:      0.20, // player 0.14
        gripHigh:     0.07, // player 0.03 — much more traction at speed
        gripSpeedRef: 450,  // player 350 — grip stays high to higher speeds
        turnSpeedLow: 2.6,  // player 2.2
        turnSpeed:    1.9,  // player 1.2 — turns harder at speed
      },
    });

    this.ai = new CopAI(navGrid);
    this.aiTarget = { x, y }; // current steering target, for debug draw
  }

  // target: an object with .x / .y in world space (the player, or a last-known
  // position). A null target means "stand down" — coast to a stop.
  update(delta, target) {
    if (!target) {
      super.update(delta, { up: false, down: false, left: false, right: false, handbrake: false, brake: true });
      this.aiTarget = null;
      this.debug = { mode: 'STANDDOWN', speed: this.getSpeed(), dist: 0, bend: 0,
                     cornerLimit: 0, angleErr: 0, reverseTime: 0 };
      return;
    }
    const controls = this.ai.getControls(this, target, delta / 1000);
    super.update(delta, controls);
  }
}
