import { Vehicle } from './Vehicle.js';
import { CopAI } from '../ai/CopAI.js';

// A pursuing cop car. Same physics as the player, driven by a CopAI.
//
// ── HOW TO TUNE A COP ──────────────────────────────────────────────────────
// Cop *handling* (speed, grip, steering, drift) is tuned here, in the `stats`
// object below — each key overrides the corresponding Vehicle default, so you
// can give a cop any handling profile relative to the player. This is the
// preferred way to balance a cop: change numbers here, not in the physics.
//
// Cop *behaviour* (how it decides to drive — pursuit, cornering aggression,
// stuck recovery, approach/ram) is tuned by the constants in CopAI's
// constructor. Pursuit-level / per-unit variety will eventually pass a config
// in here; for now this is the single "level 1 patrol" profile.
// ───────────────────────────────────────────────────────────────────────────
export class CopCar extends Vehicle {
  constructor(scene, x, y, navGrid, rects = null) {
    super(scene, x, y, {
      texture: 'player_car',
      displayWidth: 38,
      displayHeight: 60,
      bodySize: 30,
      depth: 9,
      tint: 0xffffff,   // flat white silhouette so cops pop against the dark map
      tintFill: true,
      stats: {
        maxSpeed:     590, // just under the player's 600 — catchable on a long straight
        acceleration: 420, // out-accelerates the player's 345
        // Interceptor grip — high enough to corner crisply (hold the line) at
        // speed instead of washing wide into buildings.
        gripLow:      0.26, // player 0.14
        gripHigh:     0.18, // player 0.03 — much more traction at speed
        gripSpeedRef: 480,  // player 350 — grip stays high to higher speed
        turnSpeedLow: 2.5,  // player 2.2
        turnSpeed:    1.72, // player 1.2 — turns harder at speed
        // Near-full steering authority at any speed so the path-follower can
        // always turn (player is 0 — can't pivot in place). This is what makes
        // the controller deadlock-proof.
        minSteerFactor: 0.8,
      },
    });

    this.ai = new CopAI(navGrid, rects);
    this.aiTarget = { x, y }; // current steering target, for debug draw
    this.baseMaxSpeed = this.maxSpeed; // catch-up rubber-band raises maxSpeed above this when far
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
