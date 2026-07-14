// Prowler — balanced sedan baseline (Speed 3/5, Accel 3/5, Handling 3/5, Mass 2/5, Stealth 5/5)
// These are the canonical defaults for the live-tuning panel; bump gd_carTuning when changing shape.

export const PROWLER = {
  // --- Sprite / display ---
  texture:       'player_car',  // loaded as 'player_car' in BootScene for backward compat
  displayWidth:  30,
  displayHeight: 59,
  bodySize:      27,   // square Arcade AABB — the capsule solver does the real collision work

  // --- Capsule collider (scene-level; read by GameScene via playerCapR/capHalfLen/mass) ---
  capR:     10,   // half the car width
  capHalfLen: 13, // circle offset from centre along spine (−10% vs raw half-height)
  mass:     1.5,  // capsule-collision weight vs cops (heavier → shoves them more)

  // --- Engine ---
  maxSpeed:        600,
  maxReverseSpeed: 220,
  acceleration:    345,
  hardBrakeForce:  350,
  brakeForce:      275,
  reverseAccel:    200,

  // --- Steering ---
  turnSpeedLow:       2.2,   // rad/s at near-zero speed
  turnSpeed:          0.95,  // rad/s at gripSpeedRef
  turnSpeedHandbrake: 1.2,   // high-speed rate while handbraking (kept higher so drifts whip)
  maxDriftAngle:      1.9163715186897738,  // ~110° — front-wheel grip cap during a slide
  pivotOffset:        16,    // px behind centre the car rotates about (0 = floaty spin; higher = nose leads)

  // --- Drag (per-frame multipliers, frame-rate independent via Math.pow) ---
  handBrakeDrag:  0.975,
  coastDrag:      0.992,
  accelDragBase:  0.9975,
  accelDragCurve: 0.018,   // subtracted as speedFraction² × this — adds top-speed drag ceiling

  // --- Grip ---
  gripLow:          0.14,   // grip factor at near-zero speed
  gripHigh:         0.1,    // grip factor at gripSpeedRef
  gripSpeedRef:     350,    // px/s at which gripHigh is fully reached
  gripHandbrake:    0.008,  // grip during a handbrake drift
  entryKick:        0.45,   // radians snapped into drift on handbrake press
  entryKickDuration:  1.0,  // seconds for the cubic ease-out to complete
  entryKickCooldown:  1.0,  // seconds before another kick can fire
};
