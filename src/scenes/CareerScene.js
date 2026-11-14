import Phaser from "phaser";
import { GAME_WIDTH, GAME_HEIGHT } from "../config.js";
import { GameScene } from "./GameScene.js";
import { MISSIONS } from "../systems/Mission.js";
import { vehicleById } from "../vehicles/catalog.js";
import { NOIR, addNoirBackground, addBackLink, addMenuItem } from "../ui/noirTheme.js";

// Two columns of job cards, filled left column first (so the career reads top-to-bottom).
const COLS = 2;
const CARD_W = 576;
const CARD_H = 100;
const GAP_X = 24;
const GAP_Y = 14;
const TOP = 150;

// Career: the job list. Missions unlock in order — the first is always open, each later one opens
// when the job before it has been completed once. Any open job can be replayed for its payout
// (that's the grind that pays for the garage). Clicking a card goes straight to its briefing.
// A job that requires a particular car says so: it's a loaner for that job, owned or not.
export class CareerScene extends Phaser.Scene {
  constructor() {
    super({ key: "CareerScene" });
  }

  create() {
    const cx = GAME_WIDTH / 2;
    addNoirBackground(this, 0.6, "title_bg");
    addBackLink(this, () => this.scene.start("MenuScene"));

    this.add
      .text(cx, 40, "CAREER", {
        fontFamily: NOIR.titleFont, fontSize: "44px", fontStyle: "700", color: NOIR.white, letterSpacing: 3,
      })
      .setOrigin(0.5);
    this.add
      .text(cx, 76, "take a job · get paid · spend it in the garage", {
        fontFamily: NOIR.uiFont, fontSize: "15px", color: NOIR.dim,
      })
      .setOrigin(0.5)
      .setAlpha(0.7);
    this.add
      .text(cx, 108, `BANK  $${GameScene.getBank().toLocaleString()}`, {
        fontFamily: NOIR.uiFont, fontSize: "20px", fontStyle: "600", color: NOIR.amber,
      })
      .setOrigin(0.5);

    const done = GameScene.getMissionsDone();
    const rows = Math.ceil(MISSIONS.length / COLS);
    const left = cx - (COLS * CARD_W + (COLS - 1) * GAP_X) / 2;
    this._gfx = this.add.graphics();
    this._cards = MISSIONS.map((def, i) => {
      const col = Math.floor(i / rows), row = i % rows;
      const x0 = left + col * (CARD_W + GAP_X);
      const y = TOP + row * (CARD_H + GAP_Y) + CARD_H / 2;
      const open = GameScene.missionUnlocked(def.id);
      const card = { def, x: x0, y, open, done: done.includes(def.id), hover: false };
      const a = open ? 1 : 0.4;
      const text = (x, ty, str, size, color, opts = {}) =>
        this.add.text(x, ty, str, { fontFamily: NOIR.uiFont, fontSize: `${size}px`, color, ...opts }).setAlpha(a);

      text(x0 + 24, y, String(i + 1).padStart(2, "0"), 36, NOIR.faint, { fontStyle: "600" }).setOrigin(0, 0.5);
      text(x0 + 88, y - 34, def.name, 21, NOIR.white, { fontStyle: "600", letterSpacing: 1 });
      // Job type, plus the loaner the job puts you in (if it requires a car).
      const lent = def.vehicle && vehicleById(def.vehicle).price > 0; // the starter needs no loan
      const loaner = lent ? `  ·  LOANER: ${vehicleById(def.vehicle).name.toUpperCase()}` : "";
      text(x0 + 88, y - 7, (def.job || "").toUpperCase() + loaner, 12, NOIR.amber, { fontStyle: "600", letterSpacing: 2 });
      text(x0 + 88, y + 13, open ? def.summary : `Finish “${MISSIONS[i - 1].name}” to unlock`, 14, NOIR.dim, {
        wordWrap: { width: CARD_W - 88 - 120 },
      });
      text(x0 + CARD_W - 22, y - 16, `$${def.reward.toLocaleString()}`, 22, NOIR.amber, { fontStyle: "600" }).setOrigin(1, 0.5);
      const status = !open ? "LOCKED" : card.done ? "✓ DONE" : "NEW JOB";
      text(x0 + CARD_W - 22, y + 14, status, 12, !open ? NOIR.faint : card.done ? NOIR.green : NOIR.white, {
        fontStyle: "600", letterSpacing: 2,
      }).setOrigin(1, 0.5);

      if (open) {
        this.add
          .rectangle(x0 + CARD_W / 2, y, CARD_W, CARD_H, 0x000000, 0)
          .setInteractive({ useHandCursor: true })
          .on("pointerover", () => { card.hover = true; this._render(); })
          .on("pointerout", () => { card.hover = false; this._render(); })
          .on("pointerdown", () =>
            this.scene.start("GameScene", { copCount: 1, autostart: true, pursuitMode: true, mission: def.id }),
          );
      }
      return card;
    });
    this._render();

    addMenuItem(this, cx, GAME_HEIGHT - 40, "GARAGE →", {
      size: 22, origin: [0.5, 0.5], idleAlpha: 0.8, onClick: () => this.scene.start("GarageScene"),
    });
  }

  _render() {
    const g = this._gfx;
    g.clear();
    for (const c of this._cards) {
      const y = c.y - CARD_H / 2;
      g.fillStyle(c.hover ? 0x1a1510 : 0x0b0b12, c.open ? 0.92 : 0.7);
      g.fillRoundedRect(c.x, y, CARD_W, CARD_H, 12);
      g.lineStyle(c.hover ? 2 : 1, c.hover ? 0xffd23f : c.open ? 0x34343f : 0x1e1e28, 1);
      g.strokeRoundedRect(c.x, y, CARD_W, CARD_H, 12);
    }
  }
}
