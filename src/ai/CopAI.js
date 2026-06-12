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

    // Per-cop state
    this._reverseTime  = 0;     // remaining time in a reverse-recovery maneuver
    this._sampleTimer  = 0;     // time accumulated toward the next displacement check
    this._sampleX      = 0;     // position at the start of the current window
    this._sampleY      = 0;
    this._sampleInit   = false;

    // Stuck = barely moved over a short window while still trying to pursue.
    this.stuckWindow = 0.3; // seconds between displacement checks
    this.stuckDist   = 12;  // px — moved less than this in a window → wedged
    this.reverseDur  = 0.5; // seconds to back out when stuck
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
    // Back off while turning, so we both pull away from the obstacle and change
    // our heading. Force a turn even when "aligned" — otherwise a cop wedged
    // straight into a wall just reverses and re-approaches the same spot forever.
    // Keep the displacement sample pinned to here so we don't instantly re-trigger
    // once we resume.
    if (this._reverseTime > 0) {
      this._reverseTime -= dt;
      controls.down  = true;
      controls.left  = false;
      controls.right = false;
      if (absErr < 0.3) controls.right = true;        // pointed at the wall: pick a side to swing out
      else if (angleErr > 0) controls.right = true;   // otherwise rotate toward the target
      else controls.left = true;
      this._sampleX = cx; this._sampleY = cy; this._sampleTimer = 0;
      cop.debug = { mode: 'REVERSE', speed, dist, bend: 0, cornerLimit: cornerSpeedLimit,
                    angleErr, reverseTime: this._reverseTime };
      return controls;
    }

    // --- Stuck detection (displacement-based) ---
    // "Stuck" means we've barely moved over a short window while still pursuing —
    // NOT merely going slow. A cop creeping through a narrow alley is displacing,
    // so it won't false-trigger; only a genuinely wedged car stays put.
    if (!this._sampleInit) {
      this._sampleX = cx; this._sampleY = cy; this._sampleInit = true;
    }
    this._sampleTimer += dt;
    if (this._sampleTimer >= this.stuckWindow) {
      const moved = Phaser.Math.Distance.Between(cx, cy, this._sampleX, this._sampleY);
      if (dist > 80 && moved < this.stuckDist) this._reverseTime = this.reverseDur;
      this._sampleX = cx; this._sampleY = cy; this._sampleTimer = 0;
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

    // 2) walk forward `lookahead` from that point
    let remain = lookahead;
    let curx = bestPx, cury = bestPy;
    for (let i = bestSeg; i < pts.length - 1; i++) {
      const b = pts[i + 1];
      const dx = b.x - curx, dy = b.y - cury;
      const segLen = Math.hypot(dx, dy);
      if (segLen >= remain) {
        const f = remain / segLen;
        return { x: curx + dx * f, y: cury + dy * f };
      }
      remain -= segLen;
      curx = b.x; cury = b.y;
    }
    // ran past the end of the path → aim at the final point (the player)
    return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
  }
}
