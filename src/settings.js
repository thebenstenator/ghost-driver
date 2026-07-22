// Persisted player settings (audio volume, mute) shared between GameAudio (reads them at
// startup) and OptionsScene (writes them + applies live). Kept tiny and localStorage-backed —
// no game state, just preferences. All access is guarded so a blocked/unavailable localStorage
// (private mode, etc.) falls back to defaults instead of throwing.
const KEYS = { volume: "gd_masterVol", muted: "gd_muted" };
const DEFAULT_VOLUME = 0.55;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function readNum(key, dflt) {
  try {
    const v = parseFloat(localStorage.getItem(key));
    return Number.isNaN(v) ? dflt : v;
  } catch (e) {
    return dflt;
  }
}
function readBool(key) {
  try {
    return localStorage.getItem(key) === "1";
  } catch (e) {
    return false;
  }
}
function write(key, val) {
  try {
    localStorage.setItem(key, val);
  } catch (e) {
    /* storage unavailable — setting just won't persist */
  }
}

export const Settings = {
  getVolume() { return clamp01(readNum(KEYS.volume, DEFAULT_VOLUME)); },
  setVolume(v) { write(KEYS.volume, String(clamp01(v))); },
  getMuted() { return readBool(KEYS.muted); },
  setMuted(b) { write(KEYS.muted, b ? "1" : "0"); },
};
