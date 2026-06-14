# Headless chase sim

Runs the **real** game math — `CopCar`/`CopAI`, `NavGrid`, line-of-sight, the same
city from `src/world/city.js` — with no browser/rendering, and prints how the gap
between cop and evader evolves. It exists so cop-chase *dynamics* can be judged from
numbers instead of play-by-play.

```
npm run sim
```

## How it works

- `phaser` is browser-only, so `phaser-loader.mjs` aliases every `import 'phaser'`
  to `phaser-shim.mjs` (a faithful port of the few `Phaser.Math` / `Phaser.Geom`
  calls the game logic uses). The real game modules import unchanged → no drift.
- The cop is the real `CopCar`/`CopAI`. The evader is an **idealized skilled
  player**: kinematic, real position (so line-of-sight is exact), with a tunable
  `{ straight, corner }` speed profile. Two numbers model player skill — we sweep
  them instead of auto-driving the drift car well (itself a hard problem, and not
  what we're testing).
- `chase-sim.mjs` mirrors GameScene's perception (proximity + sight + `awareGrace`)
  and the hunt→search downshift, then logs gap-over-time per scenario.

## Reading the output

A sparkline of the gap (px) over the run, plus avg speeds, % in sight, longest
out-of-sight streak, and a verdict:

- `CRUISE / STALEMATE` — gap barely moves (the speed-matched bug)
- `CAUGHT` — cop reaches the evader while it's still fleeing
- `EVADER PULLING AWAY` — a real ditch
- `OSCILLATING CHASE` — gap swings but neither resolves

## What it does NOT do

Judge *feel*. No building collision (scripted evader + road-following cop stay on
streets). It catches gross dynamics; the browser is still the final word on feel.

## Key finding

Cop **top speed** is the master difficulty dial. Equal/faster than the player ⇒
unditchable (the cop reels you in through corners no matter what). Slightly slower ⇒
open road becomes a real escape valve. See `cop-tuning-pattern` memory.
