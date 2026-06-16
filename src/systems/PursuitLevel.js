// Pursuit escalation — the "how hard are they looking for you" layer that sits on
// top of the (level-agnostic) cop AI. HEAT is the source of truth; LEVEL is derived.
// Heat is measured in a uniform per-level SPAN: level N occupies heat
// [(N-1)*span, N*span], and the bar fills 0→1 within the current level. The ceiling
// is maxLevel*span (heat can't rise past it).
//
//   • Heat RISES during active pursuit (+ a bump per cop contact), FREEZES during the
//     pre-ditch cooldown (a brief LOS break can't bleed a level), and BLEEDS once
//     ditched/standing down — but only down by `bleedLevels` (1.5) from where you
//     ditched, then it plateaus. So escaping cools you fast yet you stay partly hot;
//     re-spotted too soon snaps back up. (Future: persist `heat` per vehicle + decay
//     on idle — getHeat/setHeat/heatFloor are the seam.)
//   • Each level sets a cop CAP + aggression profile; the scene fills toward the cap
//     on a reinforcement timer (+ one instant dispatch on level-up).
//   • Disabling a cop is a big heat spike + a longer replacement timer (stubbed hook).
export class PursuitLevel {
  constructor() {
    this.heat = 0;
    this.levelSpan = 45;   // heat per level — L1: 0–45, L2: 45–90, … ("Heat → next level")
    this.maxLevel  = 2;    // only 1–2 live; raise as L3–5 land

    // Per-level config (index = level). cap = max deployed cops; reinforce = seconds
    // between trickle reinforcements up to the cap; cooldown = ditch timer (s);
    // reaction/boxTrigger = aggression knobs pushed onto the cops/director.
    this.config = [
      null,
      { cap: 2, reinforce: 12, cooldown: 20, reaction: 0.18, boxTrigger: 150 }, // L1
      { cap: 4, reinforce: 14, cooldown: 30, reaction: 0.10, boxTrigger: 220 }, // L2
      // L3–5: fill in when Interceptor / roadblocks / spikes / heli land.
    ];

    this.activeRate  = 1.0;  // heat/s gained while actively pursued
    this.bleedRate   = 2.0;  // heat/s shed once ditched / standing down
    this.bleedLevels = 1.5;  // a single withdraw bleeds at most this many levels, then plateaus
    this.heatFloor   = 0;    // global minimum (future: vehicle-retained heat)
    this.ramHeat     = 5;    // heat per player→cop contact ("minor collision")

    // [future] disabling a cop: big spike + slow replacement.
    this.disableHeat      = 15;
    this.disableReinforce = 25;

    this._level = 1;
    this._prevPhase = 'ACTIVE';
    this._bleedFloor = 0;
  }

  get level()   { return this._level; }
  get maxHeat() { return this.maxLevel * this.levelSpan; }
  cfg()         { return this.config[this._level]; }
  getHeat()     { return this.heat; }
  setHeat(h)    { this.heat = Math.max(this.heatFloor, Math.min(this.maxHeat, h)); this._level = this._levelFromHeat(); }
  addHeat(n)    { this.heat = Math.min(this.maxHeat, this.heat + n); this._level = this._levelFromHeat(); }
  atMax()       { return this.heat >= this.maxHeat - 0.5; }

  // Progress (0..1) within the current level, for the HUD meter.
  heatFraction() {
    const within = this.heat - (this._level - 1) * this.levelSpan;
    const f = within / this.levelSpan;
    return f < 0 ? 0 : f > 1 ? 1 : f;
  }

  // phase: 'ACTIVE' rises, 'HOLD' freezes (pre-ditch cooldown), 'BLEED' sheds toward a
  // floor set 1.5 levels below the heat at the moment bleeding began. Returns the signed
  // change in derived level this tick (+1 leveled up, -1 bled down).
  update(phase, dt) {
    if (phase === 'ACTIVE') {
      this.heat = Math.min(this.maxHeat, this.heat + this.activeRate * dt);
    } else if (phase === 'BLEED') {
      if (this._prevPhase !== 'BLEED') {                       // entering the withdraw bleed
        this._bleedFloor = Math.max(this.heatFloor, this.heat - this.bleedLevels * this.levelSpan);
      }
      this.heat = Math.max(this._bleedFloor, this.heat - this.bleedRate * dt);
    }
    this._prevPhase = phase;
    const prev = this._level;
    this._level = this._levelFromHeat();
    return this._level - prev;
  }

  _levelFromHeat() {
    return Math.min(this.maxLevel, 1 + Math.floor(this.heat / this.levelSpan));
  }

  // [future] call when the player disables a cop: big heat spike, returns the (longer)
  // replacement-reinforcement delay the scene should use for the next dispatch.
  onCopDisabled() {
    this.addHeat(this.disableHeat);
    return this.disableReinforce;
  }
}
