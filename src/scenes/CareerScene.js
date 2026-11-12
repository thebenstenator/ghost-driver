import Phaser from "phaser";
import { GAME_WIDTH, GAME_HEIGHT } from "../config.js";
import { GameScene } from "./GameScene.js";
import { MISSIONS } from "../systems/Mission.js";
import { NOIR, addNoirBackground, addBackLink, addMenuItem } from "../ui/noirTheme.js";

const CARD_W = 760;
const CARD_H = 104;
const GAP = 16;
const TOP = 168;

// Career: the job list. Missions unlock in order — the first is always open, each later one opens
// when the job before it has been completed once. Any open job can be replayed for its payout
// (that's the grind that pays for the garage). Clicking a card goes straight to its briefing.
export class CareerScene extends Phaser.Scene {
  constructor() {
    super({ key: "CareerScene" });
  }

  create() {
    const cx = GAME_WIDTH / 2;
    addNoirBackground(this, 0.5, "title_bg");
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
    this._gfx = this.add.graphics();
    this._cards = MISSIONS.map((def, i) => {
      const y = TOP + i * (CARD_H + GAP) + CARD_H / 2;
      const open = GameScene.missionUnlocked(def.id);
      const card = { def, y, open, done: done.includes(def.id), hover: false };
      const x0 = cx - CARD_W / 2;
      const a = open ? 1 : 0.4;
      const text = (x, ty, str, size, color, opts = {}) =>
        this.add.text(x, ty, str, { fontFamily: NOIR.uiFont, fontSize: `${size}px`, color, ...opts }).setAlpha(a);

      text(x0 + 30, y, String(i + 1).padStart(2, "0"), 40, NOIR.faint, { fontStyle: "600" }).setOrigin(0, 0.5);
      text(x0 + 104, y - 32, def.name, 22, NOIR.white, { fontStyle: "600", letterSpacing: 1 });
      text(x0 + 104, y - 4, (def.job || "").toUpperCase(), 12, NOIR.amber, { fontStyle: "600", letterSpacing: 2 });
      text(x0 + 104, y + 16, open ? def.summary : `Finish “${MISSIONS[i - 1].name}” to unlock`, 14, NOIR.dim);
      text(x0 + CARD_W - 28, y - 16, `$${def.reward.toLocaleString()}`, 24, NOIR.amber, { fontStyle: "600" }).setOrigin(1, 0.5);
      const status = !open ? "LOCKED" : card.done ? "✓ DONE · REPLAY" : "NEW JOB";
      text(x0 + CARD_W - 28, y + 16, status, 12, !open ? NOIR.faint : card.done ? NOIR.green : NOIR.white, {
        fontStyle: "600", letterSpacing: 2,
      }).setOrigin(1, 0.5);

      if (open) {
        this.add
          .rectangle(cx, y, CARD_W, CARD_H, 0x000000, 0)
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

    addMenuItem(this, cx, GAME_HEIGHT - 44, "GARAGE →", {
      size: 22, origin: [0.5, 0.5], onClick: () => this.scene.start("GarageScene"),
    });
  }

  _render() {
    const g = this._gfx;
    const cx = GAME_WIDTH / 2;
    g.clear();
    for (const c of this._cards) {
      const x = cx - CARD_W / 2, y = c.y - CARD_H / 2;
      g.fillStyle(c.hover ? 0x1a1510 : 0x0b0b12, c.open ? 0.92 : 0.7);
      g.fillRoundedRect(x, y, CARD_W, CARD_H, 12);
      g.lineStyle(c.hover ? 2 : 1, c.hover ? 0xffd23f : c.open ? 0x34343f : 0x1e1e28, 1);
      g.strokeRoundedRect(x, y, CARD_W, CARD_H, 12);
    }
  }
}
