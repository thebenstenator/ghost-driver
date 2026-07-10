import Phaser from "phaser";
import { GAME_WIDTH, GAME_HEIGHT } from "../config.js";
import { NOIR, addNoirBackground, addBackLink } from "../ui/noirTheme.js";

// Controls reference, split out of the title screen so the menu stays slim.
export class OptionsScene extends Phaser.Scene {
  constructor() {
    super({ key: "OptionsScene" });
  }

  create() {
    const cx = GAME_WIDTH / 2;
    addNoirBackground(this, 0.55);
    addBackLink(this, () => this.scene.start("MenuScene"));

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
      "Z / X / C — your gadgets      V — Repair      P — Pause",
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
