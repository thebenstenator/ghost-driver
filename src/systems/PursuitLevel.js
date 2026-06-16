// Pursuit escalation — the "how hard are they looking for you" layer that sits on
// top of the (level-agnostic) cop AI. HEAT is the source of truth; LEVEL is derived
// from it. Keeping heat as the primary scalar future-proofs the bigger picture:
//   • Escaping doesn't hard-reset — heat BLEEDS toward a floor, so getting re-spotted
//     soon after a ditch snaps you back into a still-hot pursuit.
//   • A vehicle can later RETAIN heat between missions (just persist this scalar +
//     decay it while the car sits idle) — `heatFloor` / get|setHeat are the seam.
//   • Disabling a cop is a big heat spike + a longer replacement timer (stubbed hook).
//
// Each level sets a cop CAP and an aggression/cooldown profile. The deployed cop
// count grows toward the cap on a reinforcement timer (handled by the scene); crossing
// UP into a level also dispatches one immediately.
export class PursuitLevel {
  constructor() {
    this.heat = 0;

    // Heat at which each level BEGINS (index = level; level is the highest threshold
    // whose heat we've reached). L1 begins at 0. Only 1–2 are live; 3–5 are stubs.
    this.thresholds = [0, 0, 30 /*, 70, 120, 180 */];
    this.maxLevel   = 2;

    // Per-level config (index = level). cap = max deployed cops; reinforce = seconds
    // between trickle reinforcements up to the cap; cooldown = ditch timer (s);
    // reaction/boxTrigger = aggression knobs pushed onto the cops/director.
    this.config = [
      null,
      { cap: 2, reinforce: 12, cooldown: 20, reaction: 0.18, boxTrigger: 150 }, // L1
      { cap: 4, reinforce: 14, cooldown: 30, reaction: 0.10, boxTrigger: 220 }, // L2
      // L3–5: fill in when Interceptor / roadblocks / spikes / heli land.
    ];

    this.activeRate = 1.0;  // heat/s gained while actively pursued
    this.bleedRate  = 2.0;  // heat/s shed once ditched / stood down (escape cools you)
    this.heatFloor  = 0;    // heat never bleeds below this (future: vehicle-retained heat)
    this.ramHeat    = 5;    // heat per player→cop contact ("minor collision")

    // [future, when disabling exists] disabling a cop is a big spike + slow replace.
    this.disableHeat      = 15;
    this.disableReinforce = 25;

    this._level = 1;
  }

  get level() { return this._level; }
  cfg()       { return this.config[this._level]; }
  getHeat()   { return this.heat; }
  setHeat(h)  { this.heat = Math.max(this.heatFloor, h); this._level = this._levelFromHeat(); }
  addHeat(n)  { this.heat += n; }

  // phase: 'ACTIVE' rises heat, 'HOLD' freezes it (pre-ditch cooldown), 'BLEED' sheds it.
  // Returns the signed change in derived level this tick (+1 leveled up, -1 bled down).
  update(phase, dt) {
    if      (phase === 'ACTIVE') this.heat += this.activeRate * dt;
    else if (phase === 'BLEED')  this.heat = Math.max(this.heatFloor, this.heat - this.bleedRate * dt);
    // 'HOLD' leaves heat untouched.
    const prev = this._level;
    this._level = this._levelFromHeat();
    return this._level - prev;
  }

  atMax() { return this._level >= this.maxLevel; }

  // Progress (0..1) from the current level's heat threshold toward the next level's,
  // for the HUD meter. Pegged at 1 when already at the max level.
  heatFraction() {
    if (this._level >= this.maxLevel) return 1;
    const lo = this.thresholds[this._level] || 0;
    const hi = this.thresholds[this._level + 1];
    const f = (this.heat - lo) / Math.max(1, hi - lo);
    return f < 0 ? 0 : f > 1 ? 1 : f;
  }

  _levelFromHeat() {
    let lv = 1;
    for (let i = 2; i < this.thresholds.length && i <= this.maxLevel; i++) {
      if (this.heat >= this.thresholds[i]) lv = i;
    }
    return lv;
  }

  // [future] call when the player disables a cop: big heat spike, returns the (longer)
  // replacement-reinforcement delay the scene should use for the next dispatch.
  onCopDisabled() {
    this.addHeat(this.disableHeat);
    return this.disableReinforce;
  }
}
