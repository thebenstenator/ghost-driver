import Phaser from "phaser";
import { GAME_WIDTH } from "../config.js";
import { GameScene } from "./GameScene.js";
import { GADGETS, PLAYER_SLOT_KEYS, MAX_LOADOUT, gadgetById } from "../gadgets.js";
import { NOIR, addNoirBackground, addBackLink } from "../ui/noirTheme.js";

// The garage: 3 loadout slots (Z/X/C) above a gadget rack. A gadget you OWN toggles into/out of
// the loadout; a LOCKED gadget shows its price and buys with the bank (then it's owned/equippable).
// Persisted via GameScene so choices carry into the chase (dev mode still binds ALL gadgets).
// The bank total is displayed ONLY here, not on the title screen.
export class GarageScene extends Phaser.Scene {
  constructor() {
    super({ key: "GarageScene" });
  }

  create() {
    const cx = GAME_WIDTH / 2;
    addNoirBackground(this, 0.55);
    addBackLink(this, () => this.scene.start("MenuScene"));

    this.add
      .text(cx, 56, "GARAGE", {
        fontFamily: NOIR.titleFont,
        fontSize: "44px",
        fontStyle: "700",
        color: NOIR.white,
        letterSpacing: 3,
      })
      .setOrigin(0.5);
    this.add
      .text(cx, 96, "equip owned · buy locked", {
        fontFamily: NOIR.uiFont,
        fontSize: "15px",
        color: NOIR.dim,
      })
      .setOrigin(0.5)
      .setAlpha(0.7);

    this._bankText = this.add
      .text(cx, 132, "", {
        fontFamily: NOIR.uiFont,
        fontSize: "20px",
        fontStyle: "600",
        color: NOIR.amber,
      })
      .setOrigin(0.5);
    this._refreshBank();

    this.owned = GameScene.getOwned();
    this.loadout = GameScene.getLoadout();
    this._hoverId = null;

    // Slot boxes (top row) with their key label underneath.
    this._slotSize = 64;
    const sg = 26,
      n = MAX_LOADOUT,
      total = n * this._slotSize + (n - 1) * sg;
    const x0 = cx - total / 2 + this._slotSize / 2;
    this._slotPos = [];
    for (let i = 0; i < n; i++) {
      const sx = x0 + i * (this._slotSize + sg);
      this._slotPos.push({ x: sx, y: 220 });
      this.add
        .text(sx, 220 + this._slotSize / 2 + 14, PLAYER_SLOT_KEYS[i], {
          fontFamily: NOIR.uiFont,
          fontSize: "16px",
          fontStyle: "600",
          color: NOIR.dim,
        })
        .setOrigin(0.5);
      // Click a filled slot to clear it (an invisible interactive rect under the drawn box).
      this.add
        .rectangle(sx, 220, this._slotSize, this._slotSize, 0x000000, 0)
        .setInteractive({ useHandCursor: true })
        .on("pointerdown", () => this._removeSlot(i));
    }

    // Gadget rack (bottom row) — icon box + a label that reads the gadget NAME when owned or its
    // PRICE when locked. Hover shows the tooltip; click equips (owned) or buys (locked).
    this._choiceSize = 50;
    const cg = 40,
      cn = GADGETS.length,
      ctotal = cn * this._choiceSize + (cn - 1) * cg;
    const cx0 = cx - ctotal / 2 + this._choiceSize / 2;
    this._choicePos = [];
    this._choiceLabels = [];
    GADGETS.forEach((def, i) => {
      const px = cx0 + i * (this._choiceSize + cg);
      this._choicePos.push({ x: px, y: 330 });
      this._choiceLabels.push(
        this.add
          .text(px, 330 + this._choiceSize / 2 + 14, "", {
            fontFamily: NOIR.uiFont,
            fontSize: "13px",
            color: NOIR.dim,
          })
          .setOrigin(0.5),
      );
      const zone = this.add
        .rectangle(px, 330, this._choiceSize + 12, this._choiceSize + 28, 0x000000, 0)
        .setInteractive({ useHandCursor: true });
      zone.on("pointerover", () => {
        this._hoverId = def.id;
        const locked = !this.owned.includes(def.id);
        this._descText
          .setColor(NOIR.dim)
          .setText(locked ? `${def.desc}   —   BUY for $${def.price.toLocaleString()}` : def.desc);
        this._renderLoadout();
      });
      zone.on("pointerout", () => {
        this._hoverId = null;
        this._descText.setText("");
        this._renderLoadout();
      });
      zone.on("pointerdown", () =>
        this.owned.includes(def.id) ? this._toggleGadget(def.id) : this._buyGadget(def),
      );
    });

    this._descText = this.add
      .text(cx, 402, "", {
        fontFamily: NOIR.uiFont,
        fontSize: "14px",
        color: NOIR.dim,
        align: "center",
        wordWrap: { width: 820 },
      })
      .setOrigin(0.5, 0);

    this.loadoutGfx = this.add.graphics();
    this._renderLoadout();
  }

  _refreshBank() {
    this._bankText.setText(`BANK  $${GameScene.getBank().toLocaleString()}`);
  }

  // Buy a locked gadget with bank cash. On success it becomes owned + auto-equips (if there's a
  // free slot); otherwise flash a "can't afford" note in the tooltip line.
  _buyGadget(def) {
    if (GameScene.buyGadget(def.id)) {
      this.owned = GameScene.getOwned();
      this._refreshBank();
      if (this.loadout.length < MAX_LOADOUT) this._toggleGadget(def.id); // equip the new gadget
      this._descText.setColor(NOIR.green).setText(`Unlocked ${def.name}!`);
      this._renderLoadout();
    } else {
      const short = GameScene.getBank() < def.price;
      this._descText
        .setColor(NOIR.danger)
        .setText(short ? `Not enough cash — ${def.name} costs $${def.price.toLocaleString()}` : "");
    }
  }

  _toggleGadget(id) {
    if (!this.owned.includes(id)) return; // can only equip what you own
    this._descText.setColor(NOIR.dim);
    const idx = this.loadout.indexOf(id);
    if (idx >= 0) this.loadout.splice(idx, 1); // assigned → remove
    else if (this.loadout.length < MAX_LOADOUT) this.loadout.push(id); // → next open slot
    else return; // full — must remove one first
    GameScene.setLoadout(this.loadout);
    this._renderLoadout();
  }

  // Click a slot box to clear the gadget sitting in it.
  _removeSlot(i) {
    if (i >= this.loadout.length) return; // empty slot — nothing to clear
    this.loadout.splice(i, 1);
    GameScene.setLoadout(this.loadout);
    this._renderLoadout();
  }

  _renderLoadout() {
    const g = this.loadoutGfx;
    g.clear();
    const ss = this._slotSize;
    // Slot boxes — show the assigned gadget's icon + a coloured border, else an empty box.
    for (let i = 0; i < this._slotPos.length; i++) {
      const p = this._slotPos[i];
      const def = gadgetById(this.loadout[i]);
      g.fillStyle(0x12121a, 0.85);
      g.fillRoundedRect(p.x - ss / 2, p.y - ss / 2, ss, ss, 8);
      g.lineStyle(2, def ? def.color : 0x3a3a4a, 1);
      g.strokeRoundedRect(p.x - ss / 2, p.y - ss / 2, ss, ss, 8);
      if (def) def.icon(g, p.x, p.y, ss * 0.78);
    }
    // Rack — icon in a box. OWNED: green border when equipped, else neutral/hover. LOCKED: dim box +
    // amber border, icon faded; the label shows the price. Label reads the name (owned) or "$price".
    const cs = this._choiceSize;
    GADGETS.forEach((def, i) => {
      const p = this._choicePos[i];
      const owned = this.owned.includes(def.id);
      const on = this.loadout.includes(def.id);
      const hover = this._hoverId === def.id;
      g.fillStyle(owned ? 0x12121a : 0x0d0d12, 0.85);
      g.fillRoundedRect(p.x - cs / 2, p.y - cs / 2, cs, cs, 6);
      g.lineStyle(
        2,
        owned
          ? on ? 0x39ff14 : hover ? 0x9aa0b5 : 0x2a2a38
          : hover ? 0xffd23f : 0x54502e, // locked → amber (price) border
        1,
      );
      g.strokeRoundedRect(p.x - cs / 2, p.y - cs / 2, cs, cs, 6);
      def.icon(g, p.x, p.y, cs * 0.78);
      if (!owned) {
        g.fillStyle(0x0d0d12, 0.5); // dim overlay so a locked gadget's icon reads as unavailable
        g.fillRoundedRect(p.x - cs / 2, p.y - cs / 2, cs, cs, 6);
      }

      const label = this._choiceLabels[i];
      if (owned) label.setText(def.short).setColor(on ? NOIR.green : NOIR.dim);
      else label.setText(`$${def.price.toLocaleString()}`).setColor(hover ? NOIR.amber : "#6a6a4a");
    });
  }
}
