import Phaser from 'phaser';
import { segmentClear } from './lineOfSight.js';

// Cop driving controller — robust waypoint following, no pure-pursuit carrot.
//
//  • If the cop has a clear line to its target, it drives STRAIGHT at it (chases
//    you whenever it can see you, at any distance).
//  • Otherwise it follows the BFS road path one intersection at a time: steer at
//    the next node, and only advance to the node after it once this one is
//    reached. Adjacent nodes are joined by clear roads, so the cop can never aim
//    diagonally through a building — which is what caused the wall-crashes and
//    missed turns. Turns happen AT intersections (open centre), not cut across.
//  • Speed: look-ahead braking over the path's real corner angles/distances,
//    capped per pursuit state. Accelerate or brake toward it.
//
// Cops run a high minSteerFactor (kinematic-ish grip), so steering never dies at
// low speed. A small failsafe reverses out of a genuine physics wedge.
export class CopAI {
  constructor(navGrid, rects = null, overrides = null) {
    this.nav   = navGrid;
    this.rects = rects;

    // --- Tunables ---
    // Defaults below are the baseline "patrol" brain. A unit type can override any of
    // them via its def's `ai` block (applied at the end of this block, before the
    // internal path/aim state is set up so that state is never clobbered).
    this.steerDeadzone    = 0.05;
    this.directRange      = 60;  // within this, aim straight at the target even if blocked. Kept
                                 // small (true point-blank) — a larger zone drove cops into walls
                                 // when a building corner sat between them and a close target.
    this.chaseRange       = 550; // BEELINE at the target only within this range (with clear
                                 // sight). Beyond it the cop follows the roads even with a
                                 // clear line — so a far cop corners at intersections instead
                                 // of tracking you straight across a corner into a building.
    this.arriveRadius     = 70;  // px to count a path node as reached
    this.cornerReach      = 120; // px past the current node the cornering curve aims toward the next
                                 // node — rounds the corner LOCALLY (≈ one road-width) instead of
                                 // slicing toward the next node and cutting the inside building.
    this.huntContinueRange = 550;// px — a CLOSE cop (within this) that loses sight of a now-FROZEN
                                 // last-known aims its racing line straight at that point (around
                                 // the corner) instead of detouring to the intersection-centre node
                                 // — worst on wide roads, where the centre is far off your line.
                                 // DISTANT cops, or any MOVING target (multi-cop shared last-known
                                 // tracking the live player), keep the safe node pathing — never
                                 // beeline at a moving guess around a corner (the wall-grind).
    this.maxApproachSpeed = 610; // speed on a straight (physics caps lower)
    this.baseApproach     = 610; // catch-up rubber-band raises maxApproachSpeed above this when far
    this.cornerMinSpeed   = 240; // speed through a 90°+ corner. The old 395 took 90° turns through
                                 // 128px streets near full speed and clipped the building corner —
                                 // the dominant source of wall-grind. Slow down so corners stay clean.
    this.brakeDecel       = 320; // assumed braking power for the slow-down curve
    this.speedMargin      = 20;  // hysteresis band around desiredSpeed
    this.senseDist        = 700; // how far down the path to look for corners
    this.speedCap         = Infinity; // external cap (lowered during search/withdraw)
    this.ramRange         = 95;  // px — inside this, ignore reaction lag and aim at the player's
                                 // ACTUAL position so the cop can make contact and shove (boxing/PIT)
    this.reactionTime     = 0.18;// s — while CHASING (clear line of sight) the cop steers
                                 // toward where you were this long ago, not where you are
                                 // now. 0 = perfect homing (mirrors you); higher = a sharp
                                 // juke makes it overshoot, so close-range homing is beatable.
    this.turnBrakeAngle   = 0.9; // rad (~52°) — steering error past which the cop slows to
                                 // tighten its turn radius (stops it washing into walls on a
                                 // hard redirect, e.g. when you round a corner). Below this,
                                 // ordinary chase corrections aren't slowed.
    this.turnBrakeSpeed   = 160; // px/s — speed cap at a 90°+ turn (tight enough to stay on road)
    this.losCommitTime    = 0.25;// s the line to the target must stay CONTINUOUSLY clear before a
                                 // cop re-commits to a beeline. Bridges momentary LOS breaks at a
                                 // corner so the aim doesn't flip-flop between the target and a path
                                 // node and back (the corner "jerk"). Entering navigation is still
                                 // immediate — this only DELAYS re-beelining, so it never beelines
                                 // through a wall (clearToTarget still gates it).

    // Per-unit-type overrides (from the UnitDef's `ai` block). Curated tunable keys
    // only — applied here so they win over the defaults but never touch the internal
    // path/aim state initialized below.
    if (overrides) Object.assign(this, overrides);

    // Cached node path + which node we're heading to
    this._path     = null;
    this._goalNode = -1;
    this._wpIndex  = 0;
    this._aimHist  = []; // recent target positions, for reaction lag
    this._navCommit = 0; // s remaining before a beeline may re-commit (LOS-flicker hysteresis)

    // --- Unstuck maneuver (wall-wedge extraction) ---
    this.unstuckBackTime = 0.5; // s reversing while turning
    this.unstuckFwdTime  = 0.4; // s forward while turning (committed) before re-evaluating
    this.unstuckProx     = 110; // px — DON'T unstick when this close to the target. The cop is
                                // effectively AT its goal (e.g. pinning the player against a wall
                                // during a box); backing up to "recover" would abandon the pin.
                                // Wedge recovery is only for being stuck FAR from the goal.
    this._unstuck    = null;    // active maneuver: { phase:'BACK'|'FWD', t }
    this._stuckTime  = 0;       // how long we've been wedged (far from target, not moving)
    this._unstuckDir = 1;       // turn direction; alternates each attempt
  }

  getControls(cop, target, dt) {
    const controls = { up: false, down: false, left: false, right: false, handbrake: false, brake: false };
    const cx = cop.sprite.x, cy = cop.sprite.y;
    const speed = cop.getSpeed();
    const dist  = Phaser.Math.Distance.Between(cx, cy, target.x, target.y);

    let aimX = target.x, aimY = target.y;
    let limit = Math.min(this.maxApproachSpeed, this.speedCap);
    let nextTurn = 0;

    // Record target history so we can steer toward a slightly-delayed position
    // (reaction lag) while chasing in clear sight.
    this._aimHist.push({ x: target.x, y: target.y });
    if (this._aimHist.length > 64) this._aimHist.shift();

    // Per-frame target motion: a frozen last-known is ~0 px/frame; a live position (player in
    // sight, or a teammate's relayed live sighting) moves meaningfully. Gates the close-cop
    // racing line below so it only fires on a SETTLED point — never a moving guess.
    const targetMoved = this._lastTarget
      ? Phaser.Math.Distance.Between(target.x, target.y, this._lastTarget.x, this._lastTarget.y)
      : 999;
    this._lastTarget = { x: target.x, y: target.y };

    // --- Wall-wedge extraction (OVERRIDES normal driving) ---
    // Run a K-turn that actually re-orients the car off the obstacle: reverse while
    // turning, then forward while turning, alternating the turn direction each
    // attempt so a retry tries the other way. Without this, the cop just juts
    // forward/reverse against the same wall (wheel stays pointed at the blocked
    // target) and never escapes.
    if (this._unstuck) {
      const m = this._unstuck;
      m.t -= dt;
      if (this._unstuckDir > 0) controls.right = true; else controls.left = true;
      if (m.phase === 'BACK') {
        controls.down = true;                 // reverse + turn
        if (m.t <= 0) { m.phase = 'FWD'; m.t = this.unstuckFwdTime; }
      } else {
        controls.up = true;                   // forward + turn (committed)
        if (m.t <= 0) this._unstuck = null;
      }
      cop.aiTarget = { x: target.x, y: target.y };
      cop.debug = { mode: m.phase === 'BACK' ? 'UNSTK_BK' : 'UNSTK_FW', speed, dist, bend: 0, cornerLimit: 0, angleErr: 0 };
      return controls;
    }
    // Wedge detection: barely moving while it wants to drive AND it's still far from its
    // goal. The old gate also fired at close range (`|| blocked`) to dislodge a cop jammed
    // on a corner near the player — but that's exactly a BOX pin, and K-turning out of it
    // abandoned the pin (and read as the "unstick steals the box" psychosis). Now a cop
    // within unstickProx of its target is treated as arrived: it presses, it never reverses.
    if (speed < 30 && dist > this.unstuckProx) this._stuckTime += dt; else this._stuckTime = 0;
    if (this._stuckTime > 0.35) {
      this._unstuckDir = -this._unstuckDir; // alternate so a retry tries the other way
      this._unstuck = { phase: 'BACK', t: this.unstuckBackTime };
      this._stuckTime = 0;
    }

    const clearToTarget = !this.rects || segmentClear(cx, cy, target.x, target.y, this.rects);

    // Beeline (drive straight at the point, cutting across the world) is ONLY correct
    // when the cop can actually SEE the player — then the target IS the player and a
    // clear line is a real chase lane. When the cop is BLIND its target is a GUESS
    // (last-known / search node / hunt goal); beelining at a guess and trusting a thin
    // clear centreline makes a fast car with a real turn radius cut building corners
    // (the wall-grind). So a blind cop ALWAYS navigates the road graph, which corners
    // at intersections and brakes for them. Point-blank (directRange) still rams
    // regardless, for contact.
    const rawBeeline = dist <= this.directRange || (cop.hasLOS && clearToTarget && dist <= this.chaseRange);
    // Hysteresis on re-committing to a beeline so a MOMENTARY LOS break at a corner doesn't flip
    // the aim between the target and a path node and back (the jerk). Navigation is entered
    // immediately (line blocked → commit); beeline only resumes once the line has been clear for
    // losCommitTime continuously. Point-blank (directRange) bypasses it for ram contact.
    if (!rawBeeline) this._navCommit = this.losCommitTime;
    else this._navCommit = Math.max(0, this._navCommit - dt);
    const beeline = dist <= this.directRange || (rawBeeline && this._navCommit <= 0);
    if (!beeline) {
      // --- Navigate the road network, one intersection at a time ---
      const copNode  = this.nav.nearestNode(cx, cy);
      const goalNode = this.nav.nearestNode(target.x, target.y);
      if (!this._path) {
        this._path = this.nav.findPath(copNode, goalNode);
        this._goalNode = goalNode;
        this._wpIndex = this._path.length > 1 ? 1 : 0; // path[0] is where we are
      } else if (goalNode !== this._goalNode) {
        // GOAL CHANGED — and this is where the swerve was born. The shared last-known
        // snaps to the player's LIVE position the instant a teammate regains sight, so a
        // blind cop's goal can teleport around a corner in one frame. Rebuilding the path
        // from scratch (and snapping the aim to a fresh path[1]) swings the wheel sideways
        // MID-STREET into the building corner. Instead, ANCHOR to the node we're already
        // committed to driving toward (it's clear from here — we were already going there)
        // and re-route only the TAIL beyond it. We keep heading to the current waypoint,
        // then follow the new path, so the redirect happens AT the open intersection, never
        // cutting across a corner. (Rule 1: goal decides WHERE; the path stays drivable.
        // Rule 3: no sideways anticipation toward a relayed live position.)
        const anchor = this._wpIndex < this._path.length ? this._path[this._wpIndex] : copNode;
        const tail   = this.nav.findPath(anchor, goalNode);
        this._path     = anchor === copNode ? tail : [copNode, ...tail];
        this._goalNode = goalNode;
        this._wpIndex  = this._path.length > 1 ? 1 : 0;
      }

      // Advance to the next node when REACHED (within arriveRadius) OR PASSED (the cop is now
      // closer to the next node than this node is — i.e. it cut the corner). The "passed" test is
      // what lets corner-cutting work: the cop no longer has to drive all the way to the node centre.
      let wp = this.nav.pos(this._path[this._wpIndex]);
      while (this._wpIndex < this._path.length - 1) {
        const nx = this.nav.pos(this._path[this._wpIndex + 1]);
        const reached = Phaser.Math.Distance.Between(cx, cy, wp.x, wp.y) < this.arriveRadius;
        const passed  = Phaser.Math.Distance.Between(cx, cy, nx.x, nx.y) <
                        Phaser.Math.Distance.Between(wp.x, wp.y, nx.x, nx.y);
        if (!reached && !passed) break;
        this._wpIndex++;
        wp = nx;
      }

      // CORNER ANTICIPATION — don't aim AT the node centre (drive there, snap 90°, drone to the
      // next). Build a curve that leaves the cop tangent to its heading, bends THROUGH the current
      // node N (control), and heads toward the NEXT node M (endpoint) — so the turn starts early and
      // the cop rounds the corner. M may be occluded around the corner; that's fine, the curve comes
      // from the PATH not line-of-sight, and every aim sample is still edge-checked. For a CLOSE cop
      // that lost a FROZEN last-known, aim at that point itself (its racing line, off the node
      // centre) — fixes the wide-road detour; distant cops / moving targets keep the node curve.
      const N = wp;
      const Mraw = this._wpIndex + 1 < this._path.length
        ? this.nav.pos(this._path[this._wpIndex + 1])
        : { x: target.x, y: target.y };
      // Reach only a BOUNDED distance past N toward the next node — round the corner LOCALLY rather
      // than slicing all the way toward M (which cut the inside building, ~17% clip). cornerReach ≈
      // one road-width keeps the curve inside the intersection.
      const mnx = Mraw.x - N.x, mny = Mraw.y - N.y, mnl = Math.hypot(mnx, mny) || 1;
      const reach = Math.min(mnl, this.cornerReach);
      let ctrl = N, dest = { x: N.x + (mnx / mnl) * reach, y: N.y + (mny / mnl) * reach };
      if (dist <= this.huntContinueRange && targetMoved < 0.5 &&
          (!this.rects || segmentClear(cx, cy, target.x, target.y, this.rects))) {
        ctrl = { x: target.x, y: target.y };
        dest = ctrl;
      }
      const hd = speed > 30 ? Math.atan2(cop.vy, cop.vx) : cop.facing;       // travel direction
      const d1 = Phaser.Math.Clamp(speed * 0.5, 60, 200);                    // departure tangent (∝ speed)
      const P0 = { x: cx, y: cy };
      const P1 = { x: cx + Math.cos(hd) * d1, y: cy + Math.sin(hd) * d1 };
      // Aim at the FURTHEST point on the curve with a clear line (string-pull, edge-aware): when the
      // corner occludes the far part, it aims at a nearer on-road point and rounds in as it advances.
      let chosen = null;
      for (const t of [0.9, 0.72, 0.54, 0.36, 0.2]) {
        const b = this._cubicBezier(P0, P1, ctrl, dest, t);
        if (!this.rects || segmentClear(cx, cy, b.x, b.y, this.rects)) { chosen = b; break; }
      }
      aimX = chosen ? chosen.x : N.x; // fallback: the current node, to rejoin the road network
      aimY = chosen ? chosen.y : N.y;

      // Speed: brake for the corners along the remaining path.
      const pts = this._path.map(n => this.nav.pos(n));
      pts.push({ x: target.x, y: target.y });
      const lim = this._speedLimit(pts, cx, cy, limit, speed);
      limit = lim.speed; nextTurn = lim.turn;
    } else {
      // Visible or close — drop the cached path so we re-plan fresh next time.
      this._path = null; this._goalNode = -1;

      // Reaction lag: steer toward where the target WAS reactionTime ago instead
      // of where it is now. Through a sharp juke the cop commits to your old
      // heading and overshoots, opening a gap. BUT only at range — within ramRange
      // it aims at your ACTUAL position so it can make contact and shove you
      // (boxing / PIT); otherwise the lag leaves it trailing ~70px back, unable
      // to ever touch you ("comes to a dead stop").
      if (this.reactionTime > 0 && dist > this.ramRange) {
        const lagFrames = Math.min(this._aimHist.length - 1, Math.round(this.reactionTime / dt));
        const past = this._aimHist[this._aimHist.length - 1 - lagFrames];
        // Only commit to the stale position if the cop can actually drive there in a
        // straight line. After you round a corner the lagged point sits THROUGH the
        // building corner — aiming at it drove the cop face-first into the wall (the
        // "bumper cop suddenly swerved into a wall"). When it's blocked, turn with the
        // player's real position instead. The juke still works in the open: the cop
        // commits to your old heading and overshoots where the line is clear.
        if (!this.rects || segmentClear(cx, cy, past.x, past.y, this.rects)) {
          aimX = past.x; aimY = past.y;
        }
      }
    }
    cop.aiTarget = { x: aimX, y: aimY };

    // --- Steering toward the aim point ---
    const desired  = Math.atan2(aimY - cy, aimX - cx);
    const angleErr = Phaser.Math.Angle.Wrap(desired - cop.facing);
    if (angleErr > this.steerDeadzone)       controls.right = true;
    else if (angleErr < -this.steerDeadzone) controls.left  = true;

    // --- Turn-brake: slow down to actually MAKE a sharp turn ---
    // At speed the turn radius is wider than a street, so when the aim point swings
    // hard (you round a corner and the cop's target snaps to a new angle) a full-speed
    // cop washes wide into the building. Cap the speed by how hard it needs to turn so
    // the radius tightens enough to stay on the road. Only bites past turnBrakeAngle,
    // so ordinary chase corrections are unaffected. (Beeline has no path corner-braking
    // otherwise — this is what was missing.)
    const turnMag = Math.abs(angleErr);
    if (turnMag > this.turnBrakeAngle) {
      const tf = Phaser.Math.Clamp((turnMag - this.turnBrakeAngle) / (Math.PI / 2 - this.turnBrakeAngle), 0, 1);
      limit = Math.min(limit, Phaser.Math.Linear(this.maxApproachSpeed, this.turnBrakeSpeed, tf));
    }

    // --- Throttle toward desiredSpeed ---
    let mode;
    if (speed > limit + this.speedMargin)      { controls.brake = true; mode = 'BRAKE'; }
    else if (speed < limit - this.speedMargin) { controls.up    = true; mode = (beeline ? 'CHASE' : 'PURSUE'); }
    else                                         { mode = 'CRUISE'; }

    cop.debug = { mode, speed, dist, bend: nextTurn, cornerLimit: limit, angleErr };
    return controls;
  }

  // Cubic Bezier point at t∈[0,1] (used to bend the nav aim into a smooth racing line).
  _cubicBezier(p0, p1, p2, p3, t) {
    const u = 1 - t, uu = u * u, tt = t * t;
    const a = uu * u, b = 3 * uu * t, c = 3 * u * tt, d = tt * t;
    return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
             y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
  }

  // Safe speed for a corner of the given turn angle: straight → max, 90°+ → min.
  _cornerSpeed(turn) {
    const t = Math.min(turn / (Math.PI / 2), 1);
    return Phaser.Math.Linear(this.maxApproachSpeed, this.cornerMinSpeed, t);
  }

  // Look-ahead braking: the fastest speed now that still lets us brake to a safe
  // speed for every corner ahead. Scans far enough to brake from the current
  // speed (v²/2decel), so even a fast cop slows in time instead of overshooting.
  _speedLimit(pts, x, y, baseCap, speed) {
    const lookDist = Math.max(this.senseDist, (speed * speed) / (2 * this.brakeDecel) + 120);
    const { seg } = this._closest(pts, x, y);
    let limit = baseCap, sharpest = 0;
    let acc = Phaser.Math.Distance.Between(x, y, pts[seg + 1].x, pts[seg + 1].y);
    for (let i = seg + 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      const turn = Math.abs(Phaser.Math.Angle.Wrap(
        Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x)));
      const vC = this._cornerSpeed(turn);
      const allowed = Math.sqrt(vC * vC + 2 * this.brakeDecel * Math.max(acc, 0));
      if (allowed < limit) limit = allowed;
      if (turn > sharpest) sharpest = turn;
      acc += Phaser.Math.Distance.Between(b.x, b.y, c.x, c.y);
      if (acc > lookDist) break;
    }
    return { speed: limit, turn: sharpest };
  }

  // Closest point on the polyline to (x,y): segment index + point.
  _closest(pts, x, y) {
    let seg = 0, px = pts[0].x, py = pts[0].y, best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const abx = b.x - a.x, aby = b.y - a.y;
      const len2 = abx * abx + aby * aby || 1e-6;
      let t = ((x - a.x) * abx + (y - a.y) * aby) / len2;
      t = Math.max(0, Math.min(1, t));
      const qx = a.x + abx * t, qy = a.y + aby * t;
      const dx = x - qx, dy = y - qy, dd = dx * dx + dy * dy;
      if (dd < best) { best = dd; seg = i; px = qx; py = qy; }
    }
    return { seg, px, py };
  }
}
