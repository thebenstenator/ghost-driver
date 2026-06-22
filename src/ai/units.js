// Cop UNIT TYPES — the single source of truth for what a cop IS.
//
// Until now there was one implicit cop: CopCar hardcoded a "patrol" handling block
// and CopAI hardcoded its tunables. Every pursuit level could only differ in cop
// COUNT, never composition. A UnitDef makes a cop type explicit DATA so levels can
// reference a real mix (see each level's `roster` in PursuitLevel) and the dispatcher
// can fill toward that composition.
//
// ── UnitDef shape ────────────────────────────────────────────────────────────
//   handling : overrides merged onto Vehicle's defaults → becomes CopCar.stats.
//              CopCar copies these into BOTH the live fields AND the base* fields the
//              Tier-1 rejoin blend reads, so the def OWNS the in-the-fight baseline.
//   ai       : overrides merged onto CopAI's tunables (directRange, chaseRange,
//              cornerMinSpeed, …). Empty ⇒ the unit uses CopAI's defaults. Per-level
//              `reaction` is still applied by the scene on top of this (level-scoped).
//   appearance: optional sprite overrides (size/tint). Omitted ⇒ CopCar's defaults.
//   placement: how the unit ENTERS the chase when dispatched (see GameScene dispatch):
//              'flank-offscreen' = today's behavior (warp to an off-screen road node
//              near the player). 'ahead-of-travel' / 'static-placed' / 'aerial' are
//              future strategies for purpose-built units (interceptor/roadblock/heli).
//   role     : default behavior bias (informational for now; the director/abilities
//              act on it later). 'pursue' = the baseline chase.
//   health   : damage soaked before disabled (§7 — carried now, UNUSED until ram
//              disabling is wired). mass: ram-exchange weight (same — carried, unused).
//   priority : retirement order on bleed-down — LOWER is retired first (filler goes,
//              threat units stay). Patrol is the baseline filler at 0.
//   ability  : optional special hook key (interceptor head-on, spike drop, …). null
//              for the plain pursuer.
//
// NOTE: this is deliberately a PURE-REFACTOR catalog — `patrol` reproduces the exact
// values CopCar/CopAI used before, so the chase is byte-for-byte unchanged. New types
// (interceptor, heavy, spike, …) are added here as they're built, one level at a time.
export const UNITS = {
  patrol: {
    name: 'Patrol',
    appearance: { texture: 'cop_patrol', displayWidth: 25, displayHeight: 58, bodySize: 23, capR: 11, capHalfLen: 16 },
    handling: {
      // Top-speed dial — real top (~450 after drag) sits just under the player's, so
      // you can edge away on a straight. acceleration matched to that cap.
      maxSpeed:       495,
      acceleration:   350,
      // Near-kinematic grip: velocity tracks facing almost instantly, so no drift lag
      // washes the cop wide into a building. (Player is 0.14/0.03 — the cop is planted.)
      gripLow:        0.6,
      gripHigh:       0.2,
      gripSpeedRef:   480,
      turnSpeedLow:   2.5,
      turnSpeed:      5,
      // Near-full steering authority at any speed so the path-follower can always turn
      // (player is 0 — can't pivot in place). This is what makes the cop deadlock-proof.
      minSteerFactor: 0.8,
    },
    ai:         {},                  // baseline brain — all CopAI defaults
    placement:  'flank-offscreen',
    role:       'pursue',
    health:     100,
    mass:       1.0,
    ramStrength: 0.3,                // a frontal patrol hit is noticeable but survivable
    priority:   0,
    ability:    null,
  },

  // Interceptor (L3+). Faster, more aggressive patrol that ENTERS ahead of the player
  // and drives a head-on. CRITICAL: it shares the SAME brain (CopAI.getControls) as every
  // other cop — it differs ONLY in (1) these handling numbers, (2) its placement strategy
  // ('ahead-of-travel'), and (3) the GOAL it's handed. The head-on is NOT new steering: it
  // spawns ahead facing you and chases the shared target, so the existing LOS-gated beeline
  // makes contact. `ai` is left at the baseline so its decision-making is identical to
  // patrol's — the only differences are speed/aggression (tune the rest in the testbed).
  // health/mass are carried for the (deferred) ram-disabling; priority keeps it on the
  // chase over filler patrols on bleed-down.
  interceptor: {
    name: 'Interceptor',
    // The source art points FRONT-DOWN, so spin it 180° (textureRotation: π) to face travel.
    appearance: { texture: 'cop_interceptor', displayWidth: 25, displayHeight: 60, bodySize: 23, textureRotation: Math.PI, capR: 11, capHalfLen: 17 },
    handling: {
      maxSpeed:       560,   // faster than patrol (495) so it can get ahead / close a head-on
      acceleration:   430,   // more aggressive pickup
      gripLow:        0.6,
      gripHigh:       0.22,  // a touch grippier at speed to hold its fast line
      gripSpeedRef:   480,
      turnSpeedLow:   2.5,
      turnSpeed:      5,
      minSteerFactor: 0.8,
    },
    ai:         {},                  // SAME decision tunables as patrol (identical brain)
    placement:  'ahead-of-travel',
    role:       'intercept',
    health:     150,                 // survives most rams; a full mutual head-on can drop it
    mass:       1.0,
    ramStrength: 0.7,                // a frontal interceptor hit slows you HARD
    priority:   2,                   // threat unit — retired last
    ability:    'intercept',
  },

  // Heavy / Enforcer (L4+). The rhino: a big, tanky, less-maneuverable tank that enters
  // ahead for a head-on you can't easily win, soaks rams (high health + mass → less ram
  // damage AND it shoves you / barely budges), and is meant to set up mobile solo
  // roadblocks. SAME brain as everyone (ai: {}) — it differs only in its bulk (size/mass/
  // health), its lumbering handling, and the goal it's handed. SLICE 1 = the tank + the
  // head-on (reuses placement/respawn-ahead); SLICE 2 adds the park-across-the-road block.
  heavy: {
    name: 'Heavy',
    appearance: { texture: 'cop_heavy', displayWidth: 35, displayHeight: 67, bodySize: 27, capR: 15, capHalfLen: 18 }, // WIDER (stretched ~10%) so the heavy reads as distinct; capsule widened to match
    handling: {
      maxSpeed:       430,   // slower than patrol — it can't chase you down, it BLOCKS you
      acceleration:   300,   // sluggish pickup (lots of metal to move)
      gripLow:        0.55,
      gripHigh:       0.18,
      gripSpeedRef:   480,
      turnSpeedLow:   1.8,   // less maneuverable than patrol (2.5 / 5) — corners wide
      turnSpeed:      3.2,
      minSteerFactor: 0.7,
    },
    ai:         {},                  // SAME decision tunables as patrol (identical brain)
    placement:  'ahead-of-travel',
    role:       'pursue',            // tanky head-on unit + pursuer (solo-roadblock removed — the
                                     // static roadblock formation handles road-blocking now)
    health:     220,                 // tanky — multiple committed rams to put down
    mass:       2.4,                 // heavy enough that a head-on mass exchange alone ~stops you
    ramStrength: 1.0,                // a frontal heavy hit is a near-complete stop
    priority:   3,                   // top threat — retired last
    ability:    null,
  },

  // Spike unit (L5). The spike-strip cruiser: it NEVER rams — it gets AHEAD of the player and
  // drops a spike strip in their path, then eases in front so they drive onto it. SAME brain as
  // everyone (ai: {}); it differs only in (1) the spike-run maneuver (a variant of the overtake
  // that DEPLOYS instead of brake-checks — see PursuitDirector._updateSpikeRun), (2) its ability
  // tag, and (3) carrying a strip count. Slightly boosted speed so it can actually get ahead.
  // Health/mass ≈ base (it survives long enough to deploy, but it's not a tank). Dropped strips
  // are the hazard wired next (pop the player's tires). Placeholder art = patrol cruiser for now.
  spike: {
    name: 'Spike',
    appearance: { texture: 'cop_patrol', displayWidth: 25, displayHeight: 58, bodySize: 23, capR: 11, capHalfLen: 16 },
    handling: {
      maxSpeed:       560,   // matches the interceptor — with the spike boost it can clear ahead to deploy
      acceleration:   430,
      gripLow:        0.6,
      gripHigh:       0.21,
      gripSpeedRef:   480,
      turnSpeedLow:   2.5,
      turnSpeed:      5,
      minSteerFactor: 0.8,
    },
    ai:         {},                  // SAME decision tunables as patrol (identical brain)
    placement:  'ahead-of-travel',
    role:       'deploy',
    health:     160,                 // ≈ base, slightly boosted — lives long enough to deploy
    mass:       1.1,
    ramStrength: 0,                  // it never rams — no frontal-ram special
    spikeStrips: 3,                  // strips carried before a long reload (spec start = 3)
    priority:   2,                   // threat-ish — retired after filler patrols
    ability:    'spike',
  },
};

// Resolve a unit type to a def, falling back to patrol for an unknown key. A level
// roster may name a type (e.g. `interceptor`) before that type's def exists yet — the
// dispatcher then spawns a placeholder patrol, exactly as it did before this refactor.
export function unitDef(type) {
  return UNITS[type] || UNITS.patrol;
}
