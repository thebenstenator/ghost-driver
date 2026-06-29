import { poiById } from '../world/city.js';

// Mission runtime — the Phase 3 game loop, kept as PURE LOGIC (no Phaser) so it's trivial to
// reason about and test. GameScene owns all the visuals (briefing card, beacon, result screen)
// and the chase systems; each frame it feeds this machine the few facts it needs and reads back
// what to show. The loop is deliberately thin — it sits on signals that already exist:
//   • drop-in chase   → GameScene calls pursuit.begin() when BRIEFING is dismissed
//   • objective       → reach a named POI (Mission.reached)
//   • win             → pursuit.justDitched AFTER the drop is reached
//   • lose            → bust.isBusted
//
// First mission shape: drop in mid-chase → reach the Drop → lose the cops → COMPLETE + reward.

export const MissionState = {
  BRIEFING:  'BRIEFING',  // pre-chase: briefing card up, cops not yet dispatched
  GOTO_DROP: 'GOTO_DROP', // objective: reach the drop POI
  ESCAPE:    'ESCAPE',    // drop reached; objective: lose the cops (ditch)
  COMPLETE:  'COMPLETE',  // won — reward banked
  FAILED:    'FAILED',    // busted
};

// Mission registry. v1 = one mission; add defs here, don't hardcode in the scene.
export const MISSIONS = [
  {
    id: 'm1',
    name: 'THE SHAKEDOWN',
    briefing:
      'A package is waiting across town and the heat is already on your tail.\n' +
      'Reach the Drop, then lose them in the streets. Get caught and the night is over.',
    dropPoiId: 'drop',
    reward: 2500,
  },
];
export const missionById = (id) => MISSIONS.find((m) => m.id === id) || null;

export class Mission {
  constructor(def) {
    this.def    = def;
    this.state  = MissionState.BRIEFING;
    this.drop   = poiById(def.dropPoiId); // { id, name, x, y, r }
  }

  // Player dismissed the briefing → the chase begins (the scene spawns cops + pursuit.begin()).
  begin() {
    if (this.state === MissionState.BRIEFING) this.state = MissionState.GOTO_DROP;
  }

  // Advance the machine. Called every frame once the chase is live.
  //   px,py   : player position
  //   ditched : pursuit is currently in the ditched (escaped/safe) STATE — not the one-frame event.
  //             Using the state (not the event) means a player who loses the cops BEFORE reaching
  //             the drop, then arrives while still safe, completes on arrival instead of soft-locking
  //             in ESCAPE waiting for a fresh ditch that the now-withdrawn cops can never trigger.
  //   busted  : the bust meter just filled
  update(px, py, ditched, busted) {
    if (this.isOver) return this.state;
    if (busted) { this.state = MissionState.FAILED; return this.state; }

    if (this.state === MissionState.GOTO_DROP) {
      if (this.drop && this.reached(px, py)) this.state = MissionState.ESCAPE;
    }
    // Not else-if: arriving safe should complete the same frame it flips to ESCAPE.
    if (this.state === MissionState.ESCAPE && ditched) {
      this.state = MissionState.COMPLETE;
    }
    return this.state;
  }

  reached(px, py) {
    const d = this.drop;
    return Math.hypot(px - d.x, py - d.y) <= d.r;
  }

  // --- Display accessors the scene reads back ---
  get objectiveLabel() {
    switch (this.state) {
      case MissionState.GOTO_DROP: return `Reach ${this.drop ? this.drop.name : 'the Drop'}`;
      case MissionState.ESCAPE:    return 'Lose the cops';
      default:                     return '';
    }
  }
  // The POI to guide the player to right now (null once it's reached / mission over).
  get targetPoi() {
    return this.state === MissionState.GOTO_DROP ? this.drop : null;
  }
  get isOver() {
    return this.state === MissionState.COMPLETE || this.state === MissionState.FAILED;
  }
  get won() {
    return this.state === MissionState.COMPLETE;
  }
  get reward() {
    return this.def.reward;
  }
}
