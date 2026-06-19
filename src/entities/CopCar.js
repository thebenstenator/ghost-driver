import { Vehicle } from './Vehicle.js';
import { CopAI } from '../ai/CopAI.js';
import { UNITS, unitDef } from '../ai/units.js';

// A pursuing cop car. Same physics as the player, driven by a CopAI.
//
// ── HOW TO TUNE A COP ──────────────────────────────────────────────────────
// A cop is now defined by a UNIT TYPE (see `src/ai/units.js`). The type's def
// carries its `handling` (→ Vehicle stats), its `ai` overrides (→ CopAI tunables),
// and metadata (placement/role/health/mass). To tune an existing type, edit its
// def; to add a new kind of cop, add a def — don't hardcode numbers here.
//
// Cop *behaviour* (how it decides to drive — pursuit, cornering, stuck recovery,
// approach/ram) lives in CopAI; the def's `ai` block overrides those tunables
// per-type. `unitType` defaults to 'patrol' so existing callers are unchanged.
// ───────────────────────────────────────────────────────────────────────────
export class CopCar extends Vehicle {
  constructor(scene, x, y, navGrid, rects = null, unitType = 'patrol') {
    const def = unitDef(unitType);
    const look = def.appearance || {};
    super(scene, x, y, {
      texture: 'player_car',
      displayWidth:  look.displayWidth  ?? 38,
      displayHeight: look.displayHeight ?? 60,
      bodySize:      look.bodySize      ?? 30,
      depth: 9,
      tint:     look.tint ?? 0xffffff,  // flat white silhouette so cops pop against the dark map
      tintFill: true,
      stats: { ...def.handling },       // the type's handling profile (merged over Vehicle defaults)
    });

    // Identity + (future) combat stats from the def. health/mass are carried now but
    // unused until ram-disabling (§7) is wired — keeping them here so the def is the
    // single source once that lands.
    // Tag the RESOLVED type so unitType always names a real, defined unit: an unknown
    // roster key (e.g. `interceptor` before its def exists) is a placeholder patrol, so
    // it reports as a patrol. Once the real def lands, the same key resolves to itself.
    this.unitType = UNITS[unitType] ? unitType : 'patrol';
    this.unitDef  = def;
    this.health   = def.health;
    this.maxHealth = def.health;
    this.mass     = def.mass;
    // Mass drives BOTH the ram-damage math (heavier soaks more) AND the physics: a heavy
    // body shoves the player and barely budges in a collision.
    this.sprite.body.mass = def.mass;

    this.ai = new CopAI(navGrid, rects, def.ai);
    this.aiTarget = { x, y }; // current steering target, for debug draw
    // Base handling — the "in the fight" profile. When a cop falls far behind, the
    // scene's Tier-1 rejoin blend lerps the LIVE stats from these toward a near-
    // kinematic profile (high grip, sharper turns, small speed boost) so it stops
    // washing into walls and rejoins cleanly. The blend writes the live fields each
    // frame, so these untouched copies are what it blends FROM.
    this.baseMaxSpeed     = this.maxSpeed;
    this.baseGripLow      = this.gripLow;
    this.baseGripHigh     = this.gripHigh;
    this.baseTurnSpeedLow = this.turnSpeedLow;
    this.baseTurnSpeed    = this.turnSpeed;
  }

  // target: an object with .x / .y in world space (the player, or a last-known
  // position). A null target means "stand down" — coast to a stop.
  update(delta, target) {
    if (!target) {
      super.update(delta, { up: false, down: false, left: false, right: false, handbrake: false, brake: true });
      this.aiTarget = null;
      this.debug = { mode: 'STANDDOWN', speed: this.getSpeed(), dist: 0, bend: 0,
                     cornerLimit: 0, angleErr: 0 };
      return;
    }
    const controls = this.ai.getControls(this, target, delta / 1000);
    super.update(delta, controls);
  }
}
