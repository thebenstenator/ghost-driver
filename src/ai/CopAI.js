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
  constructor(navGrid, rects = null) {
    this.nav   = navGrid;
    this.rects = rects;

    // --- Tunables ---
    this.steerDeadzone    = 0.05;
    this.directRange      = 130; // within this, aim straight at the target
    this.arriveRadius     = 70;  // px to count a path node as reached
    this.maxApproachSpeed = 610; // speed on a straight (physics caps lower)
    this.baseApproach     = 610; // catch-up rubber-band raises maxApproachSpeed above this when far
    this.cornerMinSpeed   = 190; // speed through a 90°+ corner
    this.brakeDecel       = 320; // assumed braking power for the slow-down curve
    this.speedMargin      = 20;  // hysteresis band around desiredSpeed
    this.senseDist        = 700; // how far down the path to look for corners
    this.speedCap         = Infinity; // external cap (lowered during search/withdraw)

    // Cached node path + which node we're heading to
    this._path     = null;
    this._goalNode = -1;
    this._wpIndex  = 0;

    // Failsafe for a genuine physics wedge only
    this._sampleTimer = 0; this._sampleX = 0; this._sampleY = 0; this._sampleInit = false;
    this._reverseTime = 0;
  }

  getControls(cop, target, dt) {
    const controls = { up: false, down: false, left: false, right: false, handbrake: false, brake: false };
    const cx = cop.sprite.x, cy = cop.sprite.y;
    const speed = cop.getSpeed();
    const dist  = Phaser.Math.Distance.Between(cx, cy, target.x, target.y);

    let aimX = target.x, aimY = target.y;
    let limit = Math.min(this.maxApproachSpeed, this.speedCap);
    let nextTurn = 0;

    const clearToTarget = !this.rects || segmentClear(cx, cy, target.x, target.y, this.rects);

    if (!clearToTarget && dist > this.directRange) {
      // --- Navigate the road network, one intersection at a time ---
      const copNode  = this.nav.nearestNode(cx, cy);
      const goalNode = this.nav.nearestNode(target.x, target.y);
      if (!this._path || goalNode !== this._goalNode) {
        this._path = this.nav.findPath(copNode, goalNode);
        this._goalNode = goalNode;
        this._wpIndex = this._path.length > 1 ? 1 : 0; // path[0] is where we are
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
    }
    cop.aiTarget = { x: aimX, y: aimY };

    // --- Steering toward the aim point ---
    const desired  = Math.atan2(aimY - cy, aimX - cx);
    const angleErr = Phaser.Math.Angle.Wrap(desired - cop.facing);
    if (angleErr > this.steerDeadzone)       controls.right = true;
    else if (angleErr < -this.steerDeadzone) controls.left  = true;

    // --- Failsafe: genuine wedge (barely moving, not at target) → brief reverse ---
    if (this._reverseTime > 0) {
      this._reverseTime -= dt;
      controls.down = true; // keep the wheel turned toward target while backing out
      this._sampleX = cx; this._sampleY = cy; this._sampleTimer = 0;
      cop.debug = { mode: 'REVERSE', speed, dist, bend: nextTurn, cornerLimit: limit, angleErr, reverseTime: this._reverseTime };
      return controls;
    }
    if (!this._sampleInit) { this._sampleX = cx; this._sampleY = cy; this._sampleInit = true; }
    this._sampleTimer += dt;
    if (this._sampleTimer >= 0.7) {
      const moved = Phaser.Math.Distance.Between(cx, cy, this._sampleX, this._sampleY);
      if (dist > 80 && moved < 15) this._reverseTime = 0.5;
      this._sampleX = cx; this._sampleY = cy; this._sampleTimer = 0;
    }

    // --- Throttle toward desiredSpeed ---
    let mode;
    if (speed > limit + this.speedMargin)      { controls.brake = true; mode = 'BRAKE'; }
    else if (speed < limit - this.speedMargin) { controls.up    = true; mode = (clearToTarget ? 'CHASE' : 'PURSUE'); }
    else                                         { mode = 'CRUISE'; }

    cop.debug = { mode, speed, dist, bend: nextTurn, cornerLimit: limit, angleErr, reverseTime: 0 };
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
