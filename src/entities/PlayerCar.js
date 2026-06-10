import Phaser from 'phaser';

export class PlayerCar {
  constructor(scene, x, y) {
    this.scene = scene;
    this.facing = -Math.PI / 2; // start facing up (negative y)
    this.vx = 0;
    this.vy = 0;
    this.isDrifting  = false;
    this.driftAngle  = 0; // signed angle between facing and velocity, exposed for camera
    this._wasHandbrake = false;

    // Pilgrim stats — baseline sedan
    this.maxSpeed        = 600;
    this.maxReverseSpeed = 220;
    this.acceleration    = 345;
    this.hardBrakeForce  = 350;
    this.brakeForce      = 275;
    this.reverseAccel    = 200;
    this.turnSpeedLow    = 2.2;   // radians/second at low speed
    this.turnSpeed       = 1.2;   // radians/second at high speed (gripSpeedRef)
    this.maxDriftAngle   = 1.9163715186897738; // ~110°

    // Drag params (tunable via debug panel)
    this.handBrakeDrag  = 0.975;
    this.coastDrag      = 0.992;
    this.accelDragBase  = 0.9975;
    this.accelDragCurve = 0.018; // subtracted as speedFraction² × this value

    // Grip params (tunable via debug panel)
    this.gripLow        = 0.14;  // grip at near-zero speed
    this.gripHigh       = 0.03;  // grip at gripSpeedRef
    this.gripSpeedRef   = 350;   // speed (px/s) at which gripHigh is fully reached
    this.gripHandbrake  = 0.008; // grip during handbrake drift

    // Entry kick: facing rotation (radians) applied the frame the handbrake is first pressed.
    // Creates the "rear snaps out" feel rather than a gradual grip fade.
    this.entryKick = 0.45;

    // Sprite is pre-loaded in BootScene
    this.sprite = scene.physics.add.image(x, y, 'player_car');
    this.sprite.setCollideWorldBounds(true);
    this.sprite.setBounce(0);
    // prowler.png points UP (north); Phaser's 0° is right, so +PI/2 aligns them
    this.sprite.setRotation(this.facing + Math.PI / 2);
    this.sprite.setDisplaySize(38, 60);
    this.sprite.setDepth(10);
    // Square body: Arcade Physics AABBs are axis-aligned and don't rotate with
    // the sprite, so a square approximates the car's footprint at any angle
    this.sprite.body.setSize(30, 30);
  }

  getSpeed() {
    return Math.sqrt(this.vx * this.vx + this.vy * this.vy);
  }

  update(delta, controls) {
    const dt = delta / 1000;
    const { up, down, left, right, handbrake, brake } = controls;
    this.isDrifting = handbrake;

    // Sync velocity from physics body — collisions may have modified it
    this.vx = this.sprite.body.velocity.x;
    this.vy = this.sprite.body.velocity.y;

    const speed         = this.getSpeed();
    const speedFraction = Phaser.Math.Clamp(speed / this.maxSpeed, 0, 1);

    // --- Steering ---
    // Speed-gated so the car can't spin on the spot.
    const speedFactor = Phaser.Math.Clamp(speed / 60, 0, 1);
    const steerFrac   = Math.min(speed / this.gripSpeedRef, 1);
    const turnRate    = Phaser.Math.Linear(this.turnSpeedLow, this.turnSpeed, steerFrac);
    const steer       = (right ? 1 : 0) - (left ? 1 : 0);
    this.facing += steer * turnRate * speedFactor * dt;

    // Drift angle cap: during a handbrake, facing can't deviate more than
    // maxDriftAngle from the velocity vector. Simulates front-wheel grip
    // resisting a full-axis spin — the rear can slide out but you can't
    // spin the nose past perpendicular and accelerate in a new direction.
    // Guard against reversing: when going backward the velocity is naturally
    // ~180° from facing, which would trigger a false snap without this check.
    {
      const cosF0   = Math.cos(this.facing);
      const sinF0   = Math.sin(this.facing);
      const fwdDot0 = this.vx * cosF0 + this.vy * sinF0;
      if (handbrake && speed > 30 && fwdDot0 > 0) {
        const velAngle = Math.atan2(this.vy, this.vx);
        const diff     = Math.atan2(Math.sin(this.facing - velAngle), Math.cos(this.facing - velAngle));
        if (Math.abs(diff) > this.maxDriftAngle) {
          this.facing = velAngle + Math.sign(diff) * this.maxDriftAngle;
        }
      }
    }

    const cosF = Math.cos(this.facing);
    const sinF = Math.sin(this.facing);

    // --- Handbrake entry kick ---
    // On the first frame the handbrake is pressed, add a lateral velocity impulse
    // perpendicular to the facing direction (in the steer direction). This creates
    // the immediate "rear snaps out" feel instead of a gradual grip fade.
    // Only fires when steering — no kick on a straight-line handbrake.
    if (handbrake && !this._wasHandbrake && speed > 80 && steer !== 0) {
      // Rotate facing instantly — creates a velocity/facing gap so the rear
      // appears to snap out rather than translating the whole car sideways.
      this.facing += this.entryKick * steer;
    }
    this._wasHandbrake = handbrake;

    // --- Forward acceleration ---
    // Allowed during handbrake at 70% power so the player can hold a power drift
    if (up) {
      const accelMult = handbrake ? 0.7 : 1.0;
      this.vx += cosF * this.acceleration * accelMult * dt;
      this.vy += sinF * this.acceleration * accelMult * dt;
    }

    // --- Brake / reverse ---
    if (down) {
      // Dot product: positive = moving forward, negative = moving backward.
      // Only brake while moving forward — once the car stops or goes backward,
      // switch straight to reverse acceleration. The old `|| speed > 30` arm
      // was erroneously triggering brake code on backward momentum too.
      const fwdDot = this.vx * cosF + this.vy * sinF;
      if (fwdDot > 10 || handbrake) {
        // Hard brake — decelerate along current velocity direction
        const decel = Math.min(this.brakeForce * dt, speed);
        if (speed > 0) {
          this.vx -= (this.vx / speed) * decel;
          this.vy -= (this.vy / speed) * decel;
        }
      } else {
        // Reverse
        this.vx -= cosF * this.reverseAccel * dt;
        this.vy -= sinF * this.reverseAccel * dt;
      }
    }

    // --- Dedicated brake (Shift) ---
    // Always decelerates along current velocity — never triggers reverse.
    if (brake && speed > 0) {
      const decel = Math.min(this.hardBrakeForce * dt, speed);
      this.vx -= (this.vx / speed) * decel;
      this.vy -= (this.vy / speed) * decel;
    }

    // --- Drag (frame-rate independent) ---
    // While accelerating, drag grows quadratically with speed — almost zero
    // resistance off the line (punchy), but resistance squares up hard near
    // the top so the last 20% of max speed requires a long uninterrupted straight.
    // Natural terminal velocity lands around 440-450 px/s; the 600 cap is a
    // hard ceiling that's nearly unreachable in normal city driving.
    const coasting = !up && !down;
    let dragBase;
    if      (handbrake) dragBase = this.handBrakeDrag;
    else if (coasting)  dragBase = this.coastDrag;
    else                dragBase = this.accelDragBase - speedFraction * speedFraction * this.accelDragCurve;
    const drag = Math.pow(dragBase, dt * 60);
    this.vx *= drag;
    this.vy *= drag;

    // Whether the car is rolling forward or backward relative to its facing.
    // During a handbrake drift the car face can rotate past 90° from the
    // velocity direction, flipping fwdDot negative. Without the handbrake
    // guard the grip target would snap to the backward direction mid-slide,
    // killing the drift. Force fwdSign = 1 during handbrake so the grip
    // target stays forward and velocity can travel through the sideways arc.
    const fwdDot  = this.vx * cosF + this.vy * sinF;
    const fwdSign = (handbrake || fwdDot >= 0) ? 1 : -1;

    // --- Speed scrub from sideways sliding ---
    // Measures how far velocity deviates from the intended travel axis
    // (forward or backward). A 90° sideways slide costs ~19% speed/second.
    // Reversing is NOT sideways, so it doesn't trigger scrub.
    if (speed > 30 && !handbrake) {
      const velAngle    = Math.atan2(this.vy, this.vx);
      const travelAngle = fwdSign > 0 ? this.facing : this.facing + Math.PI;
      const angleDiff   = Math.atan2(Math.sin(travelAngle - velAngle), Math.cos(travelAngle - velAngle));
      const scrub       = (Math.abs(angleDiff) / Math.PI) ** 1.5;
      this.vx *= (1 - scrub * 0.018);
      this.vy *= (1 - scrub * 0.018);
    }

    // --- Grip: blend velocity toward intended travel direction ---
    // Target is forward when moving forward, backward when reversing — so grip
    // stabilises whichever direction the car is travelling rather than fighting it.
    // Grip is speed-dependent: responsive at low speed, significant understeer
    // at high speed so full-speed 90° corners require planning.
    const gripBase = handbrake
      ? this.gripHandbrake
      : Phaser.Math.Linear(this.gripLow, this.gripHigh, Math.min(speed / this.gripSpeedRef, 1));
    const grip = 1 - Math.pow(1 - gripBase, dt * 60);

    if (speed > 5) {
      const targetVx = cosF * speed * fwdSign;
      const targetVy = sinF * speed * fwdSign;
      this.vx = Phaser.Math.Linear(this.vx, targetVx, grip);
      this.vy = Phaser.Math.Linear(this.vy, targetVy, grip);
    }

    // Track drift angle for the camera Dutch effect
    if (speed > 10) {
      const velAngle = Math.atan2(this.vy, this.vx);
      this.driftAngle = Math.atan2(Math.sin(this.facing - velAngle), Math.cos(this.facing - velAngle));
    } else {
      this.driftAngle = 0;
    }

    // --- Speed cap ---
    // Reverse uses a separate (lower) limit so the car doesn't rocket backward.
    const newSpeed = this.getSpeed();
    const limit    = fwdSign < 0 ? this.maxReverseSpeed : this.maxSpeed;
    if (newSpeed > limit) {
      const ratio = limit / newSpeed;
      this.vx *= ratio;
      this.vy *= ratio;
    }

    // --- Write to physics body ---
    this.sprite.setVelocity(this.vx, this.vy);
    this.sprite.setRotation(this.facing + Math.PI / 2);
  }
}
