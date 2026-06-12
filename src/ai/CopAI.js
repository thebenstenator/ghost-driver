import Phaser from 'phaser';

// Drives a cop Vehicle toward the player along the road network.
//
// Behaviours (milestone 1):
//  - Pathfind over the NavGrid (BFS) and steer toward the next intersection
//    waypoint, so the cop follows streets instead of beelining through buildings.
//  - Stuck detection + reverse recovery: if it wedges against a building it
//    backs off and reorients instead of grinding the wall forever.
//  - Approach control: as it closes on the player it bleeds speed so it actually
//    makes contact instead of orbiting at speed.
export class CopAI {
  constructor(navGrid) {
    this.nav = navGrid;
    this.steerDeadzone = 0.05; // rad — avoid left/right jitter when nearly aligned
    this.directRange   = 150;  // within this, aim straight at the player

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

    // --- Choose a steering target: a road waypoint, or the player directly ---
    let aimX = target.x, aimY = target.y;
    if (dist > this.directRange) {
      const copNode    = this.nav.nearestNode(cx, cy);
      const playerNode = this.nav.nearestNode(target.x, target.y);
      const path       = this.nav.findPath(copNode, playerNode);
      if (path.length >= 2) {
        const wp = this.nav.pos(path[1]); // next intersection toward the player
        aimX = wp.x; aimY = wp.y;
      }
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
}
