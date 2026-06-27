import Phaser from "phaser";
import { GAME_WIDTH, GAME_HEIGHT } from "../config.js";
import { GameScene } from "./GameScene.js";
import {
  GADGETS,
  PLAYER_SLOT_KEYS,
  MAX_LOADOUT,
  gadgetById,
} from "../gadgets.js";

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

    // --- Loadout picker (player gadgets — dev mode binds all of them anyway) ---
    this._buildLoadout(cx);

    // --- Controls reference ---
    this.add
      .text(cx, 590, "CONTROLS", {
        fontFamily: "monospace",
        fontSize: "18px",
        fontStyle: "bold",
        color: "#ffd23f",
      })
      .setOrigin(0.5);
    const controls = [
      "Arrows — Drive      Space — Handbrake      Shift — Brake",
      "Z / X / C — your gadgets      V — Repair      P — Pause",
    ].join("\n");
    this.add
      .text(cx, 638, controls, {
        fontFamily: "monospace",
        fontSize: "15px",
        color: "#c8c8d4",
        align: "center",
        lineSpacing: 8,
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

  // Loadout picker: 3 slot boxes (keyed Z/X/C) above the available gadgets. Click a gadget to
  // assign it to the next open slot; click an assigned one to remove it. Persisted via GameScene so
  // the choice carries into the chase (dev mode still binds ALL gadgets regardless).
  _buildLoadout(cx) {
    this.loadout = GameScene.getLoadout();
    this._hoverId = null;

    this.add
      .text(cx, 360, "LOADOUT — pick up to 3", {
        fontFamily: "monospace",
        fontSize: "18px",
        fontStyle: "bold",
        color: "#ffd23f",
      })
      .setOrigin(0.5);

    // Slot boxes (top row) with their key label underneath.
    this._slotSize = 56;
    const sg = 22,
      n = MAX_LOADOUT,
      total = n * this._slotSize + (n - 1) * sg;
    const x0 = cx - total / 2 + this._slotSize / 2;
    this._slotPos = [];
    for (let i = 0; i < n; i++) {
      const sx = x0 + i * (this._slotSize + sg);
      this._slotPos.push({ x: sx, y: 414 });
      this.add
        .text(sx, 414 + this._slotSize / 2 + 14, PLAYER_SLOT_KEYS[i], {
          fontFamily: "monospace",
          fontSize: "16px",
          fontStyle: "bold",
          color: "#9aa0b5",
        })
        .setOrigin(0.5);
    }

    // Available gadgets (bottom row) — icon box + name, hover for the tooltip, click to toggle.
    this._choiceSize = 44;
    const cg = 34,
      cn = GADGETS.length,
      ctotal = cn * this._choiceSize + (cn - 1) * cg;
    const cx0 = cx - ctotal / 2 + this._choiceSize / 2;
    this._choicePos = [];
    GADGETS.forEach((def, i) => {
      const px = cx0 + i * (this._choiceSize + cg);
      this._choicePos.push({ x: px, y: 500 });
      this.add
        .text(px, 500 + this._choiceSize / 2 + 12, def.short, {
          fontFamily: "monospace",
          fontSize: "11px",
          color: "#9aa0b5",
        })
        .setOrigin(0.5);
      const zone = this.add
        .zone(px, 500, this._choiceSize + 10, this._choiceSize + 24)
        .setInteractive({ useHandCursor: true });
      zone.on("pointerover", () => {
        this._hoverId = def.id;
        this._descText.setText(def.desc);
        this._renderLoadout();
      });
      zone.on("pointerout", () => {
        this._hoverId = null;
        this._descText.setText("");
        this._renderLoadout();
      });
      zone.on("pointerdown", () => this._toggleGadget(def.id));
    });

    this._descText = this.add
      .text(cx, 544, "", {
        fontFamily: "monospace",
        fontSize: "13px",
        color: "#9aa0b5",
        align: "center",
        wordWrap: { width: 820 },
      })
      .setOrigin(0.5, 0);

    this.loadoutGfx = this.add.graphics();
    this._renderLoadout();
  }

  _toggleGadget(id) {
    const idx = this.loadout.indexOf(id);
    if (idx >= 0) this.loadout.splice(idx, 1); // assigned → remove
    else if (this.loadout.length < MAX_LOADOUT) this.loadout.push(id); // → next open slot
    else return; // full — must remove one first
    GameScene.setLoadout(this.loadout);
    this._renderLoadout();
  }

  _renderLoadout() {
    const g = this.loadoutGfx;
    g.clear();
    const ss = this._slotSize;
    // Slot boxes — show the assigned gadget's icon + a coloured border, else an empty dashed-look box.
    for (let i = 0; i < this._slotPos.length; i++) {
      const p = this._slotPos[i];
      const def = gadgetById(this.loadout[i]);
      g.fillStyle(0x12121a, 1);
      g.fillRoundedRect(p.x - ss / 2, p.y - ss / 2, ss, ss, 8);
      g.lineStyle(2, def ? def.color : 0x3a3a4a, 1);
      g.strokeRoundedRect(p.x - ss / 2, p.y - ss / 2, ss, ss, 8);
      if (def) def.icon(g, p.x, p.y, ss * 0.78);
    }
    // Choices — icon in a box; green border when in the loadout, light on hover, dim otherwise.
    const cs = this._choiceSize;
    GADGETS.forEach((def, i) => {
      const p = this._choicePos[i];
      const on = this.loadout.includes(def.id);
      g.fillStyle(0x12121a, 1);
      g.fillRoundedRect(p.x - cs / 2, p.y - cs / 2, cs, cs, 6);
      g.lineStyle(
        2,
        on ? 0x39ff14 : this._hoverId === def.id ? 0x9aa0b5 : 0x2a2a38,
        1,
      );
      g.strokeRoundedRect(p.x - cs / 2, p.y - cs / 2, cs, cs, 6);
      def.icon(g, p.x, p.y, cs * 0.78);
    });
  }

  _start(copCount, pursuitMode = false) {
    this.scene.start("GameScene", { copCount, autostart: true, pursuitMode });
  }
}
