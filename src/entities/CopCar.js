import Phaser from 'phaser';
import { Vehicle } from './Vehicle.js';
import { CopAI } from '../ai/CopAI.js';

// A pursuing cop car. It reuses Vehicle only for the sprite + collision body — it
// does NOT use the player's drift physics. Cops move with a STEERING-KINEMATIC
// model: the AI says where to head and how fast, and the cop turns toward it with
// a speed-dependent turn radius and ramps its speed with a fixed acceleration.
//
// This is the middle path between the two things that failed:
//   • Piloting the player's DRIFT car with AI inputs → spinouts, wedging, stuck
//     in reverse (grip/handbrake/scrub fight the AI).
//   • Setting velocity straight at the target → rides on rails: instant speed,
//     instant direction change, always max speed. Reliable but unnatural.
// Here heading and speed are DIRECTLY bounded (can't spin out / wedge / reverse),
// but they can only CHANGE over time — so the cop accelerates from a stop and arcs
// through corners (wider arcs at speed = understeer), reading like a real car.
//
// ── HOW TO TUNE A COP ──────────────────────────────────────────────────────
// Top speed → `maxSpeed` (stats below). Acceleration / braking / turn radius →
// the fields in this constructor. How it decides where to go and how fast (corner
// speed, look-ahead, pathing, standoff) → CopAI's constructor.
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
        // Top travel speed. Deliberately BELOW the player's 600: the chase sim
        // showed an equal/faster cop can never be ditched (it always reels you in
        // through corners), while a slightly slower cop turns OPEN ROAD into a real
        // escape valve — you ditch by keeping your speed up on straights, and get
        // caught when you bog down in corners. This is the master difficulty dial.
        maxSpeed: 565,
      },
    });

    this.ai = new CopAI(navGrid, rects);
    this.aiTarget = { x, y };           // current aim point, for debug draw
    this.baseMaxSpeed = this.maxSpeed;  // tuning panel restores maxSpeed from this

    // ── Steering-kinematic motion params ──
    this.accel       = 750;  // px/s² ramp up to target speed (pull away from a stop)
    this.brakeDecel  = 1400; // px/s² ramp down (slow for corners / standoff)
    this.turnRadius  = 52;   // px — min cornering radius; bigger = wider arcs at speed
    this.maxTurnRate = 5.5;  // rad/s cap (so it can't pivot instantly at high speed)
    this.baseTurnRate = 2.6; // rad/s floor (so it can still reorient when crawling)

    this.heading = this.facing; // direction of travel (velocity points this way)
    this.speed   = 0;           // current scalar speed (ramped, not snapped)
  }

  // target: { x, y } in world space (player / last-known / station). null = stand down.
  update(delta, target) {
    const dt   = delta / 1000;
    const body = this.sprite.body;
    if (!target) {
      body.setVelocity(0, 0);
      this.vx = this.vy = 0;
      this.speed = 0;
      this.aiTarget = null;
      this.debug = { mode: 'STANDDOWN', speed: 0, dist: 0, bend: 0, cornerLimit: 0, angleErr: 0, reverseTime: 0 };
      return;
    }

    const { aim, speed } = this.ai.getControls(this, target);
    this.aiTarget = aim;

    const dx = aim.x - this.sprite.x, dy = aim.y - this.sprite.y;
    const d  = Math.hypot(dx, dy);

    // Target speed the AI wants, capped by our top speed. Drop to 0 on arrival so
    // we don't overstep the aim and jitter across it.
    let targetSpeed = Math.min(speed, this.maxSpeed);
    if (d < 3 || this.speed * dt > d) targetSpeed = 0;

    // Ramp speed toward target (accelerate or brake — never snap).
    if (targetSpeed > this.speed) this.speed = Math.min(targetSpeed, this.speed + this.accel * dt);
    else                          this.speed = Math.max(targetSpeed, this.speed - this.brakeDecel * dt);

    // Steer heading toward the aim, limited by a speed-dependent turn rate. Faster
    // → wider arc (turnRate ≈ speed/turnRadius), with a low-speed floor so a nearly
    // stopped cop can still reorient, and a cap so it never pivots on a dime.
    let angleErr = 0;
    if (d > 1) {
      const desired = Math.atan2(dy, dx);
      angleErr = Phaser.Math.Angle.Wrap(desired - this.heading);
      const turnRate = Phaser.Math.Clamp(this.speed / this.turnRadius, this.baseTurnRate, this.maxTurnRate);
      this.heading = Phaser.Math.Angle.RotateTo(this.heading, desired, turnRate * dt);
    }

    // Velocity follows the nose — no sideways slide.
    this.vx = Math.cos(this.heading) * this.speed;
    this.vy = Math.sin(this.heading) * this.speed;
    body.setVelocity(this.vx, this.vy);

    this.facing = this.heading;
    this.sprite.setRotation(this.facing + Math.PI / 2);

    if (this.debug) { this.debug.angleErr = Phaser.Math.RadToDeg(angleErr); }
  }
}
