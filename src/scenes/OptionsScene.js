import Phaser from "phaser";
import { GAME_WIDTH, GAME_HEIGHT } from "../config.js";
import { NOIR, addNoirBackground, addBackLink } from "../ui/noirTheme.js";

// Controls reference, split out of the title screen so the menu stays slim.
export class OptionsScene extends Phaser.Scene {
  constructor() {
    super({ key: "OptionsScene" });
  }

  // `data.returnTo` = a scene key to resume when launched as an in-game overlay (from the
  // pause menu). Absent → normal standalone screen reached from the title, back to MenuScene.
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

    this.add
      .text(cx, 56, "OPTIONS", {
        fontFamily: NOIR.titleFont,
        fontSize: "44px",
        fontStyle: "700",
        color: NOIR.white,
        letterSpacing: 3,
      })
      .setOrigin(0.5);

    this.add
      .text(cx, GAME_HEIGHT / 2 - 60, "CONTROLS", {
        fontFamily: NOIR.uiFont,
        fontSize: "20px",
        fontStyle: "600",
        color: NOIR.amber,
      })
      .setOrigin(0.5);

    const controls = [
      "Arrows — Drive      Space — Handbrake      Shift — Brake",
      "Z / X / C — your gadgets      V — Repair      L — Kill lights",
      "M — Minimap      N — Mute      P — Pause",
    ].join("\n");
    this.add
      .text(cx, GAME_HEIGHT / 2 - 12, controls, {
        fontFamily: NOIR.uiFont,
        fontSize: "16px",
        color: NOIR.dim,
        align: "center",
        lineSpacing: 10,
      })
      .setOrigin(0.5, 0);
  }
}
