import Phaser from "phaser";
import { GAME_WIDTH, GAME_HEIGHT } from "../config.js";
import { GameScene } from "./GameScene.js";

// Playtest menu: choose how many cops to spawn, then launch the chase.
export class MenuScene extends Phaser.Scene {
  constructor() {
    super({ key: "MenuScene" });
  }

  create() {
    this.cameras.main.setBackgroundColor("#0a0a0f");
    const cx = GAME_WIDTH / 2;

    // --- Title ---
    this.add
      .text(cx, 80, "GHOST DRIVER", {
        fontFamily: "monospace",
        fontSize: "60px",
        fontStyle: "bold",
        color: "#39ff14",
      })
      .setOrigin(0.5);
    this.add
      .text(cx, 132, "playtest — choose your pursuit", {
        fontFamily: "monospace",
        fontSize: "18px",
        color: "#9aa0b5",
      })
      .setOrigin(0.5);

    // --- Pursuit Mode (the escalating heat/level chase) ---
    const pm = this.add
      .text(cx, 196, "▶ PURSUIT MODE", {
        fontFamily: "monospace",
        fontSize: "28px",
        fontStyle: "bold",
        color: "#0a0a0f",
        backgroundColor: "#39ff14",
        align: "center",
        fixedWidth: 300,
        padding: { x: 0, y: 12 },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    pm.on("pointerover", () => pm.setBackgroundColor("#5fff4a"));
    pm.on("pointerout", () => pm.setBackgroundColor("#39ff14"));
    pm.on("pointerdown", () => this._start(1, true));
    this.add
      .text(cx, 240, "starts at 1 cop — escalates with heat", {
        fontFamily: "monospace",
        fontSize: "13px",
        color: "#6a6a7a",
      })
      .setOrigin(0.5);

    // --- Legacy free-test: fixed cop count, no escalation ---
    this.add
      .text(cx, 286, "Get a feel for the car without pressure", {
        fontFamily: "monospace",
        fontSize: "13px",
        color: "#6a6a7a",
      })
      .setOrigin(0.5);
    const options = [{ label: "Free drive", n: 0 }];
    options.forEach((opt, i) => {
      const t = this.add
        .text(cx, 320 + i * 46, opt.label, {
          fontFamily: "monospace",
          fontSize: "20px",
          color: "#ffffff",
          backgroundColor: "#1a1a24",
          align: "center",
          fixedWidth: 200,
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      t.on("pointerover", () => t.setColor("#ffd23f"));
      t.on("pointerout", () => t.setColor("#ffffff"));
      t.on("pointerdown", () => this._start(opt.n));
    });

    // --- Controls reference ---
    this.add
      .text(cx, 545, "CONTROLS", {
        fontFamily: "monospace",
        fontSize: "18px",
        fontStyle: "bold",
        color: "#ffd23f",
      })
      .setOrigin(0.5);
    const controls = [
      "Arrows — Drive        Space — Handbrake        Shift — Brake",
      "Z Smoke    X Nitro    C Oil    V Repair        P — Pause",
    ].join("\n");
    this.add
      .text(cx, 605, controls, {
        fontFamily: "monospace",
        fontSize: "16px",
        color: "#c8c8d4",
        align: "center",
        lineSpacing: 10,
      })
      .setOrigin(0.5);

    // --- Dev-only: Cop Testbed (sandbox) entry, bottom-right. Spawn + tune individual
    // cop unit types with no pursuit level in the loop. Only meaningful with dev panels,
    // so it shows/hides with the dev toggle. ---
    const tb = this.add
      .text(GAME_WIDTH - 16, GAME_HEIGHT - 18, "🔧 cop testbed →", {
        fontFamily: "monospace",
        fontSize: "15px",
        color: "#ffd23f",
      })
      .setOrigin(1, 0.5)
      .setInteractive({ useHandCursor: true });
    tb.on("pointerover", () => tb.setColor("#ffe98a"));
    tb.on("pointerout", () => tb.setColor("#ffd23f"));
    tb.on("pointerdown", () =>
      this.scene.start("GameScene", { sandbox: true, autostart: true }),
    );

    // --- Dev mode toggle (bottom-left corner) ---
    // Off by default. When on, the chase shows tuning panels + AI overlays; when off,
    // playtesters get a clean screen. Persisted, so it survives restarts.
    this._devOn = GameScene.isDevMode();
    const devBox = this.add
      .text(16, GAME_HEIGHT - 18, "", {
        fontFamily: "monospace",
        fontSize: "15px",
      })
      .setOrigin(0, 0.5)
      .setInteractive({ useHandCursor: true });
    const renderDev = (hover = false) => {
      devBox.setText(`${this._devOn ? "[x]" : "[ ]"} dev mode`);
      devBox.setColor(
        this._devOn
          ? hover
            ? "#5fff4a"
            : "#39ff14"
          : hover
            ? "#9aa0b5"
            : "#6a6a7a",
      );
    };
    renderDev();
    tb.setVisible(this._devOn); // testbed entry only when dev mode is on
    devBox.on("pointerover", () => renderDev(true));
    devBox.on("pointerout", () => renderDev(false));
    devBox.on("pointerdown", () => {
      this._devOn = !this._devOn;
      GameScene.setDevMode(this._devOn);
      renderDev(true);
      tb.setVisible(this._devOn);
    });

    // --- Keyboard shortcuts ---
    this.input.keyboard.on("keydown-P", () => this._start(1, true)); // P → Pursuit Mode
    this.input.keyboard.on("keydown-ZERO", () => this._start(0));
    this.input.keyboard.on("keydown-ONE", () => this._start(1));
    this.input.keyboard.on("keydown-TWO", () => this._start(2));
    this.input.keyboard.on("keydown-THREE", () => this._start(3));
  }

  _start(copCount, pursuitMode = false) {
    this.scene.start("GameScene", { copCount, autostart: true, pursuitMode });
  }
}
