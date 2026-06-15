import Phaser from 'phaser';

// Base driving vehicle. Holds the full arcade drift physics model and is driven
// entirely by a controls struct: { up, down, left, right, handbrake, brake }.
// The player feeds it keyboard input; cops feed it AI-generated controls — so
// every car in the world shares the same momentum, grip, drift and collision feel.
export class Vehicle {
  constructor(scene, x, y, config = {}) {
    const {
      texture      = 'player_car',
      displayWidth = 38,
      displayHeight = 60,
      bodyRadius   = 19, // centre collision-circle radius in px (≈ half the car width)
      bumperRadius = 14, // front/rear capsule-circle radius in px (extends collision along the length)
      facing       = -Math.PI / 2,
      depth        = 10,
      tint         = null,
      tintFill     = false, // true = replace silhouette with a flat colour (visibility)
      stats        = {},
    } = config;

    this.scene  = scene;
    this.facing = facing;
    this.vx = 0;
    this.vy = 0;
    this.isDrifting    = false;
    this.driftAngle    = 0; // signed angle between facing and velocity, exposed for camera
    this._wasHandbrake = false;
    this._kickCooldown = 0; // seconds remaining before another entry kick is allowed
    this._kickTimer    = 0; // progress through current kick animation
    this._kickTotal    = 0; // total rotation (radians) for current kick
    this._kickApplied  = 0; // how much has been applied so far

    // --- Default stats (Pilgrim baseline sedan) ---
    this.maxSpeed        = 600;
    this.maxReverseSpeed = 220;
    this.acceleration    = 345;
    this.hardBrakeForce  = 350;
    this.brakeForce      = 275;
    this.reverseAccel    = 200;
    this.turnSpeedLow    = 2.2;   // radians/second at low speed
    this.turnSpeed       = 1.2;   // radians/second at high speed (gripSpeedRef)
    this.maxDriftAngle   = 1.9163715186897738; // ~110°
    // Floor on steering authority at low speed. 0 = the player's weighty
    // "can't pivot in place" feel; cops use a higher value so they can always
    // rotate out of a low-speed deadlock instead of getting stuck facing a wall.
    this.minSteerFactor  = 0;

    this.handBrakeDrag  = 0.975;
    this.coastDrag      = 0.992;
    this.accelDragBase  = 0.9975;
    this.accelDragCurve = 0.018; // subtracted as speedFraction² × this value

    this.gripLow        = 0.14;  // grip at near-zero speed
    this.gripHigh       = 0.03;  // grip at gripSpeedRef
    this.gripSpeedRef   = 350;   // speed (px/s) at which gripHigh is fully reached
    this.gripHandbrake  = 0.008; // grip during handbrake drift

    this.entryKick         = 0.45;
    this.entryKickDuration = 1.0;  // seconds to complete the kick ease-out
    this.entryKickCooldown = 1.0;  // seconds before another kick is allowed

    // Apply any per-vehicle stat overrides
    Object.assign(this, stats);

    // --- Sprite + physics body ---
    this.sprite = scene.physics.add.image(x, y, texture);
    this.sprite.setCollideWorldBounds(true);
    this.sprite.setBounce(0);
    this.sprite.setRotation(this.facing + Math.PI / 2);
    this.sprite.setDisplaySize(displayWidth, displayHeight);
    this.sprite.setDepth(depth);
    if (tint !== null) {
      if (tintFill) this.sprite.setTintFill(tint);
      else          this.sprite.setTint(tint);
    }
    // Circular body. Arcade bodies can't rotate, so a circle gives the SAME
    // footprint at every heading (consistent wall hits whichever way you crash).
    // NOTE: Arcade's setCircle ignores the sprite's display scale — the radius is
    // used as-is in world px — so pass the world radius directly and centre it in
    // the (native) frame. (A long car can't be an oval in Arcade — that would need
    // a multi-circle capsule or Matter.js.)
    this.sprite.body.setCircle(bodyRadius,
      this.sprite.width  / 2 - bodyRadius,            // centre the circle in the frame
      this.sprite.height / 2 - bodyRadius);
    this.bodyRadius = bodyRadius;                      // world radius, for debug draw

    // Back-reference so colliders can find the owning vehicle from the sprite
    this.sprite.vehicle = this;

    // --- Capsule: front + rear "bumper" bodies ---
    // The single circle covers the car's width but not its length (nose/tail poke
    // through walls). Add two follower circles down the long axis so the collider
    // hugs the whole car. They're invisible bodies repositioned each frame to the
    // car's nose/tail; GameScene collides them with walls and calls bumperBlock().
    const half = displayHeight / 2;
    this.bumperOffset = half - bumperRadius;  // sit each circle at an end of the car
    this.bumperRadius = bumperRadius;
    // Build bumpers from a tiny dedicated texture, NOT the big car frame — a large
    // frame throws the circle's offset off by ~half its size (left the bodies
    // floating beside the car). With a 4px frame the circle centres cleanly.
    const BT = '_bumperDot';
    if (!scene.textures.exists(BT)) {
      const g = scene.make.graphics({ add: false });
      g.fillStyle(0xffffff, 1); g.fillRect(0, 0, 4, 4);
      g.generateTexture(BT, 4, 4); g.destroy();
    }
    this.bumpers = [1, -1].map((dir) => {
      const b = scene.physics.add.image(x, y, BT).setVisible(false);
      b.body.setAllowGravity(false);
      b.body.setCircle(bumperRadius, b.width / 2 - bumperRadius, b.height / 2 - bumperRadius);
      b.bumperDir = dir;   // +1 = front (along facing), -1 = rear
      b.vehicle   = this;
      return b;
    });
  }

  getSpeed() {
    return Math.sqrt(this.vx * this.vx + this.vy * this.vy);
  }

  // Keep the bumper bodies pinned to the car's nose and tail (call each frame).
  // Remember where we placed each one, so bumperBlock can tell how far a wall
  // pushed it back (= how far the car needs to be ejected).
  _positionBumpers() {
    const cx = this.sprite.x, cy = this.sprite.y;
    const cos = Math.cos(this.facing), sin = Math.sin(this.facing);
    for (const b of this.bumpers) {
      const o = this.bumperOffset * b.bumperDir;
      b.px = cx + cos * o;
      b.py = cy + sin * o;
      b.body.reset(b.px, b.py); // teleport body to the end, no drift
    }
  }

  // A bumper hit a wall: kill only the car's velocity INTO that wall, along the
  // ACTUAL contact axis (buildings are axis-aligned, so the bumper's touching
  // flags give the world-axis normal). Velocity ALONG the wall is kept, so the car
  // slides instead of sticking — same behaviour as Arcade's own body separation,
  // just extended to the nose/tail circles.
  bumperBlock(bumper) {
    const body = this.sprite.body;

    // EJECT: Arcade just pushed this bumper out of the wall; the bumper moved from
    // where we placed it (px,py) to its separated centre. Apply that same push to
    // the car body so its nose/tail can't sit inside the wall. This is positional,
    // so it doesn't depend on any velocity-read timing.
    const dx = bumper.body.center.x - bumper.px;
    const dy = bumper.body.center.y - bumper.py;
    body.x += dx; body.y += dy;
    body.updateCenter();

    // Kill only the velocity INTO the wall (along the push), keep tangential so the
    // car slides along it. Work off the live body velocity, then sync our fields.
    let vx = body.velocity.x, vy = body.velocity.y;
    if (dx > 0.01 && vx < 0) vx = 0;   // pushed right  -> wall on the left
    if (dx < -0.01 && vx > 0) vx = 0;  // pushed left   -> wall on the right
    if (dy > 0.01 && vy < 0) vy = 0;   // pushed down   -> wall above
    if (dy < -0.01 && vy > 0) vy = 0;  // pushed up      -> wall below
    body.setVelocity(vx, vy);
    this.vx = vx; this.vy = vy;
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
    const speedFactor = Math.max(Phaser.Math.Clamp(speed / 60, 0, 1), this.minSteerFactor);
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
    // On the first frame the handbrake is pressed, rotate facing to snap the rear
    // out, creating the immediate drift initiation. Only fires when steering.
    this._kickCooldown = Math.max(0, this._kickCooldown - dt);

    // Trigger a new kick on the rising edge of handbrake
    if (handbrake && !this._wasHandbrake && speed > 80 && steer !== 0 && this._kickCooldown === 0) {
      this._kickTotal    = this.entryKick * steer;
      this._kickTimer    = 0;
      this._kickApplied  = 0;
      this._kickCooldown = this.entryKickCooldown;
    }
    this._wasHandbrake = handbrake;

    // Apply kick as an ease-out cubic over entryKickDuration seconds.
    if (this._kickTimer < this.entryKickDuration && this._kickTotal !== 0) {
      this._kickTimer = Math.min(this._kickTimer + dt, this.entryKickDuration);
      const t         = this._kickTimer / this.entryKickDuration;
      const eased     = 1 - Math.pow(1 - t, 3); // cubic ease-out
      const delta2    = eased * this._kickTotal - this._kickApplied;
      this.facing    += delta2;
      this._kickApplied += delta2;
    }

    // --- Forward acceleration ---
    // Allowed during handbrake at 70% power so a power drift can be held
    if (up) {
      const accelMult = handbrake ? 0.7 : 1.0;
      this.vx += cosF * this.acceleration * accelMult * dt;
      this.vy += sinF * this.acceleration * accelMult * dt;
    }

    // --- Brake / reverse ---
    if (down) {
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

    // --- Dedicated brake ---
    // Always decelerates along current velocity — never triggers reverse.
    if (brake && speed > 0) {
      const decel = Math.min(this.hardBrakeForce * dt, speed);
      this.vx -= (this.vx / speed) * decel;
      this.vy -= (this.vy / speed) * decel;
    }

    // --- Drag (frame-rate independent) ---
    const coasting = !up && !down;
    let dragBase;
    if      (handbrake) dragBase = this.handBrakeDrag;
    else if (coasting)  dragBase = this.coastDrag;
    else                dragBase = this.accelDragBase - speedFraction * speedFraction * this.accelDragCurve;
    const drag = Math.pow(dragBase, dt * 60);
    this.vx *= drag;
    this.vy *= drag;

    // Whether the car is rolling forward or backward relative to its facing.
    const fwdDot  = this.vx * cosF + this.vy * sinF;
    const fwdSign = (handbrake || fwdDot >= 0) ? 1 : -1;

    // --- Speed scrub from sideways sliding ---
    if (speed > 30 && !handbrake) {
      const velAngle    = Math.atan2(this.vy, this.vx);
      const travelAngle = fwdSign > 0 ? this.facing : this.facing + Math.PI;
      const angleDiff   = Math.atan2(Math.sin(travelAngle - velAngle), Math.cos(travelAngle - velAngle));
      const scrub       = (Math.abs(angleDiff) / Math.PI) ** 1.5;
      this.vx *= (1 - scrub * 0.018);
      this.vy *= (1 - scrub * 0.018);
    }

    // --- Grip: blend velocity toward intended travel direction ---
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

    // Track drift angle for camera / FX
    if (speed > 10) {
      const velAngle = Math.atan2(this.vy, this.vx);
      this.driftAngle = Math.atan2(Math.sin(this.facing - velAngle), Math.cos(this.facing - velAngle));
    } else {
      this.driftAngle = 0;
    }

    // --- Speed cap ---
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

    this._positionBumpers();
  }
}
