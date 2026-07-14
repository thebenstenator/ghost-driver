// Razorback — sports car (Speed 5/5, Accel 4/5, Handling 3/5, Mass 1/5, Stealth 2/5)
// "Fast enough to outrun the mistake of driving it."
// Same handling RATING as the prowler (3/5) but feels twitchier because of lower grip and
// a higher top speed — you hit the handling limit faster and it bites harder when you do.

export const RAZORBACK = {
  // --- Sprite / display ---
  texture:       'razorback',
  displayWidth:  40,   // +8% from 37
  displayHeight: 60,   // +8% from 56; source is 1024×1536 (2:3), ratio preserved
  bodySize:      26,   // AABB backstop (capsule does the real work)

  // --- Capsule collider (scene-level; read by GameScene via playerCapR/capHalfLen/mass) ---
  capR:      8,   // baked by user
  capHalfLen: 8,  // baked by user
  mass:      0.8, // Mass 1/5 — lightest in the roster, BELOW a patrol cop (1.0), so in the
                  // capsule resolver it's the car that gets shoved: cops bully it around and it
                  // can't muscle out of a pileup. Pairs with the speed-scaled rubber band — you
                  // stay safe by staying CLEAR, but one mistake into a box is punishing.

  // --- Light anchors (overrides sprite-dim fallback in CarLights) ---
  // The razorback source is 1024×1536 with canvas padding around the car body, so the
  // sprite bounds are larger than the visible silhouette. Tune these live via the car panel.
  lightHalfLen: 22,  // +8% from 20
  lightHalfWid: 11,  // +8% from 10

  // --- Notoriety / stealth (Stealth 2/5 — conspicuous) ---
  // heatRate multiplies active-pursuit heat accrual. The razorback is a known quantity —
  // a chase boils toward a full pursuit FAST. Balances the top speed: you can ditch cops
  // trivially, but you're right back at high heat, so the escape never really finishes.
  // stealth (1-5) → cop reinforcement urgency: it has a reputation, so cops call it in
  // near-immediately on sight (see PursuitLevel notoriety).
  heatRate: 1.6,
  stealth:  2,

  // --- Engine ---
  maxSpeed:        780,  // Speed 5/5 — clearly faster than prowler (600), room above for Spectre
  maxReverseSpeed: 180,  // light car, less reverse grunt
  acceleration:    460,  // Accel 4/5 — punchier off the line
  hardBrakeForce:  300,  // lighter feel — brakes harder but with less mass
  brakeForce:      240,
  reverseAccel:    160,

  // --- Steering ---
  turnSpeedLow:       2.4,   // a touch more responsive at low speed
  turnSpeed:          1.0,   // same 3/5 rating but feels twitchier because grip is lower
  turnSpeedHandbrake: 1.45,  // more dramatic handbrake whip
  maxDriftAngle:      1.9163715186897738,
  pivotOffset:        22,    // more nose-lead — the front bites in hard on turn entry

  // --- Drag ---
  handBrakeDrag:  0.970,   // lighter car, handbrake slides run slightly longer
  coastDrag:      0.994,   // better momentum retention — turbocharged feel
  accelDragBase:  0.9980,  // less drag under power
  accelDragCurve: 0.022,   // approaches top-speed ceiling more steeply (surges then flattens)

  // --- Grip ---
  gripLow:          0.12,   // nervous at low speed — lighter, always at the edge
  gripHigh:         0.08,   // meaningfully less high-speed grip → twitchy/oversteery at pace
  gripSpeedRef:     300,    // grip ceiling reached earlier — enters oversteer sooner than prowler
  gripHandbrake:    0.006,  // bigger, longer drifts
  entryKick:        0.55,   // more aggressive snap into drift
  entryKickDuration:  0.85,
  entryKickCooldown:  0.85, // can chain drifts more quickly
};
