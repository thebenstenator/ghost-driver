import { poiById } from '../world/city.js';

// Mission runtime — the Phase 3 game loop, kept as PURE LOGIC (no Phaser) so it's trivial to
// reason about and test. GameScene owns the visuals (briefing card, beacon, result screen) and
// the chase systems; each frame it feeds this machine a few facts and reads back what to show.
//
// Mission 1 shape (two legs, with a stealth gate):
//   BRIEFING                                          — card up, chase not yet begun
//   GOTO_DROP   reach the Drop AND lie low (no cop    — must SHAKE the active chase first: the
//               LOS) for dropDwell seconds              dwell only counts while NOT in ACTIVE
//                                                        pursuit, and resets if you leave the
//                                                        circle or a cop re-acquires you
//   → on secure: the scene ALERTS the cops to the drop (re-aggro) — justSecuredDrop fires once
//   TO_SAFEHOUSE reach the Safehouse AND be ditched    — lose them again, then make the safehouse
//   COMPLETE / FAILED

export const MissionState = {
  BRIEFING:     'BRIEFING',
  GOTO_DROP:    'GOTO_DROP',
  TO_SAFEHOUSE: 'TO_SAFEHOUSE',
  COMPLETE:     'COMPLETE',
  FAILED:       'FAILED',
};

// Mission registry. v1 = one mission; add defs here, don't hardcode in the scene.
export const MISSIONS = [
  {
    id: 'm1',
    name: 'THE SHAKEDOWN',
    briefing:
      'A package is waiting across town — but the heat is already on your tail.\n' +
      'Shake them, then sit on the Drop until it is secure (stay clear of their\n' +
      'headlights). The moment you grab it they will know where you are — lose\n' +
      'them again and make the Safehouse to call it a night.',
    dropPoiId: 'drop',
    safehousePoiId: 'safehouse',
    dropDwell: 5, // seconds you must hold the Drop, uninterrupted and unseen, to secure it
    reward: 2500,
  },
];
export const missionById = (id) => MISSIONS.find((m) => m.id === id) || null;

export class Mission {
  constructor(def) {
    this.def       = def;
    this.state     = MissionState.BRIEFING;
    this.drop      = poiById(def.dropPoiId);
    this.safe      = poiById(def.safehousePoiId);
    this.dropDwell = def.dropDwell;
    this._dwell    = 0;       // seconds held on the drop so far (unseen)
    this._inCircle = false;   // player inside the drop radius this frame
    this._blocked  = false;   // inside the circle BUT a cop has LOS (dwell can't progress)
    this.justSecuredDrop = false; // one-frame signal: drop just secured → scene alerts cops
  }

  // Player dismissed the briefing → the chase begins (the scene spawns cops + pursuit.begin()).
  begin() {
    if (this.state === MissionState.BRIEFING) this.state = MissionState.GOTO_DROP;
  }

  // Advance the machine. Called every frame once the chase is live.
  //   px,py   : player position
  //   active  : a cop currently has line of sight (pursuit ACTIVE) — blocks the drop dwell AND the
  //             safehouse. You don't have to wait out the ditch cooldown: reaching the Safehouse
  //             (a garage that breaks sight) while NOT actively seen ends the mission right there.
  //   busted  : the bust meter just filled.
  //   dt      : seconds since last frame.
  update(px, py, active, busted, dt) {
    this.justSecuredDrop = false;
    if (this.isOver) return this.state;
    if (busted) { this.state = MissionState.FAILED; return this.state; }

    if (this.state === MissionState.GOTO_DROP) {
      this._inCircle = this.reached(px, py, this.drop);
      this._blocked  = this._inCircle && active;
      // Dwell only accrues while parked on the drop AND unseen; anything else resets it.
      if (this._inCircle && !active) this._dwell += dt;
      else this._dwell = 0;
      if (this._dwell >= this.dropDwell) {
        this.state = MissionState.TO_SAFEHOUSE;
        this.justSecuredDrop = true; // scene re-aggros the cops to the drop
      }
    } else if (this.state === MissionState.TO_SAFEHOUSE) {
      // Reach the safehouse UNSEEN → done. No cooldown wait: pulling into the garage while no cop has
      // eyes on you IS the escape (the garage breaks any remaining sight).
      if (this.reached(px, py, this.safe) && !active) this.state = MissionState.COMPLETE;
    }
    return this.state;
  }

  reached(px, py, poi) {
    return poi && Math.hypot(px - poi.x, py - poi.y) <= poi.r;
  }

  // --- Display accessors the scene reads back ---
  get objectiveLabel() {
    switch (this.state) {
      case MissionState.GOTO_DROP:
        if (this._blocked) return `${this.drop.name} — shake them first!`;
        if (this._inCircle) {
          return `Securing ${this.drop.name}…  ${Math.ceil(this.dropDwell - this._dwell)}s`;
        }
        return `Reach ${this.drop.name} and lie low`;
      case MissionState.TO_SAFEHOUSE:
        return `Reach ${this.safe.name} unseen`;
      default:
        return '';
    }
  }
  // The POI to guide the player to right now (null once the mission is over).
  get targetPoi() {
    if (this.state === MissionState.GOTO_DROP)    return this.drop;
    if (this.state === MissionState.TO_SAFEHOUSE) return this.safe;
    return null;
  }
  // 0..1 progress of the drop dwell (drives the ring fill); 0 outside GOTO_DROP.
  get dwellFrac() {
    return this.state === MissionState.GOTO_DROP
      ? Math.min(1, this._dwell / this.dropDwell)
      : 0;
  }
  get isOver() { return this.state === MissionState.COMPLETE || this.state === MissionState.FAILED; }
  get won()    { return this.state === MissionState.COMPLETE; }
  get reward() { return this.def.reward; }
}
