import Phaser from 'phaser';
import { Vehicle } from './Vehicle.js';
import { CopAI } from '../ai/CopAI.js';

// A pursuing cop car. It reuses Vehicle only for the sprite + collision body —
// it does NOT use the drift physics. Cops move KINEMATICALLY: each frame the AI
// says where to head and how fast, and we set the body's velocity straight at it.
// That makes them ride the road network exactly (no momentum/grip to wash them
// into walls), while the collision body still lets them ram the player.
//
// ── HOW TO TUNE A COP ──────────────────────────────────────────────────────
// Cop top speed → `maxSpeed` in the stats below. Everything else about how they
// drive (corner speed, look-ahead, pathing) lives in CopAI's constructor. The
// grip/turn/drift stats are unused (cops aren't simulated cars).
// ───────────────────────────────────────────────────────────────────────────
export class CopCar extends Vehicle {
  constructor(scene, x, y, navGrid, rects = null) {
    super(scene, x, y, {
      texture: 'player_car',
      displayWidth: 38,
      displayHeight: 60,
      bodySize: 30,
      depth: 9,
      tint: 0xffffff,   // flat white silhouette so cops pop against the dark map
      tintFill: true,
      stats: {
        maxSpeed: 590, // top travel speed (just under the player's 600)
      },
    });

    this.ai = new CopAI(navGrid, rects);
    this.aiTarget = { x, y };           // current aim point, for debug draw
    this.baseMaxSpeed = this.maxSpeed;  // catch-up rubber-band raises maxSpeed above this when far
  }

  // target: { x, y } in world space (player / last-known / station). null = stand down.
  update(delta, target) {
    const body = this.sprite.body;
    if (!target) {
      body.setVelocity(0, 0);
      this.vx = this.vy = 0;
      this.aiTarget = null;
      this.debug = { mode: 'STANDDOWN', speed: 0, dist: 0, bend: 0, cornerLimit: 0, angleErr: 0, reverseTime: 0 };
      return;
    }

    const { aim, speed } = this.ai.getControls(this, target);
    this.aiTarget = aim;

    // Kinematic move: velocity straight at the aim, capped by our (catch-up) top speed.
    const dx = aim.x - this.sprite.x, dy = aim.y - this.sprite.y;
    const d  = Math.hypot(dx, dy) || 1;
    const v  = Math.min(speed, this.maxSpeed);
    this.vx = (dx / d) * v;
    this.vy = (dy / d) * v;
    body.setVelocity(this.vx, this.vy);

    // Face travel direction (quick turn so it reads as cornering, not snapping).
    if (v > 1) {
      const targetAng = Math.atan2(this.vy, this.vx);
      this.facing = Phaser.Math.Angle.RotateTo(this.facing, targetAng, 0.4);
      this.sprite.setRotation(this.facing + Math.PI / 2);
    }
  }
}
