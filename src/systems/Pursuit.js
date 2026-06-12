// Pursuit state machine — the heart of the ditch mechanic.
//
//   ACTIVE   : at least one cop has line of sight. Cops chase the player's real
//              position; last-known position is continuously updated.
//   COOLDOWN : no cop can see the player. Cops converge on the last-known
//              position. A timer counts down; if it expires with no re-sighting,
//              the player has ditched.
//   DITCHED  : cooldown elapsed. Cops stand down.
//
// Re-acquiring sight at any point snaps back to ACTIVE and refills the timer.
export const PursuitState = {
  IDLE:     'IDLE',
  ACTIVE:   'ACTIVE',
  COOLDOWN: 'COOLDOWN',
  DITCHED:  'DITCHED',
};

export class Pursuit {
  constructor(cooldownDuration = 8) {
    this.state            = PursuitState.IDLE;
    this.cooldownDuration = cooldownDuration; // seconds
    this.cooldown         = 0;
    this.lastKnown        = { x: 0, y: 0 };
    this.hasLastKnown     = false;
    this.justDitched      = false; // true for the single frame the ditch completes
  }

  update(anyLOS, px, py, dt) {
    this.justDitched = false;

    if (anyLOS) {
      // Seen — full pursuit, remember where they are, keep the timer charged.
      this.state        = PursuitState.ACTIVE;
      this.lastKnown.x  = px;
      this.lastKnown.y  = py;
      this.hasLastKnown = true;
      this.cooldown     = this.cooldownDuration;
    } else if (this.state === PursuitState.ACTIVE || this.state === PursuitState.COOLDOWN) {
      // Lost sight — run down the cooldown.
      if (this.state === PursuitState.ACTIVE) this.state = PursuitState.COOLDOWN;
      this.cooldown -= dt;
      if (this.cooldown <= 0) {
        this.cooldown    = 0;
        this.state       = PursuitState.DITCHED;
        this.justDitched = true;
      }
    }

    return this.state;
  }
}
