import Phaser from "phaser";
import { GAME_WIDTH, GAME_HEIGHT } from "../config.js";
import { GameScene } from "./GameScene.js";
import {
  NOIR,
  addNoirBackground,
  addPanel,
  addMenuItem,
} from "../ui/noirTheme.js";

// Title screen: a per-car noir cityscape (the equipped car — with its wet-road reflection — is
// baked into the backdrop plate), a big Cinzel title, and a slim right-side nav (Oswald,
// semi-transparent → grows + opaques on hover). Loadout/economy lives in GarageScene; controls
// live in OptionsScene.
export class MenuScene extends Phaser.Scene {
  constructor() {
    super({ key: "MenuScene" });
  }

  create() {
    // Pick the backdrop baked with the equipped car; fall back to the neutral plate for any car
    // whose scene art doesn't exist yet.
    const carBg = `title_bg_${GameScene.getVehicle()}`;
    addNoirBackground(this, 0.18, this.textures.exists(carBg) ? carBg : "title_bg");

    // --- Title ---
    this.add
      .text(GAME_WIDTH / 2, 96, "GHOST DRIVER", {
        fontFamily: NOIR.titleFont,
        fontSize: "68px",
        fontStyle: "900",
        color: NOIR.white,
        letterSpacing: 6,
        shadow: {
          offsetX: 0,
          offsetY: 3,
          color: "#000000",
          blur: 18,
          fill: true,
        },
      })
      .setOrigin(0.5);

    // --- Right-side nav ---
    const navX = GAME_WIDTH - 80;
    // Panel behind the nav — sized to hug the menu column (right edge fixed at navX+40, since
    // hover-grow scales the text about its own right-aligned origin and never moves that edge).
    // Adjust the (x, y, w, h) args below to resize/reposition it.
    addPanel(this, GAME_WIDTH - 300, 200, 360, 322, 0.4);

    addMenuItem(this, navX, 226, "CAREER", {
      size: 36,
      onClick: () => this._start(1, true, "m1"),
    });
    this.add
      .text(navX, 252, "reach the drop · lose the cops · get paid", {
        fontFamily: NOIR.uiFont,
        fontSize: "13px",
        color: NOIR.dim,
      })
      .setOrigin(1, 0)
      .setAlpha(0.55);

    addMenuItem(this, navX, 302, "PURSUIT MODE", {
      size: 26,
      onClick: () => this._start(1, true),
    });
    this.add
      .text(navX, 322, "endless — difficulty escalates with the heat", {
        fontFamily: NOIR.uiFont,
        fontSize: "12px",
        color: NOIR.dim,
      })
      .setOrigin(1, 0)
      .setAlpha(0.5);

    addMenuItem(this, navX, 372, "GARAGE", {
      size: 26,
      onClick: () => this.scene.start("GarageScene"),
    });
    this.add
      .text(navX, 392, "choose your vehicle & gadgets", {
        fontFamily: NOIR.uiFont,
        fontSize: "12px",
        color: NOIR.dim,
      })
      .setOrigin(1, 0)
      .setAlpha(0.5);

    addMenuItem(this, navX, 442, "FREE DRIVE", {
      size: 26,
      onClick: () => this._start(0),
    });

    addMenuItem(this, navX, 490, "OPTIONS", {
      size: 26,
      onClick: () => this.scene.start("OptionsScene"),
    });

    // --- Dev-only: Cop Testbed (sandbox) entry, bottom-right. ---
    const tb = this.add
      .text(GAME_WIDTH - 16, GAME_HEIGHT - 18, "🔧 cop testbed →", {
        fontFamily: NOIR.uiFont,
        fontSize: "15px",
        color: NOIR.amber,
      })
      .setOrigin(1, 0.5)
      .setAlpha(0.75)
      .setInteractive({ useHandCursor: true });
    tb.on("pointerover", () => tb.setAlpha(1));
    tb.on("pointerout", () => tb.setAlpha(0.75));
    tb.on("pointerdown", () =>
      this.scene.start("GameScene", { sandbox: true, autostart: true }),
    );

    // --- Dev-only: Tiled map viewer, bottom-right above the testbed. ---
    const mt = this.add
      .text(GAME_WIDTH - 16, GAME_HEIGHT - 42, "🗺 map test →", {
        fontFamily: NOIR.uiFont,
        fontSize: "15px",
        color: NOIR.amber,
      })
      .setOrigin(1, 0.5)
      .setAlpha(0.75)
      .setInteractive({ useHandCursor: true });
    mt.on("pointerover", () => mt.setAlpha(1));
    mt.on("pointerout", () => mt.setAlpha(0.75));
    mt.on("pointerdown", () => this.scene.start("MapTestScene"));

    // --- Dev-only: edge-aware nav visualiser, above the map viewer. ---
    const nt = this.add
      .text(GAME_WIDTH - 16, GAME_HEIGHT - 66, "🧭 nav test →", {
        fontFamily: NOIR.uiFont,
        fontSize: "15px",
        color: NOIR.amber,
      })
      .setOrigin(1, 0.5)
      .setAlpha(0.75)
      .setInteractive({ useHandCursor: true });
    nt.on("pointerover", () => nt.setAlpha(1));
    nt.on("pointerout", () => nt.setAlpha(0.75));
    nt.on("pointerdown", () => this.scene.start("NavTestScene"));

    // --- Dev mode toggle (bottom-left corner) ---
    // Off by default. When on, the chase shows tuning panels + AI overlays; when off,
    // playtesters get a clean screen. Persisted, so it survives restarts.
    this._devOn = GameScene.isDevMode();
    const devBox = this.add
      .text(16, GAME_HEIGHT - 18, "", {
        fontFamily: NOIR.uiFont,
        fontSize: "15px",
      })
      .setOrigin(0, 0.5)
      .setInteractive({ useHandCursor: true });
    const renderDev = (hover = false) => {
      devBox.setText(`${this._devOn ? "[x]" : "[ ]"} dev mode`);
      devBox.setColor(this._devOn ? NOIR.amber : NOIR.faint);
      devBox.setAlpha(hover ? 1 : 0.8);
    };
    renderDev();
    tb.setVisible(this._devOn); // testbed entry only when dev mode is on
    mt.setVisible(this._devOn); // map viewer likewise
    nt.setVisible(this._devOn); // nav visualiser likewise
    devBox.on("pointerover", () => renderDev(true));
    devBox.on("pointerout", () => renderDev(false));
    devBox.on("pointerdown", () => {
      this._devOn = !this._devOn;
      GameScene.setDevMode(this._devOn);
      renderDev(true);
      tb.setVisible(this._devOn);
      mt.setVisible(this._devOn);
      nt.setVisible(this._devOn);
    });

    // --- Keyboard shortcuts ---
    this.input.keyboard.on("keydown-P", () => this._start(1, true)); // P → Pursuit Mode
    this.input.keyboard.on("keydown-ZERO", () => this._start(0));
    this.input.keyboard.on("keydown-ONE", () => this._start(1));
    this.input.keyboard.on("keydown-TWO", () => this._start(2));
    this.input.keyboard.on("keydown-THREE", () => this._start(3));
  }

  _start(copCount, pursuitMode = false, mission = null) {
    this.scene.start("GameScene", {
      copCount,
      autostart: true,
      pursuitMode,
      mission,
    });
  }
}
