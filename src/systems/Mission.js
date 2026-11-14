import { poiById } from '../world/city.js';

// Mission runtime — the career game loop, kept as PURE LOGIC (no Phaser) so it's trivial to
// reason about and test. GameScene owns the visuals (briefing card, pointer, result screen) and
// the chase systems; each frame it feeds this machine a few facts and reads back what to show.
//
// A mission is an ordered list of STEPS. The default step is "get to a POI under a condition":
//   poi        id of the POI to reach (world/city.js POIS)
//   need       'unseen'  — no cop has eyes on you right now (pursuit not ACTIVE)
//              'ditched' — the cops have fully LOST you (the ditch cooldown ran out); being merely
//                          out of sight is not enough. The "can't lead them to it" condition.
//   dwell      seconds the condition must hold, uninterrupted, inside the POI circle (0 = on arrival)
//   stop       true → you must also be (nearly) stationary for the dwell to count (a pickup)
//   label      the objective, shown briefly when the step starts (`kicker` overrides "OBJECTIVE")
//   blocked    what to do instead, shown while you're in the circle but the condition fails
//   hold       what's happening, shown (with seconds left) while the dwell runs
// Two other step kinds:
//   kind 'approach'  finishes the moment you come within `within` px of the POI, seen or not. For
//                    scripted turns: get close, then something changes (the next step).
//   kind 'survive'   no POI — stay hunted for `duration` seconds. The clock only runs while the cops
//                    are still after you; if you ditch them it stops, and they get re-alerted.
// What finishing a step can trigger (any kind):
//   alert      true → your cover is blown: the scene converges the cops on you
//   passenger  true → a passenger is aboard (the scene weighs the car down)
//   swap       a vehicle id → you switch into the car waiting in that POI's garage (see
//              GameScene._startSwap). The step's POI must be a safehouse.
// Mission-level options:
//   start      where the run begins (world/city.js STARTS) — each job opens somewhere different
//   vehicle    a car the job REQUIRES. It's a loaner: you drive it for this job whether or not you
//              own it; owning it comes from the garage, with cash.
//   maxLevel   caps the pursuit level for the job (omit = the full 5-level curve)
//   opening    'cold' (default) — quiet streets: patrols cruise and have to notice you, so the job
//              needs a step with `alert` (or to be a deliberate stealth job) for a chase to happen.
//              'hot' — a cop is already on your tail when you roll out.
//   patrols    how many cruisers are on the streets around you while it is quiet (default 4)
//   notoriety  how much hotter (0..1) finishing the job makes the car you finish it in
//   limits     { speedCap, minHealth, reason } — in force once a passenger is aboard: top speed is
//              capped at speedCap px/s, and the job FAILS (with `reason`) if the car's health drops
//              below the minHealth fraction.
// The mission is COMPLETE when the last step finishes; FAILED on a bust or a broken limit.

export const MissionState = {
  BRIEFING: 'BRIEFING',
  ACTIVE:   'ACTIVE',
  COMPLETE: 'COMPLETE',
  FAILED:   'FAILED',
};

// Mission registry, in career order: finishing one unlocks the next (GameScene.missionUnlocked).
// The ids are save keys, not positions — Side Streets (m2) is the opening job because it is the
// gentlest; The Shakedown (m1) follows.
export const MISSIONS = [
  {
    id: 'm2',
    name: 'SIDE STREETS',
    job: 'Package Drop',
    summary: 'Collect a parcel uptown, then deliver it to a back-alley drop.',
    briefing:
      'Nobody is looking for you yet. There are patrols out — drive like you belong\n' +
      'and they will take their time placing you; tear past one and they will not.\n' +
      'Collect the parcel uptown. The seller is being watched, so once it is in the\n' +
      'car they will come for you. Then the one rule: you do NOT bring company to\n' +
      'the drop. Lose them completely, and only then roll up to the alley.',
    tip: 'TAB holds you to the speed limit — a patrol needs a long look at a clean car doing the limit',
    reward: 3500,
    maxLevel: 2,
    start: 'fin_south',
    steps: [
      { poi: 'parcel', need: 'unseen', dwell: 2, stop: true, alert: true,
        label: 'Collect the parcel — keep it quiet on the way',
        blocked: 'Not with a patrol on you',
        hold: 'Loading the parcel' },
      { poi: 'alley_drop', need: 'ditched', dwell: 2, stop: true,
        kicker: 'THEY KNOW',
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
      'A package is waiting out on the docks, clear across the bay. The streets are\n' +
      'quiet for now — get there without drawing a patrol, then sit on the Drop\n' +
      'until it is secure (if they are onto you, shake them first and stay clear of\n' +
      'their headlights). The moment you grab it they will know where\n' +
      'you are — lose them again and make the safehouse in the Neon Mile, all the way\n' +
      'back across town, to call it a night.',
    tip: 'cut your lights (Q) while you sit on the drop — a blacked-out car is only spotted up close',
    reward: 4500,
    maxLevel: 2,
    start: 'backstreets',
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
    start: 'docks',
    steps: [
      { poi: 'contact', need: 'unseen', dwell: 3, stop: true, alert: true, passenger: true,
        label: 'Reach the Contact in the Ironworks',
        blocked: 'They will not come out with cops watching',
        hold: 'Picking up the contact' },
      { poi: 'safe_backstreets', need: 'unseen', dwell: 0,
        label: 'Deliver the contact to the Backstreet Garage unseen',
        blocked: 'Break their line of sight first' },
    ],
  },
  {
    id: 'm4',
    name: 'HOT WHEELS',
    job: 'Repo',
    summary: 'A Razorback is waiting in a dockside garage. Take it and run.',
    briefing:
      'A client wants a car back. It is a Razorback, it is sitting in the Dockside\n' +
      'Garage, and its current owner is not going to hand over the keys. Get there\n' +
      'in the Prowler, slip inside without a tail and park up — you will know when\n' +
      'she is ready. The moment you roll out in her, everyone is looking for that\n' +
      'car. Bring her home to the Neon Mile.',
    tip: 'the Razorback is far quicker than the Prowler, and far easier to spin — and the cops know it on sight',
    reward: 7000,
    maxLevel: 3,
    start: 'industrial',
    vehicle: 'prowler',
    steps: [
      { poi: 'safe_docks', need: 'unseen', dwell: 1.5, stop: true, alert: true, swap: 'razorback',
        label: 'Reach the Dockside Garage unseen and park inside',
        blocked: 'Lose them before you go in',
        hold: 'Switching cars' },
      { poi: 'safe_neon', need: 'unseen', dwell: 0,
        kicker: 'NEW RIDE', label: 'Bring the Razorback to the Neon Mile Garage unseen',
        blocked: 'Break their line of sight first' },
    ],
  },
  {
    id: 'm5',
    name: 'GHOST STORY',
    job: 'Decoy Run',
    summary: 'Be the distraction. Stay hunted until the real job is done.',
    briefing:
      'Tonight you are not the getaway. You are the noise. Somebody else is doing\n' +
      'the real work across town and they need every cruiser in the city looking\n' +
      'the other way — at you. Do not lose them. Do not get caught. Keep them on\n' +
      'your tail until the clock runs out, and the clock only runs while they are\n' +
      'still hunting you.',
    tip: 'ditching them stops the clock — you want them close enough to chase, never close enough to pin',
    reward: 8000,
    maxLevel: 4,
    start: 'financial',
    opening: 'hot',
    steps: [
      { kind: 'survive', duration: 150,
        kicker: 'DECOY', label: 'Stay hunted for two and a half minutes' },
    ],
  },
  {
    id: 'm7',
    name: 'IRONCLAD',
    job: 'Bank Job',
    summary: 'The crew is out and the truck is loaded. Drive the Vault home.',
    briefing:
      'The vault door is open, the bags are in the back, and you are behind the\n' +
      'wheel of the heaviest thing on four wheels. The Vault will not outrun\n' +
      'anybody. It does not have to — nothing they have can stop it, only box it\n' +
      'in. Push through, shake them, and put it away in the Ironworks.',
    tip: 'the Vault is slow but shrugs off rams — do not let them surround you, and use the weight on roadblocks',
    reward: 7500,
    maxLevel: 3,
    start: 'financial',
    vehicle: 'vault',
    opening: 'hot',
    steps: [
      { poi: 'safe_industrial', need: 'unseen', dwell: 0,
        label: 'Get the Vault to the Ironworks Garage unseen',
        blocked: 'Break their line of sight first' },
    ],
  },
  {
    id: 'm9',
    name: 'DOUBLE CROSS',
    job: 'Package Drop',
    summary: 'A routine drop on the docks. It will not stay routine.',
    briefing:
      'Routine work: a package for the docks, a contact who has never been late,\n' +
      'and a fee that is a little too generous. Run it out to the Drop. Keep your\n' +
      'eyes open on the way in.',
    tip: 'plans change — keep some gadgets in hand for the second half',
    reward: 9000,
    maxLevel: 4,
    start: 'neon',
    steps: [
      { kind: 'approach', poi: 'drop', within: 1500, alert: true,
        label: 'Take the package to the Drop' },
      { poi: 'fallback_drop', need: 'ditched', dwell: 2, stop: true,
        kicker: 'IT IS A SETUP', label: 'The contact sold you out — lose them and make the Fallback Drop',
        blocked: 'Lose the cops completely',
        hold: 'Making the drop' },
    ],
  },
  {
    id: 'm10',
    name: 'BORROWED TIME',
    job: 'Extraction',
    summary: 'Your passenger is hurt. Drive like it.',
    briefing:
      'The job went wrong before you ever got the call. One of the crew is hurt,\n' +
      'holed up in the Backstreets, and needs a doctor who does not ask questions\n' +
      '— in the Ironworks. Pick them up. After that you drive like the car is made\n' +
      'of glass: nothing fast, nothing hard. Take too many hits and they will not\n' +
      'make it.',
    tip: 'with the patient aboard your top speed is cut and heavy damage ends the job — avoid contact, break line of sight',
    reward: 10000,
    maxLevel: 4,
    start: 'docks',
    limits: { speedCap: 430, minHealth: 0.35, reason: 'YOUR PASSENGER DID NOT MAKE IT' },
    steps: [
      { poi: 'patient', need: 'unseen', dwell: 3, stop: true, alert: true, passenger: true,
        label: 'Reach the Patient in the Backstreets',
        blocked: 'They cannot be moved with cops watching',
        hold: 'Getting them into the car' },
      { poi: 'safe_industrial', need: 'unseen', dwell: 0,
        kicker: 'DRIVE GENTLY', label: 'Get the patient to the Ironworks Garage unseen',
        blocked: 'Break their line of sight first' },
    ],
  },
];
export const missionById = (id) => MISSIONS.find((m) => m.id === id) || null;

const STOP_SPEED = 45;    // px/s — at or below this the car counts as stopped (for `stop` steps)
const REALERT_AFTER = 5;  // s a 'survive' step waits, once you've ditched them, before re-alerting

const clock = (secs) => {
  const s = Math.max(0, Math.ceil(secs));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

export class Mission {
  // `snap(poi)` lets the scene move an open-air POI onto a drivable road node; it must return a
  // (possibly new) { x, y, r, name } object and never mutate the shared POIS entry.
  constructor(def, snap = (p) => p) {
    this.def   = def;
    this.state = MissionState.BRIEFING;
    this.steps = def.steps.map((s) => ({ ...s, target: s.poi ? snap(poiById(s.poi)) : null }));
    this.index = 0;           // current step
    this._dwell    = 0;       // seconds the current step's condition has held
    this._inCircle = false;   // player inside the current POI radius this frame
    this._blocked  = false;   // inside the circle but the condition fails
    this._moving   = false;   // inside the circle, condition met, but a `stop` step and still rolling
    this._idle     = 0;       // 'survive': seconds since the cops lost you (drives the re-alert)
    this._paused   = false;   // 'survive': the clock is stopped because they've lost you
    this.passenger = false;   // a passenger is aboard (latched once a `passenger` step finishes)
    this.failReason = null;   // set when a limit fails the job (a bust leaves it null)
    // One-frame signals for the scene:
    this.justAlert     = false; // converge the cops on the player
    this.justPassenger = false; // a passenger just got in → weigh the car down
    this.justSwap      = null;  // a `swap` step just finished → { vehicle, poi } to switch into
  }

  // Player dismissed the briefing → the chase begins (the scene spawns cops + pursuit.begin()).
  begin() {
    if (this.state === MissionState.BRIEFING) this.state = MissionState.ACTIVE;
  }

  // Fail the job for a reason other than a bust (a broken limit).
  fail(reason) {
    if (this.isOver) return;
    this.failReason = reason || null;
    this.state = MissionState.FAILED;
  }

  get step() { return this.state === MissionState.ACTIVE ? this.steps[this.index] : null; }

  // Advance the machine. Called every frame once the chase is live.
  //   px,py : player position        busted : the bust meter just filled      dt : seconds
  //   ctx   : { active  — a cop has line of sight right now (pursuit ACTIVE),
  //             ditched — the cops have fully lost you (ditch cooldown expired),
  //             speed   — player speed, px/s }
  update(px, py, ctx, busted, dt) {
    this.justAlert = this.justPassenger = false;
    this.justSwap = null;
    if (this.isOver) return this.state;
    if (busted) { this.state = MissionState.FAILED; return this.state; }
    const s = this.step;
    if (!s) return this.state;

    let done = false;
    if (s.kind === 'survive') {
      // The clock runs while they're still after you (chasing or searching). Fully ditched → it
      // stops, and after a beat the cops are pointed back at you so the job can't stall.
      this._paused = ctx.ditched && !ctx.active;
      if (!this._paused) { this._dwell += dt; this._idle = 0; }
      else {
        this._idle += dt;
        if (this._idle >= REALERT_AFTER) { this._idle = 0; this.justAlert = true; }
      }
      done = this._dwell >= s.duration;
    } else if (s.kind === 'approach') {
      done = !!s.target && Math.hypot(px - s.target.x, py - s.target.y) <= (s.within || s.target.r);
    } else {
      const ok = s.need === 'ditched' ? ctx.ditched && !ctx.active : !ctx.active;
      this._inCircle = this.reached(px, py, s.target);
      this._blocked  = this._inCircle && !ok;
      this._moving   = this._inCircle && ok && !!s.stop && ctx.speed > STOP_SPEED;
      // The dwell only accrues while every condition holds; anything else resets it.
      if (this._inCircle && ok && !this._moving) this._dwell += dt;
      else this._dwell = 0;
      done = this._inCircle && ok && !this._moving && this._dwell >= (s.dwell || 0);
    }

    if (done) {
      if (s.alert) this.justAlert = true;
      if (s.passenger) { this.passenger = true; this.justPassenger = true; }
      if (s.swap) this.justSwap = { vehicle: s.swap, poi: s.target };
      this.index++;
      this._dwell = this._idle = 0;
      this._inCircle = this._blocked = this._moving = this._paused = false;
      if (this.index >= this.steps.length) this.state = MissionState.COMPLETE;
    }
    return this.state;
  }

  reached(px, py, poi) {
    return !!poi && Math.hypot(px - poi.x, py - poi.y) <= poi.r;
  }

  // --- Display accessors the scene reads back ---
  // What the HUD should say RIGHT NOW, or null when there's nothing to say (just driving there).
  // { kicker, text, tone } — tone 'warn' = you're failing the step's condition.
  get hint() {
    const s = this.step;
    if (!s) return null;
    if (s.kind === 'survive') {
      return this._paused
        ? { kicker: 'THEY LOST YOU', text: 'Get seen — the clock is stopped', tone: 'warn' }
        : { kicker: 'KEEP THEM ON YOU', text: clock(s.duration - this._dwell), tone: 'info' };
    }
    if (!this._inCircle) return null;
    const place = (s.target?.name ?? 'Objective').toUpperCase();
    if (this._blocked)
      return { kicker: s.need === 'ditched' ? 'STILL HOT' : 'THEY CAN SEE YOU', text: s.blocked || s.label, tone: 'warn' };
    if (this._moving) return { kicker: place, text: 'Stop the car', tone: 'info' };
    if (s.dwell) return { kicker: place, text: (s.hold || s.label) + '  ' + Math.ceil(s.dwell - this._dwell), tone: 'info' };
    return null;
  }
  // The POI to guide the player to right now (null for a 'survive' step and once it's over).
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
