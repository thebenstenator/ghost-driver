// Bust meter — the lose condition, mirror of the ditch.
//
// Fills while the player is "pinned" (a cop right on them AND moving slowly —
// i.e. boxed in or stopped) and drains while they're free and fast. At 100% the
// player is busted. This rewards keeping momentum: a glancing ram at speed barely
// registers, but getting cornered to a stop is lethal — you outdrive the cops,
// you don't tank them.
export class BustMeter {
  constructor({ pinDistance = 60, pinSpeed = 130, fillRate = 45, drainRate = 70 } = {}) {
    this.pinDistance = pinDistance; // px — a cop this close counts as "on you"
    this.pinSpeed    = pinSpeed;    // below this speed (px/s) you're pinnable
    this.fillRate    = fillRate;    // meter/sec while pinned (100 / fillRate ≈ secs to bust)
    this.drainRate   = drainRate;   // meter/sec while free
    this.value       = 0;           // 0..100
    this.pinned      = false;
  }

  update(pinned, dt) {
    this.pinned = pinned;
    this.value += (pinned ? this.fillRate : -this.drainRate) * dt;
    this.value = Math.max(0, Math.min(100, this.value));
    return this.value;
  }

  get isBusted() { return this.value >= 100; }

  reset() { this.value = 0; this.pinned = false; }
}
