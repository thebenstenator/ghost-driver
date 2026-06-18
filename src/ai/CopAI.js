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

    // Per-unit-type overrides (from the UnitDef's `ai` block). Curated tunable keys
    // only — applied here so they win over the defaults but never touch the internal
    // path/aim state initialized below.
    if (overrides) Object.assign(this, overrides);

    // Cached node path + which node we're heading to
    this._path     = null;
    this._goalNode = -1;
    this._wpIndex  = 0;
    this._aimHist  = []; // recent target positions, for reaction lag

    // --- Unstuck maneuver (wall-wedge extraction) ---
    this.unstuckBackTime = 0.5; // s reversing while turning
    this.unstuckFwdTime  = 0.4; // s forward while turning (committed) before re-evaluating
    this._unstuck    = null;    // active maneuver: { phase:'BACK'|'FWD', t }
    this._stuckTime  = 0;       // how long we've been wedged (far from target, not moving)
    this._unstuckDir = 1;       // turn direction; alternates each attempt
  }

  getControls(cop, target, dt) {
    const controls = { up: false, down: false, left: false, right: false, handbrake: false, brake: false };
    const cx = cop.sprite.x, cy = cop.sprite.y;
    const speed = cop.getSpeed();
    const dist  = Phaser.Math.Distance.Between(cx, cy, target.x, target.y);
    const blocked = !!(cop.sprite.body.blocked && !cop.sprite.body.blocked.none);

    let aimX = target.x, aimY = target.y;
    let limit = Math.min(this.maxApproachSpeed, this.speedCap);
    let nextTurn = 0;

    // Record target history so we can steer toward a slightly-delayed position
    // (reaction lag) while chasing in clear sight.
    this._aimHist.push({ x: target.x, y: target.y });
    if (this._aimHist.length > 64) this._aimHist.shift();

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
    // Wedge detection: barely moving while it wants to drive — either far from a target
    // (classic wedge) OR physically jammed against a wall at close range (the dist<100
    // grind that the old "dist>100" gate ignored, so a cop pinned on a corner a few px
    // from the player ground forever). `blocked` distinguishes a real jam from simply
    // sitting still near the target.
    if (speed < 30 && (dist > 100 || blocked)) this._stuckTime += dt; else this._stuckTime = 0;
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
    const beeline = dist <= this.directRange || (cop.hasLOS && clearToTarget && dist <= this.chaseRange);
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

      // Advance to the next node once we've reached the current one.
      let wp = this.nav.pos(this._path[this._wpIndex]);
      if (Phaser.Math.Distance.Between(cx, cy, wp.x, wp.y) < this.arriveRadius &&
          this._wpIndex < this._path.length - 1) {
        this._wpIndex++;
        wp = this.nav.pos(this._path[this._wpIndex]);
      }
      aimX = wp.x; aimY = wp.y;

      // Safety net: if even the next node is blocked (we got shoved off the road),
      // steer back to the node behind us to rejoin the network.
      if (this.rects && !segmentClear(cx, cy, aimX, aimY, this.rects)) {
        const back = this.nav.pos(this._path[Math.max(0, this._wpIndex - 1)]);
        aimX = back.x; aimY = back.y;
      }

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
