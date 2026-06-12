import Phaser from 'phaser';

// Drives a cop Vehicle toward the player along the road network.
//
// Behaviours (milestone 1):
//  - Pathfind over the NavGrid (BFS) to a polyline of road intersections, then
//    follow it with a lookahead "carrot" (pure-pursuit path following). This
//    keeps the cop on the streets and rounds corners instead of cutting across
//    building footprints toward a single far node.
//  - Stuck detection + reverse recovery: if it wedges on a building it backs off
//    while turning so it re-approaches at a new angle.
//  - Approach control: as it closes on the player it bleeds speed so it makes
//    contact instead of orbiting at speed.
export class CopAI {
  constructor(navGrid) {
    this.nav = navGrid;
    this.steerDeadzone = 0.05; // rad — avoid left/right jitter when nearly aligned
    this.directRange   = 120;  // within this, aim straight at the player
    this.lookahead     = 115;  // steering carrot distance ahead along the path (px)

    // Corner speed governor: brake before bends so the car doesn't understeer wide
    this.senseLookahead  = 400; // how far ahead the second carrot looks for curvature
    this.maxApproachSpeed = 600; // speed cap on a straight (effectively none)
    this.cornerMinSpeed   = 130; // speed cap through the sharpest (~90°+) corner
    this.cornerClamp      = 1.1; // rad (~63°) — only clamp near-90° grid corners,
                                 // not the shallow off-grid bend toward the player

    // Per-cop state
    this._reverseTime  = 0;     // remaining time in a reverse-recovery maneuver
    this._escapeDir    = 1;     // which way to steer while backing out (alternates)
    this._stuckCount   = 0;     // consecutive stuck triggers without escaping
    this._anchorX      = 0;     // where we first got stuck this cycle
    this._anchorY      = 0;
    this._anchorInit   = false;
    this._graceTime    = 0;     // post-reverse window where stuck detection is suspended
    this._sampleTimer  = 0;     // time accumulated toward the next displacement check
    this._sampleX      = 0;     // position at the start of the current window
    this._sampleY      = 0;
    this._sampleInit   = false;

    // Stuck = barely moved over a window while still pursuing. The window is long
    // enough (and the distance high enough) that a car accelerating from a stop
    // clears it easily — only a genuinely pinned car stays under it.
    this.stuckWindow = 0.6; // seconds between displacement checks
    this.stuckDist   = 20;  // px — moved less than this in a window → wedged
    this.graceDur    = 0.5; // seconds after a reverse before stuck can re-arm
    this.escapeReset = 160; // px from the wedge before we consider ourselves free
  }

  // Returns { up, down, left, right, handbrake, brake }
  getControls(cop, target, dt) {
    const controls = { up: false, down: false, left: false, right: false, handbrake: false, brake: false };

    const cx = cop.sprite.x, cy = cop.sprite.y;
    const dist  = Phaser.Math.Distance.Between(cx, cy, target.x, target.y);
    const speed = cop.getSpeed();

    // --- Choose a steering target + sense the upcoming corner ---
    let aimX = target.x, aimY = target.y;
    let cornerSpeedLimit = this.maxApproachSpeed;
    let bend = 0;
    if (dist > this.directRange) {
      const copNode    = this.nav.nearestNode(cx, cy);
      const playerNode = this.nav.nearestNode(target.x, target.y);
      const path       = this.nav.findPath(copNode, playerNode);

      // Polyline of intersection positions, ending at the player's real position
      const pts = path.map(n => this.nav.pos(n));
      pts.push({ x: target.x, y: target.y });

      const near = this._carrot(pts, cx, cy, this.lookahead);
      aimX = near.x; aimY = near.y;

      // A farther carrot reveals where the road goes next; the angle between the
      // two segments is the sharpness of the upcoming bend. Sharper → slower cap.
      const far  = this._carrot(pts, cx, cy, this.senseLookahead);
      const h1   = Math.atan2(near.y - cy, near.x - cx);
      const h2   = Math.atan2(far.y - near.y, far.x - near.x);
      bend       = Math.abs(Phaser.Math.Angle.Wrap(h2 - h1)); // 0..π
      const t    = Math.min(bend / (Math.PI / 2), 1);         // 90°+ bend = full severity
      cornerSpeedLimit = Phaser.Math.Linear(this.maxApproachSpeed, this.cornerMinSpeed, t);
    }
    cop.aiTarget = { x: aimX, y: aimY }; // exposed for debug draw

    // --- Steering (toward the aim point) ---
    const desired  = Math.atan2(aimY - cy, aimX - cx);
    const angleErr = Phaser.Math.Angle.Wrap(desired - cop.facing);
    const absErr   = Math.abs(angleErr);

    if (angleErr > this.steerDeadzone)       controls.right = true;
    else if (angleErr < -this.steerDeadzone) controls.left  = true;

    // --- Reverse recovery (in progress) ---
    // Back out while turning hard in one consistent direction so we trace a wide
    // arc and actually relocate (not just nudge off and re-wedge). The direction
    // alternates each attempt and the duration escalates (see below), so a stuck
    // cop is guaranteed to break free rather than oscillating forever.
    if (this._reverseTime > 0) {
      this._reverseTime -= dt;
      if (this._reverseTime <= 0) this._graceTime = this.graceDur; // let it rebuild speed
      controls.down  = true;
      controls.left  = this._escapeDir < 0;
      controls.right = this._escapeDir > 0;
      this._sampleX = cx; this._sampleY = cy; this._sampleTimer = 0;
      cop.debug = { mode: 'REVERSE', speed, dist, bend, cornerLimit: cornerSpeedLimit,
                    angleErr, reverseTime: this._reverseTime, stuckCount: this._stuckCount };
      return controls;
    }

    // Once we've moved well clear of where we got stuck, reset the escalation.
    if (this._anchorInit &&
        Phaser.Math.Distance.Between(cx, cy, this._anchorX, this._anchorY) > this.escapeReset) {
      this._anchorInit = false;
      this._stuckCount = 0;
    }

    // --- Stuck detection (displacement-based) ---
    // "Stuck" = barely moved over the window while still pursuing (NOT merely
    // slow — a car accelerating from a stop, or creeping through an alley, is
    // displacing). Suspended briefly after a reverse so the cop can rebuild speed
    // before we re-check. Each consecutive trigger escalates the recovery.
    if (this._graceTime > 0) {
      this._graceTime -= dt;
      this._sampleX = cx; this._sampleY = cy; this._sampleTimer = 0;
    } else {
      if (!this._sampleInit) {
        this._sampleX = cx; this._sampleY = cy; this._sampleInit = true;
      }
      this._sampleTimer += dt;
      if (this._sampleTimer >= this.stuckWindow) {
        const moved = Phaser.Math.Distance.Between(cx, cy, this._sampleX, this._sampleY);
        if (dist > 80 && moved < this.stuckDist) {
          if (!this._anchorInit) { this._anchorX = cx; this._anchorY = cy; this._anchorInit = true; }
          this._stuckCount++;
          this._escapeDir   = (this._stuckCount % 2 === 0) ? 1 : -1; // alternate each attempt
          this._reverseTime = Math.min(0.5 + (this._stuckCount - 1) * 0.3, 1.4); // escalate duration
        } else {
          // Made progress this window — clear any escalation.
          this._stuckCount = 0;
          this._anchorInit = false;
        }
        this._sampleX = cx; this._sampleY = cy; this._sampleTimer = 0;
      }
    }

    // --- Throttle ---
    let mode;
    if (dist < 130) {
      // Close approach: bleed speed so we converge and bump rather than orbit.
      if (speed > 140)      { controls.brake = true; mode = 'APPROACH-BRAKE'; }
      else if (absErr < 1.3){ controls.up    = true; mode = 'APPROACH'; }
      else                    mode = 'APPROACH-COAST';
    } else if (speed > cornerSpeedLimit) {
      // Going too fast for the bend ahead — brake to a safe entry speed so we
      // can actually turn instead of understeering wide.
      controls.brake = true;
      mode = 'CORNER-BRAKE';
    } else {
      // Open pursuit: accelerate when roughly aligned; creep forward when slow
      // so a car that's pointed wrong can still arc around (can't turn in place).
      if (absErr < 1.3 || speed < 110) { controls.up = true; mode = 'PURSUE'; }
      else                               mode = 'COAST-TURN';
    }

    cop.debug = { mode, speed, dist, bend, cornerLimit: cornerSpeedLimit, angleErr, reverseTime: 0 };
    return controls;
  }

  // Pure-pursuit carrot: find the closest point on the polyline to (x,y), then
  // walk `lookahead` px forward along the polyline and return that point.
  _carrot(pts, x, y, lookahead) {
    // 1) closest point across all segments
    let bestSeg = 0, bestPx = pts[0].x, bestPy = pts[0].y, bestD2 = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const abx = b.x - a.x, aby = b.y - a.y;
      const len2 = abx * abx + aby * aby || 1e-6;
      let t = ((x - a.x) * abx + (y - a.y) * aby) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + abx * t, py = a.y + aby * t;
      const dx = x - px, dy = y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; bestSeg = i; bestPx = px; bestPy = py; }
    }

    // 2) walk forward `lookahead` from that point, but stop at a sharp turn so
    //    the carrot never reaches past a corner (which would aim straight across
    //    the building on the inside of the bend). The cop drives to the corner,
    //    then the carrot advances onto the next street.
    let remain = lookahead;
    let curx = bestPx, cury = bestPy;
    for (let i = bestSeg; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - curx, dy = b.y - cury;
      const segLen = Math.hypot(dx, dy);
      if (segLen >= remain) {
        const f = remain / segLen;
        return { x: curx + dx * f, y: cury + dy * f };
      }
      remain -= segLen;
      curx = b.x; cury = b.y;
      // If the path turns sharply at vertex b, clamp the carrot there.
      if (i + 2 < pts.length) {
        const c = pts[i + 2];
        const inAng  = Math.atan2(b.y - a.y, b.x - a.x);
        const outAng = Math.atan2(c.y - b.y, c.x - b.x);
        if (Math.abs(Phaser.Math.Angle.Wrap(outAng - inAng)) > this.cornerClamp) {
          return { x: b.x, y: b.y };
        }
      }
    }
    // ran past the end of the path → aim at the final point (the player)
    return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
  }
}
