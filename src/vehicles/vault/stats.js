// Vault — armored truck (Speed 2/5, Accel 1/5, Handling 2/5, Mass 5/5, Stealth 1/5)
// "They can't stop what they can't move."
// Built for survival, not escape. Cop impacts are physics work for them, not for you.
// The tradeoff: you will NOT outrun a pursuit — you have to outlast it, or route it.

export const VAULT = {
  // --- Sprite / display ---
  texture:       'vault',
  displayWidth:  56,   // wider than the razorback (48); 2:3 source ratio → 56×84
  displayHeight: 84,
  bodySize:      42,   // big AABB backstop; truck footprint

  // --- Capsule collider ---
  capR:       14,   // near half-width — wide, planted stance
  capHalfLen: 18,   // long spine (armored truck is long)
  mass:       4.0,  // Mass 5/5 — heaviest in the roster; shoves cops like parked cars

  // --- Light anchors (placeholder — tune live via Car panel) ---
  lightHalfLen: 36,
  lightHalfWid: 18,

  // --- Notoriety / stealth (Stealth 1/5 — zero anonymity) ---
  // Pursuit clock runs fast. An armored truck in traffic is not subtle.
  heatRate: 3.0,
  stealth:  1,

  // --- Engine (Accel 1/5, Speed 2/5) ---
  maxSpeed:        390,  // Speed 2/5 — decisively slower than prowler (600)
  maxReverseSpeed: 100,
  acceleration:    175,  // Accel 1/5 — grinds up to speed
  hardBrakeForce:  620,  // takes real distance to stop
  brakeForce:      480,
  reverseAccel:    110,

  // --- Steering (Handling 2/5) ---
  // Turns like a truck — wide arcs, no snap, no handbrake magic.
  turnSpeedLow:       1.5,   // sluggish even at low speed
  turnSpeed:          0.55,  // barely turns at pace
  turnSpeedHandbrake: 0.65,  // handbrake adds almost nothing
  maxDriftAngle:      0.9,   // can't really drift — front grip holds
  pivotOffset:        4,     // near-centre rotation; no nose-lead, just a lumbering yaw

  // --- Drag ---
  handBrakeDrag:  0.988,   // heavy — slides further than expected but slowly
  coastDrag:      0.990,   // keeps momentum well (Newton: mass keeps rolling)
  accelDragBase:  0.9940,  // top-speed drag ceiling kicks in early
  accelDragCurve: 0.035,   // steep ceiling — power runs out fast

  // --- Grip ---
  // Planted at all speeds. Heavy = stable. You don't lose traction, you lose time.
  gripLow:          0.24,
  gripHigh:         0.20,
  gripSpeedRef:     200,   // grip ceiling reached at lower speed (truck doesn't get fast)
  gripHandbrake:    0.018, // barely drifts
  entryKick:        0.0,   // no handbrake snap — mass kills it
  entryKickDuration:  0.5,
  entryKickCooldown:  2.0,
};
