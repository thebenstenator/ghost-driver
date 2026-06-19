// Bust meter — the lose condition, mirror of the ditch.
//
// Fills while the player is "pinned" (a cop right on them AND moving slowly —
// i.e. boxed in or stopped) and drains while they're free and fast. At 100% the
// player is busted. This rewards keeping momentum: a glancing ram at speed barely
// registers, but getting cornered to a stop is lethal — you outdrive the cops,
// you don't tank them.
//
// The fill rate SCALES with how many cops are crowding you: one cop holding you is a
// slow burn you can usually wriggle out of; a full swarm boxing you in busts you fast.
export class BustMeter {
  constructor({ pinDistance = 60, pinSpeed = 130, surroundRange = 120,
                fillBase = 14, fillPerCop = 11, fillMax = 70, drainRate = 70 } = {}) {
    this.pinDistance   = pinDistance;   // px — a cop this close counts as "on you" (triggers the pin)
    this.pinSpeed      = pinSpeed;      // below this speed (px/s) you're pinnable
    this.surroundRange = surroundRange; // px — cops within this of you count toward the fill rate
    this.fillBase      = fillBase;      // meter/sec with ONE cop on you (slow burn)
    this.fillPerCop    = fillPerCop;    // + meter/sec for each ADDITIONAL crowding cop
    this.fillMax       = fillMax;       // cap on the fill rate (a big swarm can't fill instantly)
    this.drainRate     = drainRate;     // meter/sec while free
    this.value         = 0;             // 0..100
    this.pinned        = false;
  }

  // pinned: is a cop on you + you're slow. pinCount: cops within surroundRange (the crowd
  // that sets how fast it fills). When not pinned, drains regardless of count.
  update(pinned, pinCount, dt) {
    this.pinned = pinned;
    if (pinned) {
      const rate = Math.min(this.fillMax, this.fillBase + this.fillPerCop * Math.max(0, pinCount - 1));
      this.value += rate * dt;
    } else {
      this.value -= this.drainRate * dt;
    }
    this.value = Math.max(0, Math.min(100, this.value));
    return this.value;
  }

  get isBusted() { return this.value >= 100; }

  reset() { this.value = 0; this.pinned = false; }
}
