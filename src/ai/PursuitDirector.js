import Phaser from 'phaser';
import { segmentClear } from './lineOfSight.js';

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
  constructor(navGrid, rects = null) {
    this.nav   = navGrid;
    this.rects = rects;          // building footprints — for target validation + convoy LOS
    this.reassignInterval = 0.6; // seconds between role re-matches (sticky in between)
    this.flankDist     = 46;     // px to the side for flankers — ~a car width, riding
                                 // alongside on the SAME road (PIT prep), not a block over
    this.boxSpeed      = 170;    // player speed below which flankers swing ahead to box you in
    this.boxAhead      = 95;     // px ahead a flanker cuts to when boxing (you've slowed/crashed)
    this.frontZone     = 40;     // px ahead of the player past which a flanker counts as "in front"
                                 // (it then rams head-on instead of swerving in front of you)
    this.boxBehind     = 80;     // px behind the player a 2nd flanker tucks to when another is in front
    this.engageRange   = 420;    // px — RAM/BOX only engage within this range of the player. A cop
                                 // "ramming" from across the map was nonsense; beyond it it catches up.
    this.interceptLead = 1.3;    // [reserved] for the future Interceptor unit
    this.interceptMin  = 250;    // [reserved]
    // --- Convoy relay (visibility chain) ---
    // A blind cop that can see a teammate who has a route to the player follows that
    // teammate's breadcrumb trail instead of pathing on its own (which diverged into
    // walls / dead alleys). See _assignConvoy / _convoyTarget.
    this.convoyEnabled   = true;
    this.followGap       = 90;   // px behind the leader a follower aims (no tailgating)
    this.convoyMaxHops   = 2;    // max relay length; longer chains fall back to own route
    this.convoyMaxFactor = 1.6;  // if the chain route is > this × straight-line dist, go direct
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
    // Flankers coordinate, so resolve them with knowledge of each other: if one is
    // already in front of the player, the other(s) box in behind instead of also
    // fighting for the front.
    const px = playerCar.sprite.x, py = playerCar.sprite.y;
    const h  = this._heading(playerCar);
    const isFlank = (c) => c.role === CopRole.FLANK_LEFT || c.role === CopRole.FLANK_RIGHT;
    // A flanker only counts as "in front" (so teammates box behind) if it is BOTH
    // nosed ahead AND close enough to matter — a far cop isn't boxing anyone.
    const anyFront = cops.some(c => isFlank(c) &&
      this._along(c, px, py, h) > this.frontZone &&
      this._dist(c, px, py) <= this.engageRange);

    // Visibility-chain roles (DIRECT / CONVOY / LONE) — computed before targets so a
    // CONVOY cop can override its role target with the leader's trail.
    this._assignConvoy(cops, px, py);

    for (const cop of cops) {
      // Base (role) target — what the cop does once it can act on the player.
      let target;
      if (isFlank(cop)) {
        const sgn = cop.role === CopRole.FLANK_LEFT ? -1 : +1;
        target = this._flankTarget(cop, playerCar, px, py, h, sgn, anyFront);
      } else {
        cop.flankCase = null;
        target = this._clearTarget(px, py, this._roleTarget(cop.role, playerCar));
      }
      // CONVOY override: a blind cop relays toward a teammate that can see the player,
      // following its drivable breadcrumb trail rather than pathing on its own.
      if (cop.pursuitMode === 'CONVOY' && cop.convoyLeader) {
        const ct = this._convoyTarget(cop, cop.convoyLeader);
        if (ct) target = ct; else cop.pursuitMode = 'LONE';
      }
      cop.dirTarget = target;
    }
  }

  // Straight-line distance from a cop to a point.
  _dist(cop, x, y) { return Phaser.Math.Distance.Between(cop.sprite.x, cop.sprite.y, x, y); }

  // Clear line of sight between two cops (no building between them).
  _copsSee(a, b) {
    return !this.rects || segmentClear(a.sprite.x, a.sprite.y, b.sprite.x, b.sprite.y, this.rects);
  }

  // Build the line-of-sight chain to the player and tag each cop:
  //   DIRECT — sees the player itself → chase / flank normally
  //   CONVOY — blind, but sees a teammate that has a route to the player → follow it
  //   LONE   — blind with no visible relay → solve its own road route (fallback)
  // Shortest-cost relay via a tiny Bellman-Ford over the cop graph (n is ≤ a handful).
  _assignConvoy(cops, px, py) {
    const n = cops.length;
    if (!this.convoyEnabled || !this.rects || n === 0) {
      for (const c of cops) { c.pursuitMode = c.hasLOS ? 'DIRECT' : 'LONE'; c.convoyLeader = null; }
      return;
    }
    const cost   = new Array(n).fill(Infinity);
    const hops   = new Array(n).fill(0);
    const leader = new Array(n).fill(-1); // -1 unset · -2 player · >=0 cop index
    for (let i = 0; i < n; i++) {
      if (cops[i].hasLOS) { cost[i] = this._dist(cops[i], px, py); leader[i] = -2; hops[i] = 1; }
    }
    for (let pass = 0; pass < n; pass++) {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j || cost[j] === Infinity || hops[j] >= this.convoyMaxHops) continue;
          if (!this._copsSee(cops[i], cops[j])) continue;
          const c = cost[j] + this._dist(cops[i], cops[j].sprite.x, cops[j].sprite.y);
          if (c < cost[i]) { cost[i] = c; leader[i] = j; hops[i] = hops[j] + 1; }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const cop = cops[i];
      if (leader[i] === -2) { cop.pursuitMode = 'DIRECT'; cop.convoyLeader = null; }
      else if (leader[i] >= 0 && cost[i] <= this._dist(cop, px, py) * this.convoyMaxFactor) {
        cop.pursuitMode = 'CONVOY'; cop.convoyLeader = cops[leader[i]];
      } else { cop.pursuitMode = 'LONE'; cop.convoyLeader = null; }
    }
  }

  // Follow a leader's breadcrumb trail: aim at the furthest-along point (toward the
  // leader, a followGap short of it) that this cop can see in a straight line. Every
  // trail point was physically driven by the leader, so the route is always drivable
  // — no BFS divergence, no wall-grind. Returns null if nothing visible (caller falls
  // back to its own route).
  _convoyTarget(cop, leader) {
    const trail = leader._trail;
    if (!trail || trail.length < 2) return null;
    const head = trail[trail.length - 1];
    for (let k = trail.length - 1; k >= 0; k--) {
      const p = trail[k];
      if (Phaser.Math.Distance.Between(p.x, p.y, head.x, head.y) < this.followGap) continue;
      if (segmentClear(cop.sprite.x, cop.sprite.y, p.x, p.y, this.rects)) return { x: p.x, y: p.y };
    }
    return null;
  }

  // Pull a target in toward the player until the line player→target clears all
  // buildings, so flank/box points never sit inside or behind a wall (the cop would
  // otherwise grind the wall trying to reach an unreachable spot).
  _clearTarget(px, py, t) {
    if (!this.rects || segmentClear(px, py, t.x, t.y, this.rects)) return t;
    for (const f of [0.66, 0.33]) {
      const c = { x: px + (t.x - px) * f, y: py + (t.y - py) * f };
      if (segmentClear(px, py, c.x, c.y, this.rects)) return c;
    }
    return { x: px, y: py };
  }

  // How far ahead(+) / behind(-) a cop is along the player's heading.
  _along(cop, px, py, h) {
    return (cop.sprite.x - px) * Math.cos(h) + (cop.sprite.y - py) * Math.sin(h);
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

  // Ideal world-space target for a role (used for role ASSIGNMENT matching, and as
  // the live target for non-flank roles). Flankers' live targets are resolved in
  // update() via _flankTarget so they can coordinate; here flank just returns the
  // simple full side slot for matching.
  _roleTarget(role, playerCar) {
    const px = playerCar.sprite.x, py = playerCar.sprite.y;
    const h  = this._heading(playerCar);
    switch (role) {
      case CopRole.FLANK_LEFT:  { const p = h - Math.PI / 2; return { x: px + Math.cos(p) * this.flankDist, y: py + Math.sin(p) * this.flankDist }; }
      case CopRole.FLANK_RIGHT: { const p = h + Math.PI / 2; return { x: px + Math.cos(p) * this.flankDist, y: py + Math.sin(p) * this.flankDist }; }
      case CopRole.INTERCEPT: { // reserved (future Interceptor unit)
        const lead = Math.max(this.interceptMin, playerCar.getSpeed() * this.interceptLead);
        const node = this.nav.nearestNode(px + Math.cos(h) * lead, py + Math.sin(h) * lead);
        return this.nav.pos(node);
      }
      default: // CHASE
        return { x: px, y: py };
    }
  }

  // A flanker's live target. Three position-based cases:
  //   • IN FRONT (nosed ahead past frontZone): RAM straight at the player head-on
  //     instead of swerving to get in front of them (that swerve hit walls).
  //   • ANOTHER flanker already in front: BOX IN BEHIND — tuck to a rear-quarter
  //     spot so the pack sandwiches the player front-and-back instead of both
  //     fighting for the front.
  //   • Otherwise: ride the side, with the offset ramping in by how far forward the
  //     cop is (catch up behind first, slide out only once alongside), and swinging
  //     ahead to box when the player slows.
  _flankTarget(cop, playerCar, px, py, h, sgn, anyFront) {
    const rel  = this._along(cop, px, py, h);
    const perp = h + sgn * Math.PI / 2;
    const near = this._dist(cop, px, py) <= this.engageRange;

    // In front AND close → head-on ram.
    if (near && rel > this.frontZone) { cop.flankCase = 'RAM'; return { x: px, y: py }; }

    // A teammate holds the front AND we're close → box in behind (rear quarter, our side).
    if (near && anyFront) {
      cop.flankCase = 'BOX';
      return this._clearTarget(px, py, {
        x: px - Math.cos(h) * this.boxBehind + Math.cos(perp) * this.flankDist,
        y: py - Math.sin(h) * this.boxBehind + Math.sin(perp) * this.flankDist,
      });
    }

    // Otherwise: side flank with catch-up ramp + boxing-ahead when the player slows.
    const box   = Phaser.Math.Clamp((this.boxSpeed - playerCar.getSpeed()) / this.boxSpeed, 0, 1);
    const along = box * this.boxAhead;
    const flankFrac = Phaser.Math.Clamp((rel + this.flankDist) / (2 * this.flankDist), 0, 1);
    const side  = this.flankDist * flankFrac * (1 - 0.4 * box);
    cop.flankCase = flankFrac < 0.6 ? 'CATCHUP' : 'SIDE';
    return this._clearTarget(px, py, {
      x: px + Math.cos(h) * along + Math.cos(perp) * side,
      y: py + Math.sin(h) * along + Math.sin(perp) * side,
    });
  }
}
