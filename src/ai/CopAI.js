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
    this.lookahead     = 150;  // carrot distance ahead along the path (px)

    // Per-cop state
    this._stuckTime   = 0; // how long we've been barely moving while pursuing
    this._reverseTime = 0; // remaining time in a reverse-recovery maneuver
  }

  // Returns { up, down, left, right, handbrake, brake }
  getControls(cop, target, dt) {
    const controls = { up: false, down: false, left: false, right: false, handbrake: false, brake: false };

    const cx = cop.sprite.x, cy = cop.sprite.y;
    const dist  = Phaser.Math.Distance.Between(cx, cy, target.x, target.y);
    const speed = cop.getSpeed();

    // --- Choose a steering target ---
    let aimX = target.x, aimY = target.y;
    if (dist > this.directRange) {
      const copNode    = this.nav.nearestNode(cx, cy);
      const playerNode = this.nav.nearestNode(target.x, target.y);
      const path       = this.nav.findPath(copNode, playerNode);

      // Polyline of intersection positions, ending at the player's real position
      const pts = path.map(n => this.nav.pos(n));
      pts.push({ x: target.x, y: target.y });

      const carrot = this._carrot(pts, cx, cy, this.lookahead);
      aimX = carrot.x; aimY = carrot.y;
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
    if (this._reverseTime > 0) {
      this._reverseTime -= dt;
      controls.down  = true;
      controls.left  = false;
      controls.right = false;
      if (absErr < 0.3) controls.right = true;        // pointed at the wall: pick a side to swing out
      else if (angleErr > 0) controls.right = true;   // otherwise rotate toward the target
      else controls.left = true;
      return controls;
    }

    // --- Stuck detection ---
    // Barely moving while not already on top of the player → we're wedged.
    if (dist > 80 && speed < 40) {
      this._stuckTime += dt;
      if (this._stuckTime > 0.45) {
        this._reverseTime = 0.7;
        this._stuckTime   = 0;
      }
    } else {
      this._stuckTime = Math.max(0, this._stuckTime - dt * 2);
    }

    // --- Throttle ---
    if (dist < 130) {
      // Close approach: bleed speed so we converge and bump rather than orbit.
      if (speed > 140)        controls.brake = true;
      else if (absErr < 1.3)  controls.up    = true;
    } else {
      // Open pursuit: accelerate when roughly aligned; creep forward when slow
      // so a car that's pointed wrong can still arc around (can't turn in place).
      if (absErr < 1.3 || speed < 110) controls.up = true;
      // Scrub speed before a sharp turn so the car can rotate — reads as driving.
      if (absErr > 0.8 && speed > 280) controls.brake = true;
    }

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
