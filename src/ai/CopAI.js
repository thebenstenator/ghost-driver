import Phaser from 'phaser';
import { segmentClear } from './lineOfSight.js';

// Cop "driver" — kinematic, not a simulated car.
//
// We don't pilot a momentum/grip car with fake inputs anymore (that was the
// source of every crash and the pile of corrective rules). Instead this just
// answers: where should the cop move toward, and how fast?
//
//   • If the cop has a clear line to its target → move straight at it.
//   • Otherwise → follow the BFS road path one intersection at a time (aim at the
//     next node, advance when reached). Adjacent nodes share a clear street, so
//     the cop can never aim through a building, never cut a corner, never wedge.
//   • Speed eases down for corners ahead.
//
// CopCar applies the result as a direct velocity, so the cop rides the roads
// exactly. No steering / braking / grip / reverse / stuck logic to go wrong.
export class CopAI {
  constructor(navGrid, rects = null) {
    this.nav   = navGrid;
    this.rects = rects;

    this.directRange      = 55;  // aim straight at the target only with clear LOS, OR when
                                 // this close (≈ same road segment). Keep small: a large value
                                 // lets the cop beeline THROUGH a corner building toward a
                                 // player just around it.
    this.arriveRadius     = 42;  // px to count a path node as reached. Small so the cop
                                 // gets to the corner before it starts turning to the next
                                 // node (large values let it cut the inside of the corner).
    this.maxApproachSpeed = 610; // top travel speed (capped further by CopCar.maxSpeed)
    this.baseApproach     = 610; // base top travel speed
    this.slowRadius       = 160; // start easing speed when this close to a STATIONARY target
    this.slowFloor        = 0.35;// fraction of speed kept right on top of a stationary target
    this.arriveEase       = true;// true: ease onto STATIONARY targets (search pts, station).
                                 // false (set while chasing the player): charge to the player's
                                 // BUMPER (standoff) at full speed instead of settling into a
                                 // speed-matched "cruise" — but DON'T drive at their centre and
                                 // bulldoze them through a wall.
    this.standoff         = 36;  // px short of the player the chasing cop aims for (≈ bumpers)
    this.cornerMinSpeed   = 140; // speed through a 90°+ corner (must be slow enough that
                                 // CopCar's turn radius fits the corner without clipping).
                                 // Now also the floor speed while CHASING through a turn.
    this.chaseTurnCut     = 1.0; // rad of heading swing (to keep tracking you) that drops
                                 // chase speed all the way to cornerMinSpeed. THIS is what
                                 // makes your corners cost the cop while it can see you —
                                 // smaller = it bleeds more speed in turns = more ditchable.
    this.brakeDecel       = 320; // shapes how early speed eases down before a corner
    this.senseDist        = 700; // how far down the path to look for corners
    this.speedCap         = Infinity; // external cap (lowered during search/withdraw)

    this._path     = null;
    this._goalNode = -1;
    this._wpIndex  = 0;
  }

  // Returns { aim:{x,y}, speed } — where to head and how fast.
  getControls(cop, target) {
    const cx = cop.sprite.x, cy = cop.sprite.y;
    const dist = Phaser.Math.Distance.Between(cx, cy, target.x, target.y);
    let aim = { x: target.x, y: target.y };
    let speed = Math.min(this.maxApproachSpeed, this.speedCap);
    let nextTurn = 0, mode = 'CHASE';

    const clear = !this.rects || segmentClear(cx, cy, target.x, target.y, this.rects);
    if (!clear && dist > this.directRange) {
      mode = 'PATH';
      const copNode  = this.nav.nearestNode(cx, cy);
      const goalNode = this.nav.nearestNode(target.x, target.y);
      if (!this._path || goalNode !== this._goalNode) {
        this._path = this.nav.findPath(copNode, goalNode);
        this._goalNode = goalNode;
        this._wpIndex = this._path.length > 1 ? 1 : 0; // path[0] is where we already are
      }
      let wp = this.nav.pos(this._path[this._wpIndex]);
      if (Phaser.Math.Distance.Between(cx, cy, wp.x, wp.y) < this.arriveRadius &&
          this._wpIndex < this._path.length - 1) {
        this._wpIndex++;
        wp = this.nav.pos(this._path[this._wpIndex]);
      }
      aim = wp;

      const pts = this._path.map(n => this.nav.pos(n));
      pts.push({ x: target.x, y: target.y });
      const lim = this._speedLimit(pts, cx, cy, speed);
      speed = lim.speed; nextTurn = lim.turn;
    } else {
      this._path = null; this._goalNode = -1; // re-plan fresh next time we lose sight

      if (this.arriveEase) {
        // Stationary target (search point / station): ease speed down as we close
        // so we settle onto it instead of blasting past and oscillating.
        if (dist < this.slowRadius) {
          const t = Phaser.Math.Clamp(dist / this.slowRadius, this.slowFloor, 1);
          speed *= t;
        }
      } else {
        // Chasing the player: aim for their BUMPER, not their centre. Full speed
        // right up to the standoff point (CopCar's deadzone then stops us there),
        // so we pin/ram without trying to occupy their body and shove them through
        // a building. Once at the bumper we tailgate as they move.
        const back = Math.min(this.standoff, dist);
        const ux = (target.x - cx) / (dist || 1), uy = (target.y - cy) / (dist || 1);
        aim = { x: target.x - ux * back, y: target.y - uy * back };

        // Corner cost WHILE chasing: if keeping you in our sights needs a hard
        // heading swing (you just cornered/juked), bleed speed toward cornerMinSpeed.
        // Without this the cop tracks every turn at full speed (the homing-missile
        // feel); with it, skilled cornering opens a gap it has to claw back.
        const desiredHeading = Math.atan2(aim.y - cy, aim.x - cx);
        const turnNeeded = Math.abs(Phaser.Math.Angle.Wrap(desiredHeading - cop.heading));
        const tt = Math.min(turnNeeded / this.chaseTurnCut, 1);
        speed = Phaser.Math.Linear(speed, Math.min(this.cornerMinSpeed, speed), tt);
        nextTurn = turnNeeded;
      }
    }

    const moveSpeed = Math.min(speed, cop.maxSpeed); // what we'll actually travel at
    cop.debug = { mode, speed: moveSpeed, dist, bend: nextTurn, cornerLimit: moveSpeed, angleErr: 0, reverseTime: 0 };
    return { aim, speed };
  }

  // Ease speed down for the sharpest corner ahead within senseDist.
  _speedLimit(pts, x, y, baseCap) {
    const { seg } = this._closest(pts, x, y);
    let limit = baseCap, sharpest = 0;
    let acc = Phaser.Math.Distance.Between(x, y, pts[seg + 1].x, pts[seg + 1].y);
    for (let i = seg + 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      const turn = Math.abs(Phaser.Math.Angle.Wrap(
        Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x)));
      const t  = Math.min(turn / (Math.PI / 2), 1);
      const vC = Phaser.Math.Linear(baseCap, this.cornerMinSpeed, t);
      const allowed = Math.sqrt(vC * vC + 2 * this.brakeDecel * Math.max(acc, 0));
      if (allowed < limit) limit = allowed;
      if (turn > sharpest) sharpest = turn;
      acc += Phaser.Math.Distance.Between(b.x, b.y, c.x, c.y);
      if (acc > this.senseDist) break;
    }
    return { speed: limit, turn: sharpest };
  }

  // Closest point on the polyline to (x,y): segment index.
  _closest(pts, x, y) {
    let seg = 0, best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const abx = b.x - a.x, aby = b.y - a.y;
      const len2 = abx * abx + aby * aby || 1e-6;
      let t = ((x - a.x) * abx + (y - a.y) * aby) / len2;
      t = Math.max(0, Math.min(1, t));
      const qx = a.x + abx * t, qy = a.y + aby * t;
      const dx = x - qx, dy = y - qy, dd = dx * dx + dy * dy;
      if (dd < best) { best = dd; seg = i; }
    }
    return { seg };
  }
}
