// Pursuit state machine — the heart of the ditch mechanic.
//
//   ACTIVE    : at least one cop has line of sight. Cops chase the player's real
//               position; last-known position is continuously updated.
//   SEARCH    : no cop can see the player. Cops converge on the last-known
//               position and sweep outward. Two phases, tracked by `ditched`:
//                 • pre-ditch  — cooldown timer counts down; if it expires with
//                   no re-sighting, the player has ditched (you're "safe").
//                 • post-ditch — the area stays HOT: cops keep searching for
//                   `hotDuration` so you can't immediately return.
//   RETURNING : the heat has cooled. Cops withdraw to the station.
//   IDLE      : cops parked at the station. Area fully clear.
//
// Re-acquiring sight in any non-active state snaps back to ACTIVE and recharges
// every timer.
export const PursuitState = {
  IDLE:      'IDLE',
  ACTIVE:    'ACTIVE',
  SEARCH:    'SEARCH',
  RETURNING: 'RETURNING',
};

export class Pursuit {
  constructor(cooldownDuration = 10, hotDuration = 15) {
    this.state            = PursuitState.IDLE;
    this.cooldownDuration = cooldownDuration; // seconds out of sight to ditch
    this.hotDuration      = hotDuration;      // seconds the area stays hot after a ditch
    this.huntDuration     = 10; // seconds after losing sight that cops still CHARGE
                                // the predicted position before downshifting to a slow search
    this.cooldown         = 0;
    this.hot              = 0;
    this.ditched          = false; // true once the cooldown has elapsed (area still hot)
    this.hunting          = false; // true during the hunt window (recently lost sight)
    this.lastKnown        = { x: 0, y: 0 };
    this.lastKnownDir     = 0;   // player's travel direction when last seen (radians)
    this.lastKnownSpeed   = 300; // player's speed when last seen (px/s)
    this.hasLastKnown     = false;
    this.justDitched      = false; // true for the single frame the ditch completes
  }

  // Kick off a chase already in progress ("cops already coming").
  begin(px, py) {
    this.state        = PursuitState.ACTIVE;
    this.lastKnown.x  = px;
    this.lastKnown.y  = py;
    this.hasLastKnown = true;
    this.cooldown     = this.cooldownDuration;
    this.hot          = this.hotDuration;
    this.ditched      = false;
  }

  update(anyLOS, px, py, dt) {
    this.justDitched = false;

    if (anyLOS) {
      // Seen — full pursuit. Remember position, recharge everything.
      this.state        = PursuitState.ACTIVE;
      this.lastKnown.x  = px;
      this.lastKnown.y  = py;
      this.hasLastKnown = true;
      this.cooldown     = this.cooldownDuration;
      this.hot          = this.hotDuration;
      this.ditched      = false;
      this.hunting      = false;
      return this.state;
    }

    switch (this.state) {
      case PursuitState.ACTIVE:
        this.state = PursuitState.SEARCH; // just lost sight
        // fall through into SEARCH handling this frame
      case PursuitState.SEARCH:
        if (!this.ditched) {
          this.cooldown -= dt;
          if (this.cooldown <= 0) {
            this.cooldown    = 0;
            this.ditched     = true;
            this.justDitched = true;
          }
        } else {
          this.hot -= dt;
          if (this.hot <= 0) {
            this.hot   = 0;
            this.state = PursuitState.RETURNING;
          }
        }
        break;
      // RETURNING / IDLE: no timers — the scene drives cops to the station and
      // calls markIdle() once they've all arrived.
    }

    // HUNT window: recently lost sight (pre-ditch, within huntDuration) — cops
    // still charge the predicted position at full speed before downshifting.
    this.hunting = this.state === PursuitState.SEARCH && !this.ditched &&
                   (this.cooldownDuration - this.cooldown) < this.huntDuration;

    return this.state;
  }

  markIdle() {
    if (this.state === PursuitState.RETURNING) this.state = PursuitState.IDLE;
  }
}
