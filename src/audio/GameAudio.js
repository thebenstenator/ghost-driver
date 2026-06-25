// Procedural game audio — no sound files. Borrows Phaser's WebAudio AudioContext
// (this.sound.context) and synthesizes everything from oscillators + noise + filters.
//
//   • Engine — detuned sawtooths + a sine sub through a lowpass; pitch/cutoff/volume
//     track the player's speed and throttle. One persistent voice, updated per frame.
//   • Sirens — a pool of two-tone "wail" voices (an LFO sweeping a square carrier),
//     panned + attenuated by each cop's position relative to the player. The nearest
//     few chasing cops get a voice; the rest are silent.
//
// Everything runs through a master gain + compressor (glue / clip safety). The context
// starts suspended until a user gesture, so we resume on the first input.
const SIREN_VOICES = 4;        // max simultaneous audible sirens (nearest cops win)
const SIREN_FALLOFF = 1100;    // px at which a siren fades to silent
const SIREN_PAN_RANGE = 900;   // px lateral offset that maps to full L/R pan

// Real sirens cycle through modes rather than holding one pattern. Each segment sets the
// sweep RATE (Hz — how fast the pitch rises/falls), DEPTH (Hz — how far it sweeps), and
// CENTER (Hz — the base pitch). FASTER PACE = HIGHER PITCH: wail is slow + low, yelp is
// fast + notably higher. The cycle alternates wail → yelp. Voices are phase-offset so the
// pack desyncs (one car wails while another yelps).
const SIREN_CYCLE = [
  { dur: 6.0, rate: 0.28, depth: 320, center: 780 },  // wail   — slow; same ~460 floor, sweeps up near yelp (~1100)
  { dur: 4.0, rate: 3.3,  depth: 240, center: 1120 }, // yelp   — fast + higher
];
const SIREN_CYCLE_LEN = SIREN_CYCLE.reduce((s, seg) => s + seg.dur, 0);
function sirenMode(t) {
  let x = ((t % SIREN_CYCLE_LEN) + SIREN_CYCLE_LEN) % SIREN_CYCLE_LEN;
  for (const seg of SIREN_CYCLE) {
    if (x < seg.dur) return seg;
    x -= seg.dur;
  }
  return SIREN_CYCLE[0];
}

export class GameAudio {
  constructor(scene, { masterVolume = 0.55 } = {}) {
    this.scene = scene;
    this.muted = false;
    // Live-tunable mix (bound by the car panel). Set BEFORE the no-audio bail so the
    // panel can bind to these fields even when WebAudio is unavailable (setters no-op).
    this.masterVolume = masterVolume;
    this.engineVol = 1; // multiplier on engine gain
    this.sirenVol = 1;  // multiplier on siren gain
    const ctx = scene.sound && scene.sound.context;
    // No WebAudio (HTML5/NoAudio fallback) → every method becomes a safe no-op.
    if (!ctx || typeof ctx.createOscillator !== "function") {
      this.ctx = null;
      return;
    }
    this.ctx = ctx;

    // Master bus: gain → compressor → speakers.
    this.master = ctx.createGain();
    this.master.gain.value = this.masterVolume;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp);
    comp.connect(ctx.destination);

    this._buildEngine();
    this._buildSirens();
    this._resumeOnGesture();
  }

  // ── Engine ────────────────────────────────────────────────────────────────
  // Not a pitched tone (that reads as synth-bass/techno) — a NOISE bed chopped into
  // firing pulses. An LFO amplitude-modulates filtered noise; its rate is the firing
  // rate, so the engine "revs" (chuffs blur into a roar) instead of playing a melody.
  _buildEngine() {
    const ctx = this.ctx;

    // 2s of looping white noise — the mechanical rush/grit.
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;

    const noiseLP = ctx.createBiquadFilter();
    noiseLP.type = "lowpass";
    noiseLP.frequency.value = 600;
    noiseLP.Q.value = 0.7; // no resonance → no whistle/synth character

    // Amplitude modulation = cylinder firing. Sawtooth LFO gives each chuff a sharp
    // attack; am.gain swings around 0.5 by ±lfoGain at the firing rate.
    const am = ctx.createGain();
    am.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.type = "sawtooth";
    lfo.frequency.value = 24;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.5;
    lfo.connect(lfoGain);
    lfoGain.connect(am.gain);

    // Quiet low body for weight — tracks the firing rate (not a separate bassline),
    // heavily lowpassed so it's felt, not heard as a note.
    const body = ctx.createOscillator();
    body.type = "triangle";
    body.frequency.value = 48;
    const bodyG = ctx.createGain();
    bodyG.gain.value = 0.12;
    const bodyLP = ctx.createBiquadFilter();
    bodyLP.type = "lowpass";
    bodyLP.frequency.value = 200;

    const g = ctx.createGain();
    g.gain.value = 0.0001; // silent until updated (and until context resumes)

    noise.connect(noiseLP); noiseLP.connect(am); am.connect(g);
    body.connect(bodyLP); bodyLP.connect(bodyG); bodyG.connect(g);
    g.connect(this.master);

    noise.start(); lfo.start(); body.start();
    this.engine = { g, noise, noiseLP, am, lfo, lfoGain, body };
  }

  // speed/maxSpeed → firing rate (rev) + brightness; throttle adds load. Smoothed.
  updateEngine(speed, maxSpeed, throttle) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const frac = Math.max(0, Math.min(1, speed / (maxSpeed || 1)));
    const fire = 22 + Math.pow(frac, 0.9) * 150; // firing rate (Hz): idle putter → revving roar
    const { g, noiseLP, lfo, lfoGain, body } = this.engine;
    lfo.frequency.setTargetAtTime(fire, now, 0.05);
    body.frequency.setTargetAtTime(fire, now, 0.05);
    noiseLP.frequency.setTargetAtTime(500 + frac * 3000 + (throttle ? 500 : 0), now, 0.06);
    // Deep chug at idle; less modulation at speed so the chuffs smooth into a roar.
    lfoGain.gain.setTargetAtTime(0.55 - frac * 0.3, now, 0.1);
    const vol = this.muted ? 0.0001 : (0.05 + frac * 0.085 + (throttle ? 0.015 : 0)) * this.engineVol;
    g.gain.setTargetAtTime(vol, now, 0.08);
  }

  // ── Sirens ────────────────────────────────────────────────────────────────
  _buildSirens() {
    const ctx = this.ctx;
    this.sirens = [];
    for (let i = 0; i < SIREN_VOICES; i++) {
      const carrier = ctx.createOscillator();
      carrier.type = "square";
      const detune = i * 30; // per-voice offset so voices don't phase-lock into one tone
      carrier.frequency.value = SIREN_CYCLE[0].center + detune;

      // LFO sweeps the carrier around its center. Rate + depth (and the carrier center)
      // are re-driven each frame from the mode schedule (wail/yelp).
      const lfo = ctx.createOscillator(); lfo.type = "triangle"; lfo.frequency.value = SIREN_CYCLE[0].rate;
      const lfoGain = ctx.createGain(); lfoGain.gain.value = SIREN_CYCLE[0].depth;
      lfo.connect(lfoGain); lfoGain.connect(carrier.frequency);

      // Tame the square's harshness a touch.
      const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2600;
      const g = ctx.createGain(); g.gain.value = 0.0001;
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;

      carrier.connect(lp); lp.connect(g);
      if (pan) { g.connect(pan); pan.connect(this.master); }
      else g.connect(this.master);

      carrier.start(); lfo.start();
      // phase: where this voice sits in the mode cycle, spread evenly so the pack desyncs.
      this.sirens.push({ g, pan, carrier, detune, lfo, lfoGain, phase: (i / SIREN_VOICES) * SIREN_CYCLE_LEN });
    }
  }

  // active: pursuit is making noise (ACTIVE/SEARCH). Assign the nearest chasing cops to
  // the voice pool; pan + attenuate each by its offset from the player; silence the rest.
  updateSirens(player, cops, active) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const px = player.x, py = player.y;
    // Nearest cops first (only the closest SIREN_VOICES are audible).
    const near = active
      ? [...cops]
          .filter((c) => !c.disabled)
          .sort(
            (a, b) =>
              (a.sprite.x - px) ** 2 + (a.sprite.y - py) ** 2 -
              ((b.sprite.x - px) ** 2 + (b.sprite.y - py) ** 2),
          )
          .slice(0, SIREN_VOICES)
      : [];
    for (let i = 0; i < this.sirens.length; i++) {
      const v = this.sirens[i];
      const cop = near[i];
      let gain = 0.0001;
      if (cop && !this.muted) {
        const dx = cop.sprite.x - px, dy = cop.sprite.y - py;
        const dist = Math.hypot(dx, dy);
        const atten = Math.max(0, 1 - dist / SIREN_FALLOFF);
        gain = Math.max(0.0001, 0.077 * atten * atten * this.sirenVol); // 0.077 = baked siren mix 0.7
        if (v.pan)
          v.pan.pan.setTargetAtTime(
            Math.max(-1, Math.min(1, dx / SIREN_PAN_RANGE)),
            now,
            0.08,
          );
        // Advance this voice through the wail/yelp cycle. The 0.3s smoothing makes
        // mode changes "spin up/down" (rate, depth AND center pitch ramp) rather than snapping.
        const m = sirenMode(now + v.phase);
        v.lfo.frequency.setTargetAtTime(m.rate, now, 0.3);
        v.lfoGain.gain.setTargetAtTime(m.depth, now, 0.3);
        v.carrier.frequency.setTargetAtTime(m.center + v.detune, now, 0.3);
      }
      v.g.gain.setTargetAtTime(gain, now, 0.1);
    }
  }

  // "Found again" alert — a modulated fire-engine AIR-HORN blast fired when a cop re-spots
  // the player during the post-ditch cooldown (the oh-crap moment). Two saws a third apart
  // give the brassy dual-tone "BLAAT"; a vibrato LFO adds the wobble/modulation. `pan` places
  // it on the spotting cop so it sits IN the mix, not separate. One-shot; 1.2s self-cooldown.
  playSpotted(pan = 0) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, now = ctx.currentTime;
    if (now < (this._spottedUntil || 0)) return;
    this._spottedUntil = now + 1.2;
    const dur = 0.62;

    // Dual-tone air horn: two saws ~a major third apart → the recognizable brassy chord.
    const o1 = ctx.createOscillator(); o1.type = "sawtooth"; o1.frequency.value = 330;
    const o2 = ctx.createOscillator(); o2.type = "sawtooth"; o2.frequency.value = 415;

    // Vibrato modulation — a small fast wobble on both tones so the blast has life.
    const vib = ctx.createOscillator(); vib.type = "sine"; vib.frequency.value = 5.5;
    const vibGain = ctx.createGain(); vibGain.gain.value = 10; // Hz depth
    vib.connect(vibGain); vibGain.connect(o1.frequency); vibGain.connect(o2.frequency);

    // Lowpass for body (keeps it a horn, not a buzz).
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2200; lp.Q.value = 0.7;
    const g = ctx.createGain(); g.gain.value = 0.0001;
    const pn = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    o1.connect(lp); o2.connect(lp); lp.connect(g);
    if (pn) { pn.pan.value = Math.max(-1, Math.min(1, pan)); g.connect(pn); pn.connect(this.master); }
    else g.connect(this.master);

    // Punch in, sustain the blast, quick release.
    const peak = 0.32;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(peak, now + 0.025);
    g.gain.setValueAtTime(peak, now + dur - 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    o1.start(now); o2.start(now); vib.start(now);
    o1.stop(now + dur + 0.02); o2.stop(now + dur + 0.02); vib.stop(now + dur + 0.02);
  }

  setMuted(m) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0.0001 : this.masterVolume, this.ctx.currentTime, 0.05);
  }

  setMasterVolume(v) {
    this.masterVolume = v;
    if (this.ctx && !this.muted) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  // Context boots suspended (autoplay policy). Phaser unlocks on input too, but resume
  // ourselves on the first gesture to be safe.
  _resumeOnGesture() {
    if (!this.ctx) return;
    const resume = () => { if (this.ctx.state === "suspended") this.ctx.resume(); };
    this.scene.input.once("pointerdown", resume);
    this.scene.input.keyboard.once("keydown", resume);
  }

  destroy() {
    if (!this.ctx) return;
    try {
      const stop = (o) => { try { o.stop(); } catch {} };
      const e = this.engine; if (e) { stop(e.noise); stop(e.lfo); stop(e.body); }
      // Stop the siren oscillators too — zeroing gain alone leaves them running after the
      // master is disconnected, leaking a fresh set of oscillators on every scene restart.
      for (const v of this.sirens || []) { stop(v.carrier); stop(v.lfo); v.g.gain.value = 0; }
      this.master.disconnect();
    } catch {}
    this.ctx = null;
  }
}
