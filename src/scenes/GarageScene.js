import Phaser from "phaser";
import { GAME_WIDTH } from "../config.js";
import { GameScene } from "./GameScene.js";
import { VEHICLES } from "../vehicles/catalog.js";
import { GADGETS, PLAYER_SLOT_KEYS, MAX_LOADOUT, gadgetById } from "../gadgets.js";
import { NOIR, addNoirBackground, addBackLink } from "../ui/noirTheme.js";

// Layout y-positions — vehicle selector sits between the header and the loadout section.
const VEH_Y    = 215;  // vehicle card centre y
const SLOT_Y   = 352;  // loadout slot centre y (was 220)
const GADGET_Y = 466;  // gadget rack centre y (was 330)
const DESC_Y   = 556;  // gadget tooltip text (was 402)

// The garage: pick a vehicle, configure loadout slots (Z/X/C), buy/equip gadgets.
// Persisted via GameScene static methods; choices carry into the next chase.
export class GarageScene extends Phaser.Scene {
  constructor() {
    super({ key: "GarageScene" });
  }

  create() {
    const cx = GAME_WIDTH / 2;
    addNoirBackground(this, 0.55);
    addBackLink(this, () => this.scene.start("MenuScene"));

    // --- Header ---
    this.add
      .text(cx, 40, "GARAGE", {
        fontFamily: NOIR.titleFont,
        fontSize: "44px",
        fontStyle: "700",
        color: NOIR.white,
        letterSpacing: 3,
      })
      .setOrigin(0.5);
    this.add
      .text(cx, 76, "pick your ride · equip loadout", {
        fontFamily: NOIR.uiFont,
        fontSize: "15px",
        color: NOIR.dim,
      })
      .setOrigin(0.5)
      .setAlpha(0.7);

    this._bankText = this.add
      .text(cx, 108, "", {
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

    // --- Vehicle selector ---
    this._buildVehicleSelector(cx);

    // --- Loadout section ---
    this.add
      .text(cx, VEH_Y + 110, "LOADOUT", {
        fontFamily: NOIR.uiFont,
        fontSize: "13px",
        fontStyle: "600",
        color: NOIR.faint,
        letterSpacing: 2,
      })
      .setOrigin(0.5);

    this._slotSize = 64;
    const sg = 26,
      n = MAX_LOADOUT,
      total = n * this._slotSize + (n - 1) * sg;
    const x0 = cx - total / 2 + this._slotSize / 2;
    this._slotPos = [];
    for (let i = 0; i < n; i++) {
      const sx = x0 + i * (this._slotSize + sg);
      this._slotPos.push({ x: sx, y: SLOT_Y });
      this.add
        .text(sx, SLOT_Y + this._slotSize / 2 + 14, PLAYER_SLOT_KEYS[i], {
          fontFamily: NOIR.uiFont,
          fontSize: "16px",
          fontStyle: "600",
          color: NOIR.dim,
        })
        .setOrigin(0.5);
      this.add
        .rectangle(sx, SLOT_Y, this._slotSize, this._slotSize, 0x000000, 0)
        .setInteractive({ useHandCursor: true })
        .on("pointerdown", () => this._removeSlot(i));
    }

    // --- Gadget rack ---
    this.add
      .text(cx, SLOT_Y + this._slotSize / 2 + 40, "GADGETS", {
        fontFamily: NOIR.uiFont,
        fontSize: "13px",
        fontStyle: "600",
        color: NOIR.faint,
        letterSpacing: 2,
      })
      .setOrigin(0.5);

    this._choiceSize = 50;
    const cg = 40,
      cn = GADGETS.length,
      ctotal = cn * this._choiceSize + (cn - 1) * cg;
    const cx0 = cx - ctotal / 2 + this._choiceSize / 2;
    this._choicePos = [];
    this._choiceLabels = [];
    GADGETS.forEach((def, i) => {
      const px = cx0 + i * (this._choiceSize + cg);
      this._choicePos.push({ x: px, y: GADGET_Y });
      this._choiceLabels.push(
        this.add
          .text(px, GADGET_Y + this._choiceSize / 2 + 14, "", {
            fontFamily: NOIR.uiFont,
            fontSize: "13px",
            color: NOIR.dim,
          })
          .setOrigin(0.5),
      );
      const zone = this.add
        .rectangle(px, GADGET_Y, this._choiceSize + 12, this._choiceSize + 28, 0x000000, 0)
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
      .text(cx, DESC_Y, "", {
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

  // ─── Vehicle selector ──────────────────────────────────────────────────────

  _buildVehicleSelector(cx) {
    const CARD_W = 210, CARD_H = 140, GAP = 46;
    const n = VEHICLES.length;
    // Store card geometry so _renderVehicleCards can redraw without recomputing.
    // Centred for any N: card i sits at cx + (i - (n-1)/2) * (CARD_W + GAP).
    this._vehicleCards = VEHICLES.map((def, i) => ({
      def,
      x: cx + (i - (n - 1) / 2) * (CARD_W + GAP),
      y: VEH_Y,
      w: CARD_W,
      h: CARD_H,
    }));
    this._selectedVehicle = GameScene.getVehicle();
    this._hoverVehicle    = null;
    this._vehicleGfx      = this.add.graphics();

    this.add
      .text(cx, VEH_Y - CARD_H / 2 - 14, "VEHICLE", {
        fontFamily: NOIR.uiFont,
        fontSize: "13px",
        fontStyle: "600",
        color: NOIR.faint,
        letterSpacing: 2,
      })
      .setOrigin(0.5);

    for (const card of this._vehicleCards) {
      const { def, x, y } = card;

      // Sprite preview — scale the game display size up uniformly to ~68px tall.
      const previewH = 68;
      const previewW = Math.round(previewH * (def.stats.displayWidth / def.stats.displayHeight));
      this.add.image(x, y - 22, def.stats.texture).setDisplaySize(previewW, previewH);

      // Name
      this.add
        .text(x, y + 24, def.name.toUpperCase(), {
          fontFamily: NOIR.uiFont,
          fontSize: "15px",
          fontStyle: "600",
          color: NOIR.white,
          letterSpacing: 1,
        })
        .setOrigin(0.5);

      // Compact stat line: "Speed 5 · Accel 4 · Handling 3"
      this.add
        .text(x, y + 44, `Speed ${def.speed}  ·  Accel ${def.accel}  ·  Handling ${def.handling}`, {
          fontFamily: NOIR.uiFont,
          fontSize: "12px",
          color: NOIR.faint,
        })
        .setOrigin(0.5);

      // Invisible hit zone over the full card.
      this.add
        .rectangle(x, y, CARD_W, CARD_H, 0x000000, 0)
        .setInteractive({ useHandCursor: true })
        .on("pointerover", () => {
          this._hoverVehicle = def.id;
          this._renderVehicleCards();
        })
        .on("pointerout", () => {
          this._hoverVehicle = null;
          this._renderVehicleCards();
        })
        .on("pointerdown", () => {
          GameScene.setVehicle(def.id);
          this._selectedVehicle = def.id;
          this._renderVehicleCards();
        });
    }

    this._renderVehicleCards();
  }

  _renderVehicleCards() {
    const g = this._vehicleGfx;
    g.clear();
    for (const { def, x, y, w, h } of this._vehicleCards) {
      const selected = this._selectedVehicle === def.id;
      const hovered  = this._hoverVehicle    === def.id;

      g.fillStyle(selected ? 0x1a1510 : 0x0d0d16, selected ? 0.95 : 0.85);
      g.fillRoundedRect(x - w / 2, y - h / 2, w, h, 10);

      const borderCol = selected ? 0xffd23f : hovered ? 0x5a5a7a : 0x252530;
      g.lineStyle(selected ? 2 : 1, borderCol, 1);
      g.strokeRoundedRect(x - w / 2, y - h / 2, w, h, 10);

      // Amber top-edge accent on the selected card.
      if (selected) {
        g.lineStyle(3, 0xffd23f, 0.9);
        g.beginPath();
        g.moveTo(x - w / 2 + 10, y - h / 2);
        g.lineTo(x + w / 2 - 10, y - h / 2);
        g.strokePath();
      }
    }
  }

  // ─── Gadget management (unchanged logic, updated y refs come from constants) ─

  _refreshBank() {
    this._bankText.setText(`BANK  $${GameScene.getBank().toLocaleString()}`);
  }

  _buyGadget(def) {
    if (GameScene.buyGadget(def.id)) {
      this.owned = GameScene.getOwned();
      this._refreshBank();
      if (this.loadout.length < MAX_LOADOUT) this._toggleGadget(def.id);
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
    if (!this.owned.includes(id)) return;
    this._descText.setColor(NOIR.dim);
    const idx = this.loadout.indexOf(id);
    if (idx >= 0) this.loadout.splice(idx, 1);
    else if (this.loadout.length < MAX_LOADOUT) this.loadout.push(id);
    else return;
    GameScene.setLoadout(this.loadout);
    this._renderLoadout();
  }

  _removeSlot(i) {
    if (i >= this.loadout.length) return;
    this.loadout.splice(i, 1);
    GameScene.setLoadout(this.loadout);
    this._renderLoadout();
  }

  _renderLoadout() {
    const g = this.loadoutGfx;
    g.clear();
    const ss = this._slotSize;
    for (let i = 0; i < this._slotPos.length; i++) {
      const p   = this._slotPos[i];
      const def = gadgetById(this.loadout[i]);
      g.fillStyle(0x12121a, 0.85);
      g.fillRoundedRect(p.x - ss / 2, p.y - ss / 2, ss, ss, 8);
      g.lineStyle(2, def ? def.color : 0x3a3a4a, 1);
      g.strokeRoundedRect(p.x - ss / 2, p.y - ss / 2, ss, ss, 8);
      if (def) def.icon(g, p.x, p.y, ss * 0.78);
    }
    const cs = this._choiceSize;
    GADGETS.forEach((def, i) => {
      const p     = this._choicePos[i];
      const owned = this.owned.includes(def.id);
      const on    = this.loadout.includes(def.id);
      const hover = this._hoverId === def.id;
      g.fillStyle(owned ? 0x12121a : 0x0d0d12, 0.85);
      g.fillRoundedRect(p.x - cs / 2, p.y - cs / 2, cs, cs, 6);
      g.lineStyle(
        2,
        owned
          ? on ? 0x39ff14 : hover ? 0x9aa0b5 : 0x2a2a38
          : hover ? 0xffd23f : 0x54502e,
        1,
      );
      g.strokeRoundedRect(p.x - cs / 2, p.y - cs / 2, cs, cs, 6);
      def.icon(g, p.x, p.y, cs * 0.78);
      if (!owned) {
        g.fillStyle(0x0d0d12, 0.5);
        g.fillRoundedRect(p.x - cs / 2, p.y - cs / 2, cs, cs, 6);
      }
      const label = this._choiceLabels[i];
      if (owned) label.setText(def.short).setColor(on ? NOIR.green : NOIR.dim);
      else label.setText(def.price != null ? `$${def.price.toLocaleString()}` : "?").setColor(hover ? NOIR.amber : "#6a6a4a");
    });
  }
}
