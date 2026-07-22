// Vault — armored truck (Speed 1/5, Accel 1/5, Handling 2/5, Mass 5/5, Stealth 1/5)
// "They can't stop what they can't move."
// Built for survival, not escape. Cop impacts are physics work for them, not for you.
// The tradeoff: you will NOT outrun a pursuit — you have to outlast it, or route it.
//
// The code below is the source of truth for this car (playtest-tuned). These are the
// PURSUIT-MODE defaults: a running armored truck is conspicuous (low stealth → cops call
// it in fast), but slow to boil once the chase is on (low heatRate). Missions that want a
// "blend into traffic until you run" feel should raise stealth via a per-mission override.

export const VAULT = {
  // --- Sprite / display ---
  texture:       'vault',
  // Deliberately stretched WIDER than the source 2:3 ratio (74 vs the natural 56) so the truck
  // reads chunky/SUV-like instead of long-and-skinny. Aspect distortion is intentional; capR and
  // lightHalfWid below are widened to match so the collider/lights track the fatter silhouette.
  displayWidth:  74,
  displayHeight: 84,
  bodySize:      42,   // big AABB backstop; truck footprint

  // --- Capsule collider ---
  capR:       14,   // collision radius (≈ half the chassis width)
  capHalfLen: 19,   // long spine (armored truck is long)
  capOffset:  -6,   // fore/aft shift of the WHOLE capsule along the spine (−ve = toward the tail)
  mass:       4.0,  // Mass 5/5 — heaviest in the roster; shoves cops like parked cars

  // --- Light anchors (tuned live via Car panel) ---
  lightHalfLen: 40,
  lightHalfWid: 23,

  // --- Notoriety / stealth (Stealth 1/5 — a running armored truck is unmistakable) ---
  // stealth (1-5) → cop reinforcement urgency via notoriety = (5-stealth)/4: LOW stealth =
  // conspicuous = cops call it in fast. heatRate (< 1) keeps ACTIVE-pursuit escalation slow —
  // hard to hide, slow to boil. Missions can override stealth up for a blend-in premise.
  heatRate: 0.65,
  stealth:  1,

  // --- Health (Durability 5/5 — the tank) ---
  // Career-mode vehicle health baseline (see gameplay.md → Vehicle Damage). Highest in the roster;
  // combined with its mass (takes less ram damage), the Vault is the "outlast it" pick.
  health: 240,

  // --- Engine (Accel 1/5, Speed 2/5) ---
  maxSpeed:        500,  // drag-limited to ~215 actual top speed
  maxReverseSpeed: 100,
  acceleration:    155,  // Accel 1/5 — grinds up to speed
  hardBrakeForce:  90,   // takes real distance to stop — ~4s from top speed
  brakeForce:      75,   // S-key equally sluggish; must pre-brake for every turn
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
  coastDrag:      0.986,   // bleeds speed slowly when coasting into turns
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
