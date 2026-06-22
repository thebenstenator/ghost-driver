// Pursuit escalation — the "how hard are they looking for you" layer that sits on
// top of the (level-agnostic) cop AI. HEAT is the source of truth; LEVEL is derived.
//
// Heat is measured in "active-pursuit seconds": at the default activeRate of 1, one
// second of being actively chased adds one heat. Each level N owns a SPAN (seconds to
// escalate from N to N+1), so the spans are deliberately NON-UNIFORM (later levels
// take much longer to reach). Cumulative spans give the heat thresholds that derive
// the level; the ceiling is the threshold to enter maxLevel.
//
//   • Heat RISES during active pursuit (+ a bump per cop contact), FREEZES during the
//     pre-ditch cooldown (a brief LOS break can't bleed a level), and BLEEDS once
//     ditched. Bleed is a FAST-THEN-SLOW profile: you shed the first fraction of a
//     level quickly (escaping feels immediately rewarding), then it plateaus and
//     bleeds slowly (you stay partly hot, so a re-spot snaps you back up).
//   • Each level sets a cop CAP + aggression profile + a ROSTER (intended unit mix);
//     the scene fills toward the cap on a reinforcement timer. Until the special unit
//     TYPES are built, the scene dispatches placeholder patrols toward the cap — the
//     roster is the plan we flesh out one level at a time.
//   • Config is MISSION-SCOPED: pass a mission's config to the constructor (max level,
//     spans, caps, bleed). The built-in default is the "endless" curve.
//   • Disabling a cop is a big heat spike + a longer replacement timer (stubbed hook).
export class PursuitLevel {
  // The built-in "endless mode" curve. A mission can pass its own shaped like this.
  // levels[0] is unused (1-indexed). `span` = active-pursuit SECONDS to reach the next
  // level (the top level's span is ignored). `roster` is the INTENDED unit mix for
  // when the unit types exist; today the scene spawns patrols toward `cap`.
  static defaultConfig() {
    return {
      maxLevel:   5,
      activeRate: 1.0,   // heat/s while actively pursued (1 ⇒ heat == active-pursuit seconds)
      ramHeat:    5,     // heat per player↔cop contact
      heatFloor:  0,     // global minimum (future: vehicle-retained heat)
      disableHeat:      15,  // [future] heat spike when the player disables a cop
      disableReinforce: 25,  // [future] longer replacement delay after a disable
      // Fast-then-slow bleed: shed `fastFrac` of the current level's span at
      // `fastRate`, then drop to `slowRate` toward the floor.
      bleed: { fastFrac: 0.5, fastRate: 4.0, slowRate: 0.5 },
      // Roster keys are authored SPECIALS-FIRST: _nextReinforcementType dispatches the first
      // unmet type, so the level's threat units arrive before filler patrols. Caps verified
      // (L3 6, L4 10, L5 16). `roadblocks` gates the pursuit-side auto-spawn (difficulty derived
      // from level in GameScene): L3 = light, L4 = escalating, L5 = max.
      levels: [
        null,
        // span  cap  reinforce cooldown reaction boxTrigger   roster (specials-first)
        { span: 35,  cap: 2,  reinforce: 15, cooldown: 20, reaction: 0.18, boxTrigger: 150,
          roster: { patrol: 2 } },                                                   // L1
        { span: 60,  cap: 4,  reinforce: 18, cooldown: 30, reaction: 0.10, boxTrigger: 220,
          roster: { patrol: 4 } },                                                   // L2
        { span: 120, cap: 6,  reinforce: 25, cooldown: 35, reaction: 0.08, boxTrigger: 240,
          roster: { interceptor: 2, patrol: 4 }, roadblocks: true },                 // L3
        { span: 240, cap: 10, reinforce: 30, cooldown: 40, reaction: 0.06, boxTrigger: 260,
          roster: { heavy: 2, interceptor: 2, spike: 1, patrol: 5 }, roadblocks: true }, // L4
        { span: 0,   cap: 16, reinforce: 40, cooldown: 45, reaction: 0.05, boxTrigger: 280,
          roster: { heavy: 3, interceptor: 3, spike: 3, patrol: 7 }, roadblocks: 'max', heli: true }, // L5
      ],
    };
  }

  constructor(missionConfig = null) {
    const c = missionConfig || PursuitLevel.defaultConfig();
    this.maxLevel         = c.maxLevel;
    this.activeRate       = c.activeRate;
    this.ramHeat          = c.ramHeat;
    this.heatFloor        = c.heatFloor;
    this.disableHeat      = c.disableHeat;
    this.disableReinforce = c.disableReinforce;
    this.bleed            = { ...c.bleed };
    // Clone the rows so the dev panel mutating them can't corrupt the static default
    // (which the next scene restart would otherwise inherit).
    this.levels = c.levels.map(l => (l ? { ...l } : null));

    this.heat        = this.heatFloor;
    this._level      = 1;
    this._prevPhase  = 'ACTIVE';
    this._bleedStart = 0;
    this._bleedFast  = 0;
  }

  // Cumulative heat to ENTER each level, rebuilt from the live spans so dev-panel
  // edits take effect immediately. enter[1] = floor; enter[N] = enter[N-1] + spanₙ₋₁.
  _enter() {
    const e = new Array(this.maxLevel + 1).fill(0);
    e[1] = this.heatFloor;
    for (let n = 2; n <= this.maxLevel; n++) {
      e[n] = e[n - 1] + this.levels[n - 1].span * this.activeRate;
    }
    return e;
  }

  _levelFromHeat(e) {
    let lv = 1;
    for (let n = 2; n <= this.maxLevel; n++) {
      if (this.heat >= e[n]) lv = n; else break;
    }
    return lv;
  }

  get level()   { return this._level; }
  get maxHeat() { return this._enter()[this.maxLevel]; }
  cfg()         { return this.levels[this._level]; }
  getHeat()     { return this.heat; }
  setHeat(h)    { const e = this._enter(); this.heat = Math.max(this.heatFloor, Math.min(e[this.maxLevel], h)); this._level = this._levelFromHeat(e); }
  addHeat(n)    { const e = this._enter(); this.heat = Math.min(e[this.maxLevel], this.heat + n);                this._level = this._levelFromHeat(e); }
  atMax()       { return this.heat >= this.maxHeat - 0.5; }

  // Progress (0..1) within the current level, for the HUD meter. Top level reads full.
  heatFraction() {
    const e = this._enter();
    const lv = this._level;
    if (lv >= this.maxLevel) return 1;
    const f = (this.heat - e[lv]) / (e[lv + 1] - e[lv]);
    return f < 0 ? 0 : f > 1 ? 1 : f;
  }

  // phase: 'ACTIVE' rises, 'HOLD' freezes (pre-ditch cooldown), 'BLEED' sheds with the
  // fast-then-slow profile. Returns the signed change in derived level this tick.
  update(phase, dt) {
    const e = this._enter();
    const ceiling = e[this.maxLevel];

    if (phase === 'ACTIVE') {
      this.heat = Math.min(ceiling, this.heat + this.activeRate * dt);
    } else if (phase === 'BLEED') {
      if (this._prevPhase !== 'BLEED') {                       // entering the withdraw bleed
        this._bleedStart = this.heat;
        const lv = this._level;
        const span = lv < this.maxLevel ? (e[lv + 1] - e[lv]) : (e[lv] - e[lv - 1]);
        this._bleedFast = this.bleed.fastFrac * span;          // shed this much FAST, then slow
      }
      const shed = this._bleedStart - this.heat;
      const rate = shed < this._bleedFast ? this.bleed.fastRate : this.bleed.slowRate;
      this.heat = Math.max(this.heatFloor, this.heat - rate * dt);
    }
    // 'HOLD' freezes — no change.

    this._prevPhase = phase;
    const prev = this._level;
    this._level = this._levelFromHeat(e);
    return this._level - prev;
  }

  // [future] call when the player disables a cop: big heat spike, returns the (longer)
  // replacement-reinforcement delay the scene should use for the next dispatch.
  onCopDisabled() {
    this.addHeat(this.disableHeat);
    return this.disableReinforce;
  }
}
