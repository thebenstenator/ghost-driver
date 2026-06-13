import Phaser from 'phaser';
import { segmentClear } from './lineOfSight.js';

// Path-following cop controller — one clean control law, not a mode cascade.
//
//  • Steering (pure pursuit): aim at a lookahead point on the road path and steer
//    toward it. Cops run a high minSteerFactor so steering never dies at low speed
//    — a car that can always turn cannot deadlock, which removes the need for the
//    old reverse-recovery / U-turn / stuck special cases.
//
//  • Speed: a single desiredSpeed from LOOK-AHEAD BRAKING over the actual path
//    geometry. We know each upcoming corner's angle and distance, so we compute
//    the fastest speed that still lets us brake to a safe speed for every corner
//    ahead, capped per pursuit state. Then just accelerate or brake toward it.
//
// Because steering is computed from the cop's REAL position relative to the path
// (not an assumed racing line), being shoved off-line self-corrects instead of
// crashing. A tiny failsafe handles a genuine physics wedge (nosed into a wall).
export class CopAI {
  constructor(navGrid, rects = null) {
    this.nav   = navGrid;
    this.rects = rects; // building footprints for the "don't steer through a wall" net

    // --- Tunables ---
    this.steerLookahead   = 140; // MAX px ahead on the path (used on straights);
                                 // shortens with speed so corners are hugged tight
    this.steerDeadzone    = 0.05;
    this.directRange      = 120; // within this, aim straight at the target
    this.maxApproachSpeed = 610; // speed on a straight (physics caps lower)
    this.baseApproach     = 610; // catch-up rubber-band raises maxApproachSpeed above this when far
    this.cornerMinSpeed   = 190; // speed through a 90°+ corner
    this.brakeDecel       = 320; // assumed braking power for the slow-down curve
    this.speedMargin      = 20;  // hysteresis band around desiredSpeed
    this.senseDist        = 700; // how far down the path to look for corners
    this.cornerClamp      = 0.9; // rad (~51°) — carrot won't round a turn sharper than
                                 // this until the cop reaches it (drive into the junction first)
    this.speedCap         = Infinity; // external cap (lowered during search/withdraw)

    // Cached route (recomputed on goal change or every interval — avoids per-frame
    // flip-flop between equal-cost grid paths).
    this._pathPts  = null;
    this._goalNode = -1;
    this._pathTimer = 0;
    this.pathRecomputeInterval = 0.5;

    // Failsafe for a genuine physics wedge only
    this._sampleTimer = 0; this._sampleX = 0; this._sampleY = 0; this._sampleInit = false;
    this._reverseTime = 0;
  }

  getControls(cop, target, dt) {
    const controls = { up: false, down: false, left: false, right: false, handbrake: false, brake: false };
    const cx = cop.sprite.x, cy = cop.sprite.y;
    const speed = cop.getSpeed();
    const dist  = Phaser.Math.Distance.Between(cx, cy, target.x, target.y);
    this._pathTimer -= dt;

    // --- Pick a steering aim + a speed limit ---
    let aimX = target.x, aimY = target.y;
    let limit = Math.min(this.maxApproachSpeed, this.speedCap);
    let nextTurn = 0;

    if (dist > this.directRange) {
      const copNode  = this.nav.nearestNode(cx, cy);
      const goalNode = this.nav.nearestNode(target.x, target.y);
      if (!this._pathPts || goalNode !== this._goalNode || this._pathTimer <= 0) {
        const path = this.nav.findPath(copNode, goalNode);
        this._pathPts  = path.map(n => this.nav.pos(n));
        this._goalNode = goalNode;
        this._pathTimer = this.pathRecomputeInterval;
      }
      const pts = this._pathPts.concat({ x: target.x, y: target.y });

      // Speed-proportional lookahead: short when slow (hugs tight corners),
      // long when fast (smooth straights). ~0.3s of travel, clamped.
      const la = Phaser.Math.Clamp(speed * 0.3, 50, this.steerLookahead);
      const carrot = this._carrot(pts, cx, cy, la);
      aimX = carrot.x; aimY = carrot.y;

      const lim = this._speedLimit(pts, cx, cy, limit, speed);
      limit = lim.speed; nextTurn = lim.turn;

      // Safety net: never steer the straight line through a building.
      if (this.rects && !segmentClear(cx, cy, aimX, aimY, this.rects)) {
        const np = this.nav.pos(copNode);
        aimX = np.x; aimY = np.y;
      }
    }
    cop.aiTarget = { x: aimX, y: aimY };

    // --- Steering (pure pursuit toward the aim point) ---
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
    else if (speed < limit - this.speedMargin) { controls.up    = true; mode = (limit >= this.maxApproachSpeed - 1 ? 'PURSUE' : 'ACCEL'); }
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
  // speed for every corner ahead within senseDist. Based on the path's real
  // corner angles + distances, so it slows the right amount, early enough.
  _speedLimit(pts, x, y, baseCap, speed) {
    // Look far enough ahead to actually brake from the CURRENT speed: braking
    // distance is v²/(2·decel), so a fast (e.g. catch-up-boosted) cop scans
    // further and starts slowing in time instead of overshooting the corner.
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

  // Point `lookahead` px forward along the polyline from the closest point.
  _carrot(pts, x, y, lookahead) {
    const c = this._closest(pts, x, y);
    let remain = lookahead, curx = c.px, cury = c.py;
    for (let i = c.seg; i < pts.length - 1; i++) {
      const b = pts[i + 1];
      const dx = b.x - curx, dy = b.y - cury;
      const segLen = Math.hypot(dx, dy);
      if (segLen >= remain) { const f = remain / segLen; return { x: curx + dx * f, y: cury + dy * f }; }
      remain -= segLen; curx = b.x; cury = b.y;
      // Stop the carrot at a sharp corner so the cop drives into the junction
      // before turning — instead of cutting across the inside building.
      if (i + 2 < pts.length) {
        const inAng  = Math.atan2(b.y - pts[i].y, b.x - pts[i].x);
        const outAng = Math.atan2(pts[i + 2].y - b.y, pts[i + 2].x - b.x);
        if (Math.abs(Phaser.Math.Angle.Wrap(outAng - inAng)) > this.cornerClamp) {
          return { x: b.x, y: b.y };
        }
      }
    }
    return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
  }
}
