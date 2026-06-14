// One-off: measure the REAL (drag-limited) top speed of the player vs a cop, by
// driving each car's Vehicle physics flat-out. Run: node sim/probe.mjs
import { register } from 'node:module';
register('./phaser-loader.mjs', import.meta.url);

const { Vehicle }   = await import('../src/entities/Vehicle.js');
const { PlayerCar } = await import('../src/entities/PlayerCar.js');
const { CopCar }    = await import('../src/entities/CopCar.js');
const { NavGrid }   = await import('../src/ai/NavGrid.js');

function makeSprite(x, y) {
  const body = { velocity: { x: 0, y: 0 },
    setVelocity(vx, vy) { this.velocity.x = vx; this.velocity.y = vy; return this; }, setSize() { return this; } };
  return { x, y, body, rotation: 0, vehicle: null,
    setVelocity(vx, vy) { body.velocity.x = vx; body.velocity.y = vy; return this; },
    setCollideWorldBounds() { return this; }, setBounce() { return this; },
    setRotation() { return this; }, setDisplaySize() { return this; },
    setDepth() { return this; }, setTint() { return this; }, setTintFill() { return this; } };
}
const scene = { physics: { add: { image: (x, y) => makeSprite(x, y) } } };
const nav = new NavGrid();

// Drive the raw Vehicle physics straight, flat throttle — bypass any AI.
function topSpeed(car) {
  const dt = 1 / 60, flat = { up: true, down: false, left: false, right: false, handbrake: false, brake: false };
  let top = 0;
  for (let s = 0; s < 25 / dt; s++) {
    Vehicle.prototype.update.call(car, dt * 1000, flat);
    top = Math.max(top, car.getSpeed());
  }
  return top;
}

const p = new PlayerCar(scene, 3000, 3000); p.facing = 0;
const c = new CopCar(scene, 3000, 3000, nav, null); c.facing = 0;
console.log(`player: maxSpeed cap ${p.maxSpeed}, accel ${p.acceleration}  ->  REAL top ${topSpeed(p).toFixed(0)} px/s`);
console.log(`cop:    maxSpeed cap ${c.maxSpeed}, accel ${c.acceleration}  ->  REAL top ${topSpeed(c).toFixed(0)} px/s`);
