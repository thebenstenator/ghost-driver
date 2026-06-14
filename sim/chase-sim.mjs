// Headless chase simulator.
//
// Runs the REAL game math (Vehicle drift physics for the evader, CopCar/CopAI for
// the cop, NavGrid, line-of-sight, the same city) with no rendering, and logs how
// the gap between cop and evader evolves. This lets us judge the *dynamic* of a
// chase from numbers instead of play-by-play:
//
//   gap flat for the whole run        -> "cruise" stalemate (the bug we're chasing)
//   gap collapses to 0 fast           -> cop is unfair / evader can't breathe
//   gap shrinks in corners, holds on
//     straights, opens when sight is
//     broken                          -> a real chase
//
// It does NOT judge game *feel*. It catches gross dynamics so we stop burning
// playtests on them. Limitation: no building collision — the scripted evader and
// the road-following cop stay on streets, so we don't need it.

import Phaser from 'phaser';
import { NavGrid } from '../src/ai/NavGrid.js';
import { CopCar } from '../src/entities/CopCar.js';
import { segmentClear } from '../src/ai/lineOfSight.js';
import { BUILDINGS } from '../src/world/city.js';
import { WORLD_WIDTH, WORLD_HEIGHT } from '../src/config.js';

// ── Fake Phaser scene / sprite ──────────────────────────────────────────────
// Just enough surface for Vehicle + CopCar constructors and update().
function makeSprite(x, y) {
  const body = {
    velocity: { x: 0, y: 0 },
    setVelocity(vx, vy) { this.velocity.x = vx; this.velocity.y = vy; return this; },
    setSize() { return this; },
  };
  return {
    x, y, body, rotation: 0, vehicle: null,
    setVelocity(vx, vy) { body.velocity.x = vx; body.velocity.y = vy; return this; },
    setCollideWorldBounds() { return this; },
    setBounce() { return this; },
    setRotation(r) { this.rotation = r; return this; },
    setDisplaySize() { return this; },
    setDepth() { return this; },
    setTint() { return this; },
    setTintFill() { return this; },
  };
}
const scene = { physics: { add: { image: (x, y) => makeSprite(x, y) } } };

// Step a car's position from its body velocity (the role Arcade Physics plays).
function integrate(car, dt) {
  car.sprite.x += car.sprite.body.velocity.x * dt;
  car.sprite.y += car.sprite.body.velocity.y * dt;
  car.sprite.x = Phaser.Math.Clamp(car.sprite.x, 16, WORLD_WIDTH - 16);
  car.sprite.y = Phaser.Math.Clamp(car.sprite.y, 16, WORLD_HEIGHT - 16);
}

// ── World ───────────────────────────────────────────────────────────────────
const nav   = new NavGrid();
const rects = BUILDINGS.map(b => new Phaser.Geom.Rectangle(b.x, b.y, b.w, b.h));
const node  = (i, j) => nav.pos(nav.index(i, j)); // road-intersection world pos

// How far a point is *inside* a building (0 = on a road). Lets the sim flag a cop
// that understeers across a corner into a wall — the collision the sim is blind to.
function buildingDepth(x, y) {
  let depth = 0;
  for (const b of BUILDINGS) {
    if (x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h) {
      depth = Math.max(depth, Math.min(x - b.x, b.x + b.w - x, y - b.y, b.y + b.h - y));
    }
  }
  return depth;
}

// ── Idealized evader ────────────────────────────────────────────────────────
// A kinematic stand-in for a *skilled* player: real position (so line-of-sight
// geometry is exact) but a clean speed profile — holds `straight` on open road,
// eases to `corner` through turns. Two numbers model player skill; we sweep them
// instead of trying to auto-drive the drift car well (itself a hard problem, and
// not what we're testing). Returns an object that quacks like a Vehicle enough
// for the perception + reporting code.
function makeEvader(x, y, facing) {
  return {
    sprite: { x, y },
    facing, vx: 0, vy: 0,
    getSpeed() { return Math.hypot(this.vx, this.vy); },
  };
}

// Turn angle (rad) at waypoint b coming from a, going to c.
function turnAt(a, b, c) {
  return Math.abs(Phaser.Math.Angle.Wrap(
    Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x)));
}

// Routes LOOP: reaching the last waypoint wraps back to the first, so the evader
// drives forever and we measure steady-state gap instead of it running out of road.
function stepEvader(ev, route, wpRef, dt, straight, corner) {
  const n = route.length;
  let wp = wpRef.v;
  if (Phaser.Math.Distance.Between(ev.sprite.x, ev.sprite.y, route[wp].x, route[wp].y) < 60) {
    wp = (wp + 1) % n; wpRef.v = wp;
  }
  const tgt = route[wp];

  // Desired speed: slow for the turn we're about to take at this waypoint.
  const prev = route[(wp - 1 + n) % n];
  const next = route[(wp + 1) % n];
  const t = Math.min(turnAt(prev, tgt, next) / (Math.PI / 2), 1);
  const near = Phaser.Math.Distance.Between(ev.sprite.x, ev.sprite.y, tgt.x, tgt.y) < 220;
  let desired = near ? Phaser.Math.Linear(straight, corner, t) : straight;

  // Ease current speed toward desired, head straight at the waypoint.
  const cur = ev.getSpeed();
  const spd = Phaser.Math.Linear(cur, desired, Math.min(1, dt * 4));
  const dx = tgt.x - ev.sprite.x, dy = tgt.y - ev.sprite.y, d = Math.hypot(dx, dy) || 1;
  ev.vx = (dx / d) * spd; ev.vy = (dy / d) * spd;
  ev.facing = Math.atan2(dy, dx);
  ev.sprite.x += ev.vx * dt; ev.sprite.y += ev.vy * dt;
}

// ── Perception (mirrors GameScene) ──────────────────────────────────────────
const PROXIMITY = 250, SIGHT = 900, SEARCH_SPEED = 250, CATCH = 50;
const AWARE_GRACE = 0.6;  // keep "seeing" this long after sight actually breaks
const HUNT = 10;          // after losing sight, charge last-known at full speed this long
function canSee(cop, player) {
  const d = Phaser.Math.Distance.Between(cop.sprite.x, cop.sprite.y, player.sprite.x, player.sprite.y);
  if (d <= PROXIMITY) return true;
  if (d <= SIGHT) return segmentClear(cop.sprite.x, cop.sprite.y, player.sprite.x, player.sprite.y, rects);
  return false;
}

// ── One scenario ────────────────────────────────────────────────────────────
// skill = { straight, corner } evader speeds (px/s). copSpeed overrides cop top speed.
function run(name, route, skill, copSpeed = 590, copBackPx = 700, seconds = 26) {
  const h0 = Math.atan2(route[1].y - route[0].y, route[1].x - route[0].x);
  const ev = makeEvader(route[0].x, route[0].y, h0);
  ev.vx = Math.cos(h0) * skill.straight; ev.vy = Math.sin(h0) * skill.straight;

  // Cop starts copBackPx behind, on the road, facing the player.
  const cop = new CopCar(scene, route[0].x - Math.cos(h0) * copBackPx,
                                route[0].y - Math.sin(h0) * copBackPx, nav, rects);
  cop.facing = h0;
  cop.maxSpeed = cop.baseMaxSpeed = copSpeed;
  cop.ai.maxApproachSpeed = cop.ai.baseApproach = copSpeed + 20;

  const dt = 1 / 60;
  const wpRef = { v: 1 };
  const samples = []; // {t, gap, ps, cs, aware}
  let lastKnown = { x: ev.sprite.x, y: ev.sprite.y };
  let caughtAt = null, noSightStreak = 0, maxNoSight = 0;
  let awareTimer = AWARE_GRACE; // sight memory
  let lostFor = 0;              // seconds since truly aware (drives hunt -> search)
  let maxClip = 0, clipFrames = 0; // cop-into-building tracking (steering quality)

  for (let step = 0; step < seconds / dt; step++) {
    const t = step * dt;

    stepEvader(ev, route, wpRef, dt, skill.straight, skill.corner);

    // Perception with grace: aware persists AWARE_GRACE seconds past actual sight.
    const rawSees = canSee(cop, ev);
    if (rawSees) awareTimer = AWARE_GRACE; else awareTimer -= dt;
    const aware = awareTimer > 0;

    // Out-of-sight bookkeeping (true LOS, for the ditch verdict)
    if (rawSees) { noSightStreak = 0; } else { noSightStreak += dt; maxNoSight = Math.max(maxNoSight, noSightStreak); }

    let target;
    if (aware) {
      lastKnown = { x: ev.sprite.x, y: ev.sprite.y };
      lostFor = 0;
      cop.ai.speedCap = Infinity;          // full chase
      cop.ai.arriveEase = false;           // ram the player, don't settle into a cruise
      target = { x: ev.sprite.x, y: ev.sprite.y };
    } else {
      lostFor += dt;
      // HUNT: charge the last-known at full speed; then downshift to a slow search.
      cop.ai.speedCap = lostFor < HUNT ? Infinity : SEARCH_SPEED;
      cop.ai.arriveEase = true;            // settle onto the (stationary) last-known point
      target = lastKnown;
    }

    cop.update(dt * 1000, target);
    integrate(cop, dt);

    const clip = buildingDepth(cop.sprite.x, cop.sprite.y);
    if (clip > 0) { clipFrames++; maxClip = Math.max(maxClip, clip); }

    const gap = Phaser.Math.Distance.Between(cop.sprite.x, cop.sprite.y, ev.sprite.x, ev.sprite.y);
    // Only a real catch if the evader is still actively fleeing (not stopped at a corner).
    if (gap < CATCH && ev.getSpeed() > 150 && caughtAt === null) caughtAt = t;
    if (step % Math.round(0.5 / dt) === 0) {
      samples.push({ t, gap, ps: ev.getSpeed(), cs: cop.getSpeed(), sees: aware });
    }
  }

  const clipPct = Math.round(100 * clipFrames / (seconds / dt));
  report(name, samples, caughtAt, maxNoSight, { maxClip, clipPct });
}

// ── Reporting ───────────────────────────────────────────────────────────────
function report(name, s, caughtAt, maxNoSight, clip) {
  const gaps = s.map(x => x.gap);
  const min = Math.min(...gaps), max = Math.max(...gaps);
  const start = gaps[0], end = gaps[gaps.length - 1];

  // Sparkline of the gap over time
  const blocks = '▁▂▃▄▅▆▇█';
  const spark = gaps.map(g => blocks[Math.min(7, Math.floor((g - min) / ((max - min) || 1) * 7.999))]).join('');

  let verdict;
  if (caughtAt !== null) verdict = `CAUGHT at ${caughtAt.toFixed(1)}s`;
  else if (max - min < 80) verdict = 'CRUISE / STALEMATE (gap barely moves)';
  else if (end > start * 1.4) verdict = 'EVADER PULLING AWAY';
  else if (end < start * 0.6) verdict = 'COP CLOSING';
  else verdict = 'OSCILLATING CHASE';

  const avgPs = s.reduce((a, x) => a + x.ps, 0) / s.length;
  const avgCs = s.reduce((a, x) => a + x.cs, 0) / s.length;
  const seenPct = Math.round(100 * s.filter(x => x.sees).length / s.length);

  console.log(`\n=== ${name} ===`);
  console.log(`gap ${spark}`);
  console.log(`    start ${start.toFixed(0)}  min ${min.toFixed(0)}  max ${max.toFixed(0)}  end ${end.toFixed(0)} (px)`);
  console.log(`    avg speed  evader ${avgPs.toFixed(0)}  cop ${avgCs.toFixed(0)} (px/s)   in sight ${seenPct}% of run`);
  console.log(`    longest out-of-sight ${maxNoSight.toFixed(1)}s   ->  ${verdict}`);
  const clipNote = clip.clipPct === 0 ? 'clean (cop never clipped a building)'
                                      : `CLIPPED buildings ${clip.clipPct}% of frames, max ${clip.maxClip.toFixed(0)}px deep`;
  console.log(`    steering: ${clipNote}`);
}

// ── Routes (looping lists of road intersections) ────────────────────────────
// Grid interior nodes are i,j in 0..(cols-1).

// Big perimeter loop: long straights with a corner only every ~8 blocks. Models
// sustained open-road driving — the test of straight-line speed balance.
const loop = [];
for (let i = 1; i <= 9; i++) loop.push(node(i, 1));
for (let j = 2; j <= 9; j++) loop.push(node(9, j));
for (let i = 8; i >= 1; i--) loop.push(node(i, 9));
for (let j = 8; j >= 2; j--) loop.push(node(1, j));

// Zigzag: a 90° turn at every single block — heavy cornering / constant sight-breaks.
const corners = [];
{ let i = 1, j = 4; for (let k = 0; k < 4; k++) { corners.push(node(i, j)); i++; corners.push(node(i, j)); j++; }
  corners.push(node(i, j)); }

// Run a few blocks, juke around one block to break sight, then continue — repeats.
const losBreak = [node(1, 5), node(3, 5), node(5, 5), node(5, 7), node(3, 7), node(3, 5), node(1, 5), node(1, 7)];

// Skilled player: actual sustained top speed (the player's 600 maxSpeed is
// theoretical — drag pulls real top speed to ~440), sheds a lot in 90° turns.
// NOTE: the cop is NOT drag-affected, so its maxSpeed IS its real top speed —
// compare cop speeds to this 440, not to the player's nominal 600.
const SKILL = { straight: 440, corner: 190 };

console.log('Ghost Driver — headless chase sim');
console.log(`(real CopAI vs idealized evader straight ${SKILL.straight} / corner ${SKILL.corner}; gap px over ~26s)`);

for (const copSpeed of [460, 420, 380]) {
  console.log(`\n############ COP TOP SPEED ${copSpeed} (player straights ${SKILL.straight}) ############`);
  run('OPEN ROAD (perimeter loop)', loop, SKILL, copSpeed, 700, 40);
  run('CORNERS (zigzag)', corners, SKILL, copSpeed, 700, 40);
  run('LOS BREAK (juke a block)', losBreak, SKILL, copSpeed, 700, 40);
}
