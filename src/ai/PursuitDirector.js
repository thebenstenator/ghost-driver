import Phaser from 'phaser';

// Roles a cop can be assigned during an active chase.
export const CopRole = {
  CHASE:       'CHASE',     // tail the player's actual position
  FLANK_LEFT:  'FLANK_L',   // ride the player's left rear quarter (PIT prep / box)
  FLANK_RIGHT: 'FLANK_R',   // ride the player's right rear quarter (PIT prep / box)
  INTERCEPT:   'INTERCEPT', // RESERVED for a future dedicated Interceptor unit (heat 3+)
                            // that spawns ahead and predicts the path. Base cops don't use it.
};

// PursuitDirector — the coordination brain for an active chase.
//
// Instead of every cop independently pathing to the same point (which funnels
// them into one intersection and tangles them), the Director hands each cop a
// distinct ROLE and a target derived from it. Cops spread into a formation
// around the player; one can race ahead to intercept. Roles are assigned on a
// cadence (sticky) by globally-greedy matching to whichever cop is best placed,
// so heading flips and re-spawns don't make them cross paths.
//
// This is the home for all chase coordination — flanking, interception, boxing,
// and (later) pursuit-level scaling: a level just changes the cop count and the
// formation returned by _formation().
export class PursuitDirector {
  constructor(navGrid) {
    this.nav = navGrid;
    this.reassignInterval = 0.6; // seconds between role re-matches (sticky in between)
    this.flankDist     = 46;     // px to the side for flankers — ~a car width, riding
                                 // alongside on the SAME road (PIT prep), not a block over
    this.boxSpeed      = 170;    // player speed below which flankers swing ahead to box you in
    this.boxAhead      = 95;     // px ahead a flanker cuts to when boxing (you've slowed/crashed)
    this.interceptLead = 1.3;    // [reserved] for the future Interceptor unit
    this.interceptMin  = 250;    // [reserved]
    this._timer = 0;
  }

  // Call once per frame during ACTIVE pursuit. Sets cop.role (sticky) and
  // cop.dirTarget (recomputed each frame as the player moves).
  update(cops, playerCar, dt) {
    this._timer -= dt;
    if (this._timer <= 0 || cops.some(c => !c.role)) {
      this._assignRoles(cops, playerCar);
      this._timer = this.reassignInterval;
    }
    for (const cop of cops) cop.dirTarget = this._roleTarget(cop.role, playerCar);
  }

  // Player travel direction — velocity when moving, facing when ~stationary.
  _heading(playerCar) {
    return playerCar.getSpeed() > 40
      ? Math.atan2(playerCar.vy, playerCar.vx)
      : playerCar.facing;
  }

  // Which roles to field for a given cop count. Base cops are CHASE + FLANKERS;
  // every cop stays involved (tailing / riding a flank / boxing). Interception is
  // a future dedicated unit, not part of the base formation. (Pursuit level will
  // drive this later.)
  _formation(n) {
    if (n <= 1) return [CopRole.CHASE];
    if (n === 2) return [CopRole.CHASE, CopRole.FLANK_LEFT];
    const roles = [CopRole.CHASE, CopRole.FLANK_LEFT, CopRole.FLANK_RIGHT];
    while (roles.length < n) roles.push(roles.length % 2 ? CopRole.FLANK_LEFT : CopRole.FLANK_RIGHT);
    return roles.slice(0, n);
  }

  // Globally-greedy assignment: repeatedly take the closest (cop, slot) pair.
  // Minimises total travel and avoids crossing — the cop physically on the left
  // gets the left slot, etc., regardless of which way the player is facing.
  _assignRoles(cops, playerCar) {
    const roles = this._formation(cops.length);
    const slotPts = roles.map(r => this._roleTarget(r, playerCar));
    const pairs = [];
    for (let s = 0; s < roles.length; s++) {
      for (let c = 0; c < cops.length; c++) {
        pairs.push({ s, c, d: Phaser.Math.Distance.Between(
          cops[c].sprite.x, cops[c].sprite.y, slotPts[s].x, slotPts[s].y) });
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    const slotTaken = new Set(), copTaken = new Set();
    for (const p of pairs) {
      if (slotTaken.has(p.s) || copTaken.has(p.c)) continue;
      cops[p.c].role = roles[p.s];
      slotTaken.add(p.s); copTaken.add(p.c);
    }
  }

  // The world-space target for a role, given the player's current state.
  _roleTarget(role, playerCar) {
    const px = playerCar.sprite.x, py = playerCar.sprite.y;
    const h  = this._heading(playerCar);
    switch (role) {
      case CopRole.FLANK_LEFT:  return this._flankTarget(playerCar, px, py, h, -1);
      case CopRole.FLANK_RIGHT: return this._flankTarget(playerCar, px, py, h, +1);
      case CopRole.INTERCEPT: { // reserved (future Interceptor unit)
        const lead = Math.max(this.interceptMin, playerCar.getSpeed() * this.interceptLead);
        const node = this.nav.nearestNode(px + Math.cos(h) * lead, py + Math.sin(h) * lead);
        return this.nav.pos(node);
      }
      default: // CHASE
        return { x: px, y: py };
    }
  }

  // A flanker rides a car-width off the player's side on the SAME road (PIT prep).
  // As the player slows (or crashes), it swings AHEAD and closes in to box them —
  // which sets up the player's counter: brake hard and let it overshoot.
  _flankTarget(playerCar, px, py, h, sgn) {
    const box   = Phaser.Math.Clamp((this.boxSpeed - playerCar.getSpeed()) / this.boxSpeed, 0, 1);
    const along = box * this.boxAhead;            // 0 while fleeing → ahead of you when slow
    const side  = this.flankDist * (1 - 0.4 * box); // tuck in a little while boxing
    const perp  = h + sgn * Math.PI / 2;
    return {
      x: px + Math.cos(h) * along + Math.cos(perp) * side,
      y: py + Math.sin(h) * along + Math.sin(perp) * side,
    };
  }
}
