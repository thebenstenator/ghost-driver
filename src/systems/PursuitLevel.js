// Pursuit escalation — the "how hard are they looking for you" layer that sits on
// top of the (level-agnostic) cop AI. HEAT is the source of truth; LEVEL is derived.
//
// Heat is measured in "active-pursuit seconds": at the default activeRate of 1, one
// second of being actively chased adds one heat. Each level N owns a SPAN (seconds to
// escalate from N to N+1), so the spans are deliberately NON-UNIFORM (later levels
// take much longer to reach). Cumulative spans give the heat thresholds that derive
// the level; the ceiling is the threshold to enter maxLevel.
//
//   • Heat RISES during active pursuit (+ a bump per HARD cop contact — a gentle bumper-ride
//     below ramHeatThreshold adds nothing, and the bump is scaled by the car's heatRate like
//     the active rate is, so a stealthy/tanky car isn't punished for absorbing hits), FREEZES during the
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
      ramHeat:    5,     // heat per HARD player↔cop contact (gated by ramHeatThreshold, ×heatRate)
      ramHeatThreshold: 150, // closing speed (px/s) a contact needs to count as a "ram" for heat —
                             // below it (a cop matching your speed on your bumper) adds no heat
      heatFloor:  0,     // global minimum (future: vehicle-retained heat)
      disableHeat:      15,  // [future] heat spike when the player disables a cop
      disableReinforce: 25,  // [future] longer replacement delay after a disable
      // Fast-then-slow bleed: shed `fastFrac` of the current level's span at
      // `fastRate`, then drop to `slowRate` toward the floor.
      bleed: { fastFrac: 0.5, fastRate: 4.0, slowRate: 0.5 },
      // Reinforcement urgency: how a NOTORIOUS car or an already-HOT situation compresses
      // the per-level reinforce interval + shortens the cold-start "recognition" beat.
      //   • cadenceGain — max fraction the ongoing interval is compressed at full urgency.
      //   • recognition — extra cold-start delay (× base interval) at ZERO urgency, i.e.
      //     the "routine stop" grace a stealthy car gets before the FIRST call-in.
      reinforceUrgency: { cadenceGain: 0.5, recognition: 0.75 },
      // Roster keys are authored SPECIALS-FIRST: _nextReinforcementType dispatches the first
      // unmet type, so the level's threat units arrive before filler patrols. Caps verified
      // (L3 6, L4 10, L5 16). `roadblocks` gates the pursuit-side auto-spawn (difficulty derived
      // from level in GameScene): L3 = light, L4 = escalating, L5 = max.
      // `searchers` = transient units called in when a chase is LOST (breaks LOS): they close
      // from AHEAD on the escape vector to re-establish contact, may exceed `cap` briefly, and are
      // trimmed back to cap once the chase re-engages (see GameScene search-burst). Scales with heat.
      levels: [
        null,
        // span  cap  reinforce cooldown reaction boxTrigger  searchers  roster (specials-first)
        { span: 35,  cap: 2,  reinforce: 15, cooldown: 20, reaction: 0.18, boxTrigger: 150, searchers: 1,
          roster: { patrol: 2 } },                                                   // L1
        { span: 60,  cap: 4,  reinforce: 18, cooldown: 30, reaction: 0.10, boxTrigger: 220, searchers: 2,
          roster: { patrol: 4 } },                                                   // L2
        { span: 120, cap: 6,  reinforce: 25, cooldown: 35, reaction: 0.08, boxTrigger: 240, searchers: 3,
          roster: { interceptor: 2, patrol: 4 }, roadblocks: true },                 // L3
        { span: 240, cap: 10, reinforce: 30, cooldown: 40, reaction: 0.06, boxTrigger: 260, searchers: 4,
          roster: { heavy: 2, interceptor: 2, spike: 1, patrol: 5 }, roadblocks: true }, // L4
        { span: 0,   cap: 16, reinforce: 40, cooldown: 45, reaction: 0.05, boxTrigger: 280, searchers: 5,
          roster: { heavy: 3, interceptor: 3, spike: 3, patrol: 7 }, roadblocks: 'max', heli: true }, // L5
      ],
    };
  }

  constructor(missionConfig = null) {
    const c = missionConfig || PursuitLevel.defaultConfig();
    this.maxLevel         = c.maxLevel;
    this.activeRate       = c.activeRate;
    this.ramHeat          = c.ramHeat;
    this.ramHeatThreshold = c.ramHeatThreshold ?? 150;
    this.heatFloor        = c.heatFloor;
    this.disableHeat      = c.disableHeat;
    this.disableReinforce = c.disableReinforce;
    this.bleed            = { ...c.bleed };
    // Clone the rows so the dev panel mutating them can't corrupt the static default
    // (which the next scene restart would otherwise inherit).
    this.levels = c.levels.map(l => (l ? { ...l } : null));

    // Per-vehicle notoriety, set by the scene from the selected car's stats:
    //   • heatRate  — multiplies ACTIVE heat accrual (stealthy < 1; conspicuous > 1).
    //   • notoriety — 0..1 (inverse of the Stealth stat); scales how fast cops CALL IN
    //     reinforcements. Both default to the stat-agnostic baseline (nothing changes
    //     until a vehicle overrides them).
    this.heatRate    = 1;
    this.notoriety   = 0;
    // Guard the spread so a mission config lacking reinforceUrgency doesn't NaN the math.
    this.reinforceUrgencyCfg = { cadenceGain: 0.5, recognition: 0.75, ...(c.reinforceUrgency || {}) };

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

  // Heat from ONE cop contact, given the pre-collision closing speed. A gentle bumper-ride
  // (below ramHeatThreshold) counts as nothing; a real ram lands the flat ramHeat bump, scaled
  // by heatRate so the car's notoriety damps CONTACT heat the same way it damps active accrual
  // (a slow tank that's meant to soak hits no longer heats fastest for playing to type). Returns
  // the heat to add (0 = not a ram); the caller owns the anti-scrape throttle.
  contactHeat(closingSpeed) {
    if (closingSpeed <= this.ramHeatThreshold) return 0;
    return this.ramHeat * this.heatRate;
  }

  // ── Reinforcement cadence (vehicle notoriety + live heat) ───────────────────────
  // Urgency (0..1): a notorious car OR an already-hot situation makes cops call it in
  // faster. Reads LIVE heat, so once heat persists across missions, a car that starts a
  // job hot gets fast call-ins for free — no extra logic.
  reinforceUrgency() {
    const heatN = this.maxHeat ? this.heat / this.maxHeat : 0;
    return Math.max(0, Math.min(1, this.notoriety + heatN));
  }

  // Ongoing seconds between reinforcement dispatches: the current level's base interval,
  // mildly compressed by urgency (never below (1 − cadenceGain) × base).
  reinforceEvery() {
    return this.cfg().reinforce * (1 - this.reinforceUrgencyCfg.cadenceGain * this.reinforceUrgency());
  }

  // Delay before the FIRST reinforcement of a fresh (cold-start) pursuit — the "routine
  // stop" beat. A stealthy car spotted cold gets up to recognition × base of extra grace
  // on top of the normal interval; urgency erodes that grace toward just the interval.
  firstReinforceDelay() {
    return this.cfg().reinforce * this.reinforceUrgencyCfg.recognition * (1 - this.reinforceUrgency())
         + this.reinforceEvery();
  }

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
      this.heat = Math.min(ceiling, this.heat + this.activeRate * this.heatRate * dt);
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

  // Called when the player disables a cop (wired in GameScene._updateCopDamage): big heat
  // spike, returns the (longer) replacement-reinforcement delay the scene uses for the next
  // dispatch.
  onCopDisabled() {
    this.addHeat(this.disableHeat);
    return this.disableReinforce;
  }
}
