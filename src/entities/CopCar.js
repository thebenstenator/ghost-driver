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
        // The player's nominal 600 is never reached — drag caps their REAL top
        // speed at ~450. The cop's higher accel would settle it at ~479 (FASTER
        // than the player) unless we cap below 450. So 430 makes the cap actually
        // bite: cop tops out at 430 < player's real 450, so you pull away on
        // straights while it stays a threat in corners. The real top-speed dial.
        maxSpeed:     430,
        acceleration: 420, // out-accelerates the player's 345 (brisk, but capped above)
        // Near-kinematic grip — velocity tracks facing almost instantly, so there
        // is no drift lag to wash the cop wide into a building. This is what lets
        // the path-follower thread the tight grid. (Player is 0.14/0.03 — the cop
        // is deliberately planted/on-rails; the player is the one who drifts.)
        gripLow:      0.6,  // player 0.14
        gripHigh:     0.2,  // player 0.03 — looser at speed so it slides through fast corners
        gripSpeedRef: 480,
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
