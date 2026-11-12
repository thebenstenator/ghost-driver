import { poiById } from '../world/city.js';

// Mission runtime — the career game loop, kept as PURE LOGIC (no Phaser) so it's trivial to
// reason about and test. GameScene owns the visuals (briefing card, beacon, result screen) and
// the chase systems; each frame it feeds this machine a few facts and reads back what to show.
//
// A mission is an ordered list of STEPS. Every step is "get to a POI under some condition":
//   poi        id of the POI to reach (world/city.js POIS)
//   need       'unseen'  — no cop has eyes on you right now (pursuit not ACTIVE)
//              'ditched' — the cops have fully LOST you (the ditch cooldown ran out); being merely
//                          out of sight is not enough. The "can't lead them to it" condition.
//   dwell      seconds the condition must hold, uninterrupted, inside the POI circle (0 = on arrival)
//   stop       true → you must also be (nearly) stationary for the dwell to count (a pickup)
//   label      the objective, shown briefly when the step starts
//   blocked    what to do instead, shown while you're in the circle but the condition fails
//   hold       what's happening, shown (with seconds left) while the dwell runs
//   alert      true → finishing the step blows your cover: the scene converges the cops on you
//   passenger  true → finishing the step puts a passenger aboard (the scene weighs the car down)
// The mission is COMPLETE when the last step finishes, FAILED on a bust.

export const MissionState = {
  BRIEFING: 'BRIEFING',
  ACTIVE:   'ACTIVE',
  COMPLETE: 'COMPLETE',
  FAILED:   'FAILED',
};

// Mission registry, in career order: finishing one unlocks the next (GameScene.missionUnlocked).
// The ids are save keys, not positions — Side Streets (m2) is the opening job because it is the
// gentlest; The Shakedown (m1) follows.
// `maxLevel` caps the pursuit level for the job (omit = the full 5-level curve).
export const MISSIONS = [
  {
    id: 'm2',
    name: 'SIDE STREETS',
    job: 'Package Drop',
    summary: 'Deliver to a back-alley drop. Lead the cops there and it is off.',
    briefing:
      'Simple delivery: a parcel for a man who does not exist, at an address in the\n' +
      'Backstreets that is not on any map. One rule — you do NOT bring company.\n' +
      'Out of sight is not good enough. Lose them completely, let the radio go\n' +
      'quiet, and only then roll up to the drop. Arrive hot and the door stays shut.',
    tip: 'the alleys are tight but they break line of sight fast — wait for the chase to cool right down',
    reward: 3500,
    maxLevel: 2,
    steps: [
      { poi: 'alley_drop', need: 'ditched', dwell: 2, stop: true,
        label: 'Lose the cops completely, then reach the Alley Drop',
        blocked: 'Lose the cops completely',
        hold: 'Making the drop' },
    ],
  },
  {
    id: 'm1',
    name: 'THE SHAKEDOWN',
    job: 'Package Pickup',
    summary: 'Grab a package on the docks, then run it back across town.',
    briefing:
      'A package is waiting out on the docks — clear across the bay — and the heat\n' +
      'is already on your tail. Shake them, then sit on the Drop until it is secure\n' +
      '(stay clear of their headlights). The moment you grab it they will know where\n' +
      'you are — lose them again and make the safehouse in the Neon Mile, all the way\n' +
      'back across town, to call it a night.',
    tip: 'cut your lights (Q) while you sit on the drop — a blacked-out car is only spotted up close',
    reward: 4500,
    maxLevel: 2,
    steps: [
      { poi: 'drop', need: 'unseen', dwell: 5, alert: true,
        label: 'Reach the Drop and lie low', blocked: 'Shake them before you stop', hold: 'Securing the drop' },
      { poi: 'safe_neon', need: 'unseen', dwell: 0,
        label: 'Reach the Neon Mile Garage unseen', blocked: 'Break their line of sight first' },
    ],
  },
  {
    id: 'm3',
    name: 'THE LONG WAY ROUND',
    job: 'Extraction',
    summary: 'Collect a contact in the Ironworks and get them to a safehouse.',
    briefing:
      'Someone needs to leave town and cannot be seen doing it. They are waiting in\n' +
      'the Ironworks, north-west. Shake your tail, pull up and STOP so they can get\n' +
      'in — they will not step out with cops watching. Then it is the long way\n' +
      'round: the safehouse is in the Backstreets, clear across the city, and the\n' +
      'car will feel the extra weight.',
    tip: 'with a passenger aboard you accelerate and turn a little slower — brake earlier, plan the route',
    reward: 6000,
    maxLevel: 3,
    steps: [
      { poi: 'contact', need: 'unseen', dwell: 3, stop: true, alert: true, passenger: true,
        label: 'Reach The Contact in the Ironworks',
        blocked: 'They will not come out with cops watching',
        hold: 'Picking up the contact' },
      { poi: 'safe_backstreets', need: 'unseen', dwell: 0,
        label: 'Deliver the contact to the Backstreet Garage unseen',
        blocked: 'Break their line of sight first' },
    ],
  },
];
export const missionById = (id) => MISSIONS.find((m) => m.id === id) || null;

const STOP_SPEED = 45; // px/s — at or below this the car counts as stopped (for `stop` steps)

export class Mission {
  // `snap(poi)` lets the scene move an open-air POI onto a drivable road node; it must return a
  // (possibly new) { x, y, r, name } object and never mutate the shared POIS entry.
  constructor(def, snap = (p) => p) {
    this.def   = def;
    this.state = MissionState.BRIEFING;
    this.steps = def.steps.map((s) => ({ ...s, target: snap(poiById(s.poi)) }));
    this.index = 0;           // current step
    this._dwell    = 0;       // seconds the current step's condition has held
    this._inCircle = false;   // player inside the current POI radius this frame
    this._blocked  = false;   // inside the circle but the condition fails
    this._moving   = false;   // inside the circle, condition met, but a `stop` step and still rolling
    this.passenger = false;   // a passenger is aboard (latched once a `passenger` step finishes)
    // One-frame signals for the scene:
    this.justAlert     = false; // a step with `alert` just finished → converge the cops
    this.justPassenger = false; // a step with `passenger` just finished → weigh the car down
  }

  // Player dismissed the briefing → the chase begins (the scene spawns cops + pursuit.begin()).
  begin() {
    if (this.state === MissionState.BRIEFING) this.state = MissionState.ACTIVE;
  }

  get step() { return this.state === MissionState.ACTIVE ? this.steps[this.index] : null; }

  // Advance the machine. Called every frame once the chase is live.
  //   px,py : player position        busted : the bust meter just filled      dt : seconds
  //   ctx   : { active  — a cop has line of sight right now (pursuit ACTIVE),
  //             ditched — the cops have fully lost you (ditch cooldown expired),
  //             speed   — player speed, px/s }
  update(px, py, ctx, busted, dt) {
    this.justAlert = this.justPassenger = false;
    if (this.isOver) return this.state;
    if (busted) { this.state = MissionState.FAILED; return this.state; }
    const s = this.step;
    if (!s) return this.state;

    const ok = s.need === 'ditched' ? ctx.ditched && !ctx.active : !ctx.active;
    this._inCircle = this.reached(px, py, s.target);
    this._blocked  = this._inCircle && !ok;
    this._moving   = this._inCircle && ok && !!s.stop && ctx.speed > STOP_SPEED;
    // The dwell only accrues while every condition holds; anything else resets it.
    if (this._inCircle && ok && !this._moving) this._dwell += dt;
    else this._dwell = 0;

    if (this._inCircle && ok && !this._moving && this._dwell >= (s.dwell || 0)) {
      if (s.alert) this.justAlert = true;
      if (s.passenger) { this.passenger = true; this.justPassenger = true; }
      this.index++;
      this._dwell = 0;
      this._inCircle = this._blocked = this._moving = false;
      if (this.index >= this.steps.length) this.state = MissionState.COMPLETE;
    }
    return this.state;
  }

  reached(px, py, poi) {
    return !!poi && Math.hypot(px - poi.x, py - poi.y) <= poi.r;
  }

  // --- Display accessors the scene reads back ---
  get objectiveLabel() {
    const s = this.step;
    if (!s) return '';
    if (this._blocked) return s.blocked || s.label;
    if (this._moving) return `${s.target?.name ?? 'Here'} — stop the car`;
    if (this._inCircle && s.dwell) return `${s.hold || s.label}  ${Math.ceil(s.dwell - this._dwell)}s`;
    return s.label;
  }
  // What the HUD should say RIGHT NOW, or null when there's nothing to correct (just driving
  // there). { kicker, text, tone } — tone 'warn' = you're failing the condition.
  get hint() {
    const s = this.step;
    if (!s || !this._inCircle) return null;
    const place = (s.target?.name ?? 'Objective').toUpperCase();
    if (this._blocked)
      return { kicker: s.need === 'ditched' ? 'STILL HOT' : 'THEY CAN SEE YOU', text: s.blocked || s.label, tone: 'warn' };
    if (this._moving) return { kicker: place, text: 'Stop the car', tone: 'info' };
    if (s.dwell) return { kicker: place, text: (s.hold || s.label) + '  ' + Math.ceil(s.dwell - this._dwell), tone: 'info' };
    return null;
  }
  // The POI to guide the player to right now (null once the mission is over).
  get targetPoi() { return this.step ? this.step.target : null; }
  // 0..1 progress of the current step's dwell (drives the ring fill).
  get dwellFrac() {
    const s = this.step;
    return s && s.dwell ? Math.min(1, this._dwell / s.dwell) : 0;
  }
  get isOver() { return this.state === MissionState.COMPLETE || this.state === MissionState.FAILED; }
  get won()    { return this.state === MissionState.COMPLETE; }
  get reward() { return this.def.reward; }
}
