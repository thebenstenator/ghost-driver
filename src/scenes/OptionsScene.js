import Phaser from "phaser";
import { GAME_WIDTH, GAME_HEIGHT } from "../config.js";
import { NOIR, addNoirBackground, addBackLink, addMenuItem } from "../ui/noirTheme.js";
import { Settings } from "../settings.js";

// Options / settings. Reached from the title (standalone → back to MenuScene) OR launched as an
// overlay from the in-game pause menu (`data.returnTo` = the paused scene → resume it on back).
// Settings persist via `Settings` (localStorage) and, when a game is live, apply to it immediately.
export class OptionsScene extends Phaser.Scene {
  constructor() {
    super({ key: "OptionsScene" });
  }

  create(data) {
    const cx = GAME_WIDTH / 2;
    addNoirBackground(this, 0.55);
    const back = () => {
      if (data && data.returnTo) {
        this.scene.stop();
        this.scene.resume(data.returnTo);
      } else {
        this.scene.start("MenuScene");
      }
    };
    addBackLink(this, back);

    // Live audio to apply changes to immediately — only when launched as an in-game overlay
    // (data.returnTo set); from the title there's no running game to touch, just persist.
    const gs = data && data.returnTo ? this.scene.get(data.returnTo) : null;
    this._audio = (gs && gs.audio) || null;

    this.add
      .text(cx, 54, "OPTIONS", {
        fontFamily: NOIR.titleFont,
        fontSize: "44px",
        fontStyle: "700",
        color: NOIR.white,
        letterSpacing: 3,
      })
      .setOrigin(0.5);

    // ── Settings rows ──────────────────────────────────────────────────────────
    let y = 150;
    const gap = 74;

    // Master volume — draggable / click-to-set bar.
    this.add
      .text(cx, y - 26, "MASTER VOLUME", { fontFamily: NOIR.uiFont, fontSize: "18px", fontStyle: "600", color: NOIR.amber })
      .setOrigin(0.5);
    this._buildVolumeSlider(cx, y, 340);
    y += gap;

    // Sound on/off (this is where Mute lives now that it's off the keyboard).
    this._muteItem = addMenuItem(this, cx, y, "", { size: 22, origin: [0.5, 0.5], onClick: () => {
      const m = !Settings.getMuted();
      Settings.setMuted(m);
      if (this._audio) this._audio.setMuted(m);
      this._refreshMute();
    }});
    this._refreshMute();
    y += gap;

    // Fullscreen — an action toggle (not persisted; browsers require a gesture to enter, so it
    // can't auto-apply on load). Reflects the live scale state.
    this._fsItem = addMenuItem(this, cx, y, "", { size: 22, origin: [0.5, 0.5], onClick: () => {
      this.scale.toggleFullscreen();
      this._refreshFs();
    }});
    this._refreshFs();
    this.scale.on(Phaser.Scale.Events.ENTER_FULLSCREEN, this._refreshFs, this);
    this.scale.on(Phaser.Scale.Events.LEAVE_FULLSCREEN, this._refreshFs, this);
    this.events.once("shutdown", () => {
      this.scale.off(Phaser.Scale.Events.ENTER_FULLSCREEN, this._refreshFs, this);
      this.scale.off(Phaser.Scale.Events.LEAVE_FULLSCREEN, this._refreshFs, this);
    });

    // ── Controls reference (kept from the old card) ──────────────────────────────
    this.add
      .text(cx, GAME_HEIGHT - 132, "CONTROLS", { fontFamily: NOIR.uiFont, fontSize: "18px", fontStyle: "600", color: NOIR.amber })
      .setOrigin(0.5);
    const controls = [
      "Arrows — Drive      Space — Handbrake      Shift — Brake",
      "Z / X / C — gadgets      V — Repair      Q — Kill lights      E — Minimap",
      "Esc — Pause      R — Restart",
    ].join("\n");
    this.add
      .text(cx, GAME_HEIGHT - 100, controls, {
        fontFamily: NOIR.uiFont,
        fontSize: "15px",
        color: NOIR.dim,
        align: "center",
        lineSpacing: 8,
      })
      .setOrigin(0.5, 0);
  }

  _refreshMute() {
    this._muteItem.setText(`SOUND:  ${Settings.getMuted() ? "MUTED" : "ON"}`);
    this._muteItem.setColor(Settings.getMuted() ? NOIR.danger : NOIR.white);
  }

  _refreshFs() {
    this._fsItem.setText(`FULLSCREEN:  ${this.scale.isFullscreen ? "ON" : "OFF"}`);
  }

  // A minimal slider: a track + fill + knob, set by clicking or dragging anywhere along it.
  _buildVolumeSlider(cx, y, w) {
    const x = cx - w / 2, h = 8;
    const g = this.add.graphics();
    const pct = this.add
      .text(x + w + 18, y, "", { fontFamily: NOIR.uiFont, fontSize: "18px", fontStyle: "600", color: NOIR.white })
      .setOrigin(0, 0.5);
    const redraw = () => {
      const v = Settings.getVolume();
      g.clear();
      g.fillStyle(0x24242e, 1).fillRoundedRect(x, y - h / 2, w, h, 4);         // track
      g.fillStyle(0x39ff14, 1).fillRoundedRect(x, y - h / 2, Math.max(1, w * v), h, 4); // fill
      g.fillStyle(0xffffff, 1).fillCircle(x + w * v, y, 9);                    // knob
      pct.setText(`${Math.round(v * 100)}%`);
    };
    redraw();

    const setFromPointer = (pointer) => {
      const v = Phaser.Math.Clamp((pointer.x - x) / w, 0, 1);
      Settings.setVolume(v);
      if (this._audio) this._audio.setMasterVolume(v);
      redraw();
    };
    // A generous hit zone over the track so it's easy to grab.
    const zone = this.add.zone(x, y - 18, w, 36).setOrigin(0, 0).setInteractive({ useHandCursor: true });
    zone.on("pointerdown", (p) => { this._dragging = true; setFromPointer(p); });
    this.input.on("pointermove", (p) => { if (this._dragging) setFromPointer(p); });
    this.input.on("pointerup", () => { this._dragging = false; });
  }
}
