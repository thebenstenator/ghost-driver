import Phaser from "phaser";
import { GAME_WIDTH, GAME_HEIGHT } from "../config.js";
import { GameScene } from "./GameScene.js";
import { VEHICLES } from "../vehicles/catalog.js";
import { GADGETS, PLAYER_SLOT_KEYS, MAX_LOADOUT, gadgetById } from "../gadgets.js";
import { NOIR, addNoirBackground, addBackLink } from "../ui/noirTheme.js";

// Layout y-positions for the main garage screen.
const VEH_Y  = 262; // vehicle card centre
const CARD_W = 440;
const CARD_H = 224;
const SLOT_Y = 496; // loadout slot centre
const BTN_Y  = 606; // GADGETS button centre

// Gadget shop modal geometry (screen coords).
const M = { w: 840, h: 612 };
M.x = (GAME_WIDTH - M.w) / 2;
M.y = (GAME_HEIGHT - M.h) / 2;
const VIEW = { x: M.x + 22, y: M.y + 84, w: M.w - 44, h: M.h - 84 - 20 }; // scrolling list viewport
const LIST_W = VIEW.w - 16; // row width (leaves a gutter for the scrollbar)

const money = (n) => `$${n.toLocaleString()}`;

// The garage — the hub of career progression. Everything here is paid for with mission cash:
//   • VEHICLE: cycle through every car (◀ ▶ or arrow keys). Owned cars are selected as you land on
//     them; locked ones are greyed out with their price and a BUY button.
//   • LOADOUT: the three gadget slots (Z/X/C). Click a slot to clear it.
//   • GADGETS: opens the shop modal — a scrolling list of every gadget. Locked gadgets show their
//     price; an owned gadget can be equipped and lists its upgrade tiers underneath, bought strictly
//     in order (each tier unlocks the next).
// All state persists through GameScene's static save methods, so choices carry into the next run.
export class GarageScene extends Phaser.Scene {
  constructor() {
    super({ key: "GarageScene" });
  }

  create() {
    const cx = GAME_WIDTH / 2;
    this._modal = null;
    addNoirBackground(this, 0.35, "garage_bg");
    // ESC closes the gadget shop first; only from the bare garage does it leave to the menu.
    addBackLink(this, () => (this._modal ? this._closeGadgets() : this.scene.start("MenuScene")));

    this.add
      .text(cx, 40, "GARAGE", {
        fontFamily: NOIR.titleFont, fontSize: "44px", fontStyle: "700", color: NOIR.white, letterSpacing: 3,
      })
      .setOrigin(0.5);
    this.add
      .text(cx, 76, "spend your cut · pick your ride · equip your loadout", {
        fontFamily: NOIR.uiFont, fontSize: "15px", color: NOIR.dim,
      })
      .setOrigin(0.5)
      .setAlpha(0.7);
    this._bankText = this.add
      .text(cx, 108, "", { fontFamily: NOIR.uiFont, fontSize: "20px", fontStyle: "600", color: NOIR.amber })
      .setOrigin(0.5);

    this.owned = GameScene.getOwned();
    this.loadout = GameScene.getLoadout();

    this._buildVehicleSelector(cx);
    this._buildLoadout(cx);

    this._gadgetsBtn = this._makeButton(cx, BTN_Y, 240, 50, "GADGETS", () => this._openGadgets(), {
      size: 22, color: 0xffd23f,
    });
    this._msgText = this.add
      .text(cx, BTN_Y + 48, "", { fontFamily: NOIR.uiFont, fontSize: "15px", color: NOIR.dim })
      .setOrigin(0.5);

    if (GameScene.isDevMode()) this._buildDevTools();

    this.input.keyboard.on("keydown-LEFT", () => !this._modal && this._cycleVehicle(-1));
    this.input.keyboard.on("keydown-RIGHT", () => !this._modal && this._cycleVehicle(1));
    this.input.keyboard.on("keydown-UP", () => this._modal && this._scrollBy(-60));
    this.input.keyboard.on("keydown-DOWN", () => this._modal && this._scrollBy(60));
    this._wireModalInput();
    this.events.once("shutdown", () => this.input.setDefaultCursor("default"));

    this._refreshAll();
  }

  // A bordered text button. Returns { set(label, enabled), setVisible(v) }.
  _makeButton(x, y, w, h, label, onClick, { size = 16, color = 0xffd23f } = {}) {
    const g = this.add.graphics();
    const t = this.add
      .text(x, y, label, { fontFamily: NOIR.uiFont, fontSize: `${size}px`, fontStyle: "600", color: NOIR.white, letterSpacing: 1 })
      .setOrigin(0.5);
    const zone = this.add.rectangle(x, y, w, h, 0x000000, 0).setInteractive({ useHandCursor: true });
    const st = { enabled: true, hover: false, color };
    const draw = () => {
      g.clear();
      g.fillStyle(st.hover && st.enabled ? 0x2a2410 : 0x0d0d16, 0.9);
      g.fillRoundedRect(x - w / 2, y - h / 2, w, h, 8);
      g.lineStyle(st.hover && st.enabled ? 2 : 1, st.enabled ? st.color : 0x3a3a4a, 1);
      g.strokeRoundedRect(x - w / 2, y - h / 2, w, h, 8);
      t.setAlpha(st.enabled ? 1 : 0.45);
    };
    zone.on("pointerover", () => { st.hover = true; draw(); });
    zone.on("pointerout", () => { st.hover = false; draw(); });
    zone.on("pointerdown", () => st.enabled && onClick());
    draw();
    return {
      set(text, enabled = true, col = color) { t.setText(text); st.enabled = enabled; st.color = col; draw(); },
      setVisible(v) { g.setVisible(v); t.setVisible(v); zone.setVisible(v); if (!v) st.hover = false; },
    };
  }

  _say(text, color = NOIR.dim) {
    this._msgText.setText(text).setColor(color);
  }

  _refreshAll() {
    this.owned = GameScene.getOwned();
    this.loadout = GameScene.getLoadout();
    this._bankText.setText(`BANK  ${money(GameScene.getBank())}`);
    this._renderVehicle();
    this._renderLoadout();
  }

  // ─── Vehicle selector (one car at a time, cycled) ───────────────────────────

  _buildVehicleSelector(cx) {
    this._vi = Math.max(0, VEHICLES.findIndex((v) => v.id === GameScene.getVehicle()));
    this.add
      .text(cx, VEH_Y - CARD_H / 2 - 16, "VEHICLE", {
        fontFamily: NOIR.uiFont, fontSize: "13px", fontStyle: "600", color: NOIR.faint, letterSpacing: 2,
      })
      .setOrigin(0.5);
    this._vehGfx = this.add.graphics();

    // One preview sprite per car (only the viewed one is visible), scaled to a common height.
    this._vehSprites = VEHICLES.map((def) => {
      const h = 112;
      const w = Math.round(h * (def.stats.displayWidth / def.stats.displayHeight));
      return this.add.image(cx, VEH_Y - 46, def.stats.texture).setDisplaySize(w, h).setVisible(false);
    });
    const text = (y, size, color, style = "600") =>
      this.add.text(cx, y, "", { fontFamily: NOIR.uiFont, fontSize: `${size}px`, fontStyle: style, color, letterSpacing: 1 }).setOrigin(0.5);
    this._vehName   = text(VEH_Y + 30, 22, NOIR.white);
    this._vehFlavor = text(VEH_Y + 56, 14, NOIR.dim, "400");
    this._vehStats  = text(VEH_Y + 80, 13, NOIR.faint, "400");
    this._vehTag    = text(VEH_Y - CARD_H / 2 + 20, 13, NOIR.amber);
    this._vehStatus = text(VEH_Y + CARD_H / 2 + 28, 15, NOIR.green);
    this._vehBuy = this._makeButton(cx, VEH_Y + CARD_H / 2 + 30, 260, 40, "", () => this._buyVehicle(), { size: 17 });

    // ◀ ▶ cycle arrows either side of the card.
    for (const dir of [-1, 1]) {
      const ax = cx + dir * (CARD_W / 2 + 48);
      const arrow = this.add
        .text(ax, VEH_Y, dir < 0 ? "◀" : "▶", { fontFamily: NOIR.uiFont, fontSize: "40px", color: NOIR.white })
        .setOrigin(0.5)
        .setAlpha(0.55)
        .setInteractive({ useHandCursor: true });
      arrow.on("pointerover", () => arrow.setAlpha(1));
      arrow.on("pointerout", () => arrow.setAlpha(0.55));
      arrow.on("pointerdown", () => this._cycleVehicle(dir));
    }
  }

  _cycleVehicle(dir) {
    const n = VEHICLES.length;
    this._vi = (this._vi + dir + n) % n;
    const def = VEHICLES[this._vi];
    // Landing on a car you own selects it; a locked car is only being looked at.
    if (GameScene.getOwnedVehicles().includes(def.id)) GameScene.setVehicle(def.id);
    this._say("");
    this._renderVehicle();
  }

  _buyVehicle() {
    const def = VEHICLES[this._vi];
    if (GameScene.buyVehicle(def.id)) {
      GameScene.setVehicle(def.id);
      this._refreshAll();
      this._say(`${def.name} is yours.`, NOIR.green);
    }
  }

  _renderVehicle() {
    const cx = GAME_WIDTH / 2;
    const def = VEHICLES[this._vi];
    const owned = GameScene.getOwnedVehicles().includes(def.id);
    const bank = GameScene.getBank();

    this._vehSprites.forEach((s, i) => s.setVisible(i === this._vi));
    const spr = this._vehSprites[this._vi];
    if (owned) spr.clearTint().setAlpha(1);
    else spr.setTint(0x7c7c86).setAlpha(0.7); // greyed out

    this._vehName.setText(def.name.toUpperCase()).setColor(owned ? NOIR.white : NOIR.faint);
    this._vehFlavor.setText(`“${def.flavor}”`).setAlpha(owned ? 0.85 : 0.5);
    this._vehStats
      .setText(`Speed ${def.speed}  ·  Accel ${def.accel}  ·  Handling ${def.handling}`)
      .setAlpha(owned ? 1 : 0.6);
    this._vehTag.setText(owned ? "" : `LOCKED  ·  ${money(def.price)}`);

    const g = this._vehGfx;
    g.clear();
    g.fillStyle(owned ? 0x1a1510 : 0x0b0b10, 0.92);
    g.fillRoundedRect(cx - CARD_W / 2, VEH_Y - CARD_H / 2, CARD_W, CARD_H, 12);
    g.lineStyle(owned ? 2 : 1, owned ? 0xffd23f : 0x3a3a4a, 1);
    g.strokeRoundedRect(cx - CARD_W / 2, VEH_Y - CARD_H / 2, CARD_W, CARD_H, 12);
    // Position dots under the card.
    VEHICLES.forEach((v, i) => {
      g.fillStyle(i === this._vi ? 0xffd23f : 0x4a4a5a, 1);
      g.fillCircle(cx + (i - (VEHICLES.length - 1) / 2) * 16, VEH_Y + CARD_H / 2 - 14, i === this._vi ? 4 : 3);
    });

    if (owned) {
      this._vehBuy.setVisible(false);
      this._vehStatus.setVisible(true).setText("✓  YOUR RIDE");
    } else {
      this._vehStatus.setVisible(false);
      this._vehBuy.setVisible(true);
      const short = def.price - bank;
      if (short > 0) this._vehBuy.set(`NEED ${money(short)} MORE`, false);
      else this._vehBuy.set(`BUY  ·  ${money(def.price)}`, true);
    }
  }

  // ─── Loadout slots ──────────────────────────────────────────────────────────

  _buildLoadout(cx) {
    this.add
      .text(cx, SLOT_Y - 52, "LOADOUT", {
        fontFamily: NOIR.uiFont, fontSize: "13px", fontStyle: "600", color: NOIR.faint, letterSpacing: 2,
      })
      .setOrigin(0.5);
    this._slotSize = 64;
    const gap = 26, n = MAX_LOADOUT;
    const x0 = cx - (n * this._slotSize + (n - 1) * gap) / 2 + this._slotSize / 2;
    this._slotPos = [];
    for (let i = 0; i < n; i++) {
      const sx = x0 + i * (this._slotSize + gap);
      this._slotPos.push({ x: sx, y: SLOT_Y });
      this.add
        .text(sx, SLOT_Y + this._slotSize / 2 + 14, PLAYER_SLOT_KEYS[i], {
          fontFamily: NOIR.uiFont, fontSize: "16px", fontStyle: "600", color: NOIR.dim,
        })
        .setOrigin(0.5);
      this.add
        .rectangle(sx, SLOT_Y, this._slotSize, this._slotSize, 0x000000, 0)
        .setInteractive({ useHandCursor: true })
        .on("pointerdown", () => this._removeSlot(i));
    }
    this.loadoutGfx = this.add.graphics();
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
      const p = this._slotPos[i];
      const def = gadgetById(this.loadout[i]);
      g.fillStyle(0x12121a, 0.85);
      g.fillRoundedRect(p.x - ss / 2, p.y - ss / 2, ss, ss, 8);
      g.lineStyle(2, def ? def.color : 0x3a3a4a, 1);
      g.strokeRoundedRect(p.x - ss / 2, p.y - ss / 2, ss, ss, 8);
      if (def) def.icon(g, p.x, p.y, ss * 0.78);
    }
  }

  // ─── Dev tools (dev mode only) ──────────────────────────────────────────────

  _buildDevTools() {
    const link = (x, label, fn) => {
      const t = this.add
        .text(x, GAME_HEIGHT - 18, label, { fontFamily: NOIR.uiFont, fontSize: "15px", color: NOIR.amber })
        .setOrigin(0, 0.5)
        .setAlpha(0.75)
        .setInteractive({ useHandCursor: true });
      t.on("pointerover", () => t.setAlpha(1));
      t.on("pointerout", () => t.setAlpha(0.75));
      t.on("pointerdown", fn);
    };
    link(16, "🔧 + $10,000", () => { GameScene.addBank(10000); this._refreshAll(); });
    link(140, "🔧 reset progress", () => {
      GameScene.resetProgress();
      this._vi = 0;
      this._refreshAll();
      this._say("Progress reset.");
    });
  }

  // ─── Gadget shop modal ──────────────────────────────────────────────────────
  // Everything in the modal is hit-tested by hand against a list of button rects, because the
  // list scrolls under a mask (Phaser's own input doesn't clip to masks). A full-screen
  // interactive scrim sits above the garage so nothing underneath receives clicks while it's open.

  _openGadgets() {
    if (this._modal) return;
    // `fresh`: the press that OPENED the modal must not also count as a click inside it.
    const m = (this._modal = { scroll: 0, buttons: [], hover: null, objs: [], fresh: true });
    const keep = (o) => { m.objs.push(o); return o; };
    const D = 200;

    keep(this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x020205, 0.78))
      .setDepth(D)
      .setInteractive();
    const panel = keep(this.add.graphics()).setDepth(D + 1);
    panel.fillStyle(0x0b0b12, 0.98);
    panel.fillRoundedRect(M.x, M.y, M.w, M.h, 14);
    panel.lineStyle(1, 0xffd23f, 0.5);
    panel.strokeRoundedRect(M.x, M.y, M.w, M.h, 14);

    keep(this.add.text(M.x + 28, M.y + 34, "GADGETS", {
      fontFamily: NOIR.titleFont, fontSize: "30px", fontStyle: "700", color: NOIR.white, letterSpacing: 2,
    })).setOrigin(0, 0.5).setDepth(D + 2);
    m.bank = keep(this.add.text(M.x + M.w - 76, M.y + 26, "", {
      fontFamily: NOIR.uiFont, fontSize: "20px", fontStyle: "600", color: NOIR.amber,
    })).setOrigin(1, 0.5).setDepth(D + 2);
    m.msg = keep(this.add.text(M.x + M.w - 76, M.y + 52, "", {
      fontFamily: NOIR.uiFont, fontSize: "14px", color: NOIR.dim,
    })).setOrigin(1, 0.5).setDepth(D + 2);
    m.close = { x: M.x + M.w - 52, y: M.y + 14, w: 38, h: 38 };
    m.closeText = keep(this.add.text(m.close.x + 19, m.close.y + 19, "✕", {
      fontFamily: NOIR.uiFont, fontSize: "24px", color: NOIR.white,
    })).setOrigin(0.5).setDepth(D + 2).setAlpha(0.6);

    // Scrolling list: a container clipped to the viewport by a geometry mask.
    m.list = keep(this.add.container(VIEW.x, VIEW.y)).setDepth(D + 3);
    const maskG = keep(this.make.graphics());
    maskG.fillStyle(0xffffff, 1).fillRect(VIEW.x, VIEW.y, VIEW.w, VIEW.h);
    m.list.setMask(maskG.createGeometryMask());
    m.bar = keep(this.add.graphics()).setDepth(D + 4);

    this._buildGadgetList();
  }

  _closeGadgets() {
    if (!this._modal) return;
    for (const o of this._modal.objs) o.destroy();
    this._modal = null;
    this.input.setDefaultCursor("default");
    this._refreshAll();
  }

  // (Re)build every row from the current save state. Called on open and after each purchase/equip.
  _buildGadgetList() {
    const m = this._modal;
    m.list.removeAll(true);
    m.buttons = [];
    m.hover = null;
    this.owned = GameScene.getOwned();
    this.loadout = GameScene.getLoadout();
    const bank = GameScene.getBank();
    m.bank.setText(`BANK  ${money(bank)}`);
    if (!m.msg.text) m.msg.setText(`${this.loadout.length} / ${MAX_LOADOUT} equipped`);

    const bg = this.add.graphics();   // card backgrounds + icons
    const btnG = this.add.graphics(); // button faces
    m.hoverG = this.add.graphics();   // hover outline (redrawn on pointer move)
    m.list.add(bg);
    const text = (x, y, str, size, color, opts = {}) => {
      const t = this.add.text(x, y, str, { fontFamily: NOIR.uiFont, fontSize: `${size}px`, color, ...opts });
      m.list.add(t);
      return t;
    };
    // A button rect in list coordinates; `onClick` null = display-only (disabled look).
    const button = (x, y, w, h, label, col, onClick) => {
      const on = !!onClick;
      btnG.fillStyle(on ? 0x15130a : 0x101016, 1);
      btnG.fillRoundedRect(x, y, w, h, 6);
      btnG.lineStyle(1, on ? col : 0x33333f, 1);
      btnG.strokeRoundedRect(x, y, w, h, 6);
      text(x + w / 2, y + h / 2, label, 14, on ? NOIR.white : NOIR.faint, { fontStyle: "600", letterSpacing: 1 })
        .setOrigin(0.5)
        .setAlpha(on ? 1 : 0.7);
      if (on) m.buttons.push({ x, y, w, h, col, onClick });
    };

    const BW = 168; // button width
    const bx = LIST_W - BW - 16;
    let y = 0;
    // Cheapest first: the starter leads and the late-game gadgets sit at the bottom.
    for (const def of [...GADGETS].sort((a, b) => (a.price || 0) - (b.price || 0))) {
      const owned = this.owned.includes(def.id);
      const slot = this.loadout.indexOf(def.id);
      const ups = def.upgrades || [];
      const level = GameScene.getUpgradeLevel(def.id);
      const cardH = 96 + (owned ? ups.length * 42 + 10 : 0);

      bg.fillStyle(owned ? 0x14141d : 0x0d0d13, 1);
      bg.fillRoundedRect(0, y, LIST_W, cardH, 10);
      bg.lineStyle(1, slot >= 0 ? 0x39ff14 : owned ? 0x2c2c3a : 0x1e1e28, 1);
      bg.strokeRoundedRect(0, y, LIST_W, cardH, 10);

      // Icon tile.
      const ix = 48, iy = y + 48;
      bg.fillStyle(0x0a0a10, 1);
      bg.fillRoundedRect(ix - 30, iy - 30, 60, 60, 8);
      bg.lineStyle(1, owned ? def.color : 0x33333f, 1);
      bg.strokeRoundedRect(ix - 30, iy - 30, 60, 60, 8);
      def.icon(bg, ix, iy, 46);
      if (!owned) {
        bg.fillStyle(0x0a0a10, 0.62); // grey the icon out
        bg.fillRoundedRect(ix - 30, iy - 30, 60, 60, 8);
      }

      const name = text(96, y + 14, def.name.toUpperCase(), 19, owned ? NOIR.white : NOIR.faint, { fontStyle: "600", letterSpacing: 1 });
      if (slot >= 0)
        text(96 + name.width + 12, y + 19, `EQUIPPED · ${PLAYER_SLOT_KEYS[slot]}`, 12, NOIR.green, { fontStyle: "600", letterSpacing: 1 });
      else if (!owned)
        text(96 + name.width + 12, y + 19, `LOCKED · ${ups.length} UPGRADES`, 12, "#6a6a7a", { fontStyle: "600", letterSpacing: 1 });
      text(96, y + 42, def.desc, 13, NOIR.dim, { wordWrap: { width: bx - 96 - 20 }, lineSpacing: 2 }).setAlpha(owned ? 0.85 : 0.5);

      // Main action: buy the gadget, or equip / unequip it.
      if (!owned) {
        const short = def.price - bank;
        if (short > 0) button(bx, y + 28, BW, 40, money(def.price), 0, null);
        else button(bx, y + 28, BW, 40, `BUY  ·  ${money(def.price)}`, 0xffd23f, () => this._shopBuyGadget(def));
      } else if (slot >= 0) {
        button(bx, y + 28, BW, 40, "UNEQUIP", 0x39ff14, () => this._shopToggle(def));
      } else if (this.loadout.length < MAX_LOADOUT) {
        button(bx, y + 28, BW, 40, "EQUIP", 0x9aa0b5, () => this._shopToggle(def));
      } else {
        button(bx, y + 28, BW, 40, "SLOTS FULL", 0, null);
      }

      // Upgrade ladder — only once the gadget is owned. Tier `level` is the one for sale; earlier
      // tiers are installed, later ones stay locked until the one before is bought.
      if (owned) {
        ups.forEach((u, i) => {
          const ry = y + 96 + i * 42;
          const state = i < level ? "owned" : i === level ? "next" : "locked";
          const a = state === "locked" ? 0.38 : 1;
          bg.lineStyle(1, 0x24242f, 1);
          bg.lineBetween(96, ry - 4, LIST_W - 16, ry - 4);
          // Ladder rail + node down the icon column.
          bg.lineStyle(2, state === "owned" ? 0x39ff14 : 0x33333f, 1);
          bg.lineBetween(ix, ry - 4, ix, ry + 16);
          bg.fillStyle(state === "owned" ? 0x39ff14 : state === "next" ? 0xffd23f : 0x33333f, 1);
          bg.fillCircle(ix, ry + 16, 5);
          const un = text(96, ry + 6, u.name, 15, state === "owned" ? NOIR.green : NOIR.white, { fontStyle: "600" }).setAlpha(a);
          text(96 + un.width + 12, ry + 8, u.desc, 13, NOIR.dim).setAlpha(a * 0.85);
          if (state === "owned") {
            text(bx + BW / 2, ry + 16, "✓ INSTALLED", 13, NOIR.green, { fontStyle: "600", letterSpacing: 1 }).setOrigin(0.5);
          } else if (state === "next") {
            if (u.price > bank) button(bx, ry + 1, BW, 30, money(u.price), 0, null);
            else button(bx, ry + 1, BW, 30, `BUY  ·  ${money(u.price)}`, 0xffd23f, () => this._shopBuyUpgrade(def, u));
          } else {
            text(bx + BW / 2, ry + 16, `LOCKED  ·  ${money(u.price)}`, 13, NOIR.faint, { letterSpacing: 1 }).setOrigin(0.5).setAlpha(0.55);
          }
        });
      }
      y += cardH + 12;
    }
    m.list.add(btnG);
    m.list.bringToTop(btnG);
    // Button labels were added before btnG; lift every text above the faces.
    for (const o of m.list.list.slice()) if (o.type === "Text") m.list.bringToTop(o);
    m.list.add(m.hoverG);
    m.contentH = y - 12;
    this._scrollBy(0);
  }

  _shopBuyGadget(def) {
    const m = this._modal;
    if (!GameScene.buyGadget(def.id)) return;
    // A new gadget drops straight into a free slot, as before.
    const loadout = GameScene.getLoadout();
    if (loadout.length < MAX_LOADOUT) GameScene.setLoadout([...loadout, def.id]);
    m.msg.setText(`Unlocked ${def.name}`).setColor(NOIR.green);
    this._buildGadgetList();
  }

  _shopBuyUpgrade(def, u) {
    const m = this._modal;
    if (!GameScene.buyUpgrade(def.id)) return;
    m.msg.setText(`${def.name}: ${u.name} installed`).setColor(NOIR.green);
    this._buildGadgetList();
  }

  _shopToggle(def) {
    const m = this._modal;
    const loadout = GameScene.getLoadout();
    const i = loadout.indexOf(def.id);
    if (i >= 0) loadout.splice(i, 1);
    else if (loadout.length < MAX_LOADOUT) loadout.push(def.id);
    GameScene.setLoadout(loadout);
    m.msg.setText(`${loadout.length} / ${MAX_LOADOUT} equipped`).setColor(NOIR.dim);
    this._buildGadgetList();
  }

  _scrollBy(dy) {
    const m = this._modal;
    if (!m) return;
    const max = Math.max(0, m.contentH - VIEW.h);
    m.scroll = Phaser.Math.Clamp(m.scroll + dy, 0, max);
    m.list.y = VIEW.y - m.scroll;
    m.bar.clear();
    if (max > 0) {
      const bx = VIEW.x + VIEW.w - 6;
      const th = Math.max(40, (VIEW.h * VIEW.h) / m.contentH);
      m.bar.fillStyle(0x1c1c26, 1).fillRoundedRect(bx, VIEW.y, 5, VIEW.h, 2);
      m.bar.fillStyle(0xffd23f, 0.7).fillRoundedRect(bx, VIEW.y + (m.scroll / max) * (VIEW.h - th), 5, th, 2);
    }
  }

  // The button under a screen point (list buttons respect scroll + the viewport clip).
  _modalHit(px, py) {
    const m = this._modal;
    const c = m.close;
    if (px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h) return c;
    if (px < VIEW.x || px > VIEW.x + VIEW.w || py < VIEW.y || py > VIEW.y + VIEW.h) return null;
    const lx = px - VIEW.x, ly = py - VIEW.y + m.scroll;
    return m.buttons.find((b) => lx >= b.x && lx <= b.x + b.w && ly >= b.y && ly <= b.y + b.h) || null;
  }

  _wireModalInput() {
    let down = null; // { y, scroll, dragged } for a press that began while the modal was open
    this.input.on("wheel", (_p, _o, _dx, dy) => this._scrollBy(dy * 0.6));
    this.input.on("pointerdown", (p) => {
      if (this._modal && !this._modal.fresh) down = { y: p.y, scroll: this._modal.scroll, dragged: false };
    });
    this.input.on("pointermove", (p) => {
      const m = this._modal;
      if (!m) return;
      if (down && p.isDown) {
        // Drag anywhere in the list to scroll it; a press that moves is not a click.
        if (Math.abs(p.y - down.y) > 6) down.dragged = true;
        if (down.dragged) { m.scroll = down.scroll; this._scrollBy(down.y - p.y); }
      }
      const hit = down && down.dragged ? null : this._modalHit(p.x, p.y);
      this.input.setDefaultCursor(hit ? "pointer" : "default");
      m.closeText.setAlpha(hit === m.close ? 1 : 0.6);
      const hb = hit && hit !== m.close ? hit : null;
      if (hb !== m.hover) {
        m.hover = hb;
        m.hoverG.clear();
        if (hb) {
          m.hoverG.fillStyle(hb.col, 0.14).fillRoundedRect(hb.x, hb.y, hb.w, hb.h, 6);
          m.hoverG.lineStyle(2, hb.col, 1).strokeRoundedRect(hb.x, hb.y, hb.w, hb.h, 6);
        }
      }
    });
    this.input.on("pointerup", (p) => {
      const m = this._modal, d = down;
      down = null;
      if (m) m.fresh = false;
      if (!m || !d || d.dragged) return;
      const hit = this._modalHit(p.x, p.y);
      if (hit === m.close) return this._closeGadgets();
      if (hit) return hit.onClick();
      // A click outside the panel dismisses it.
      if (p.x < M.x || p.x > M.x + M.w || p.y < M.y || p.y > M.y + M.h) this._closeGadgets();
    });
  }
}
