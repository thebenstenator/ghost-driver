// Gadget registry — the SINGLE source of gadget metadata, shared by the menu loadout picker
// (MenuScene) and the in-game binding + HUD (GameScene). Each entry carries:
//   deploy  : the GameScene method name to call on key press
//   short   : the HUD label
//   desc    : the menu tooltip
//   charges/max/active : (scene) => … accessors the HUD reads to draw the pips
//   icon    : (graphics, cx, cy, size) => … a little procedural picture for the menu
//
// Keys: in DEV mode every gadget is bound on its own key (DEV_GADGET_KEYS, in this order); in
// PLAYER mode only the chosen loadout (≤3) is bound, mapped onto PLAYER_SLOT_KEYS by slot.
export const GADGETS = [
  {
    id: "smoke",
    name: "Smoke Screen",
    short: "SMOKE",
    deploy: "_deploySmoke",
    hudColor: "#b9b9c2",
    color: 0xb9b9c2,
    desc: "Drops a cloud that blocks cops' line of sight, so they lose track of you and the chase cools down.",
    charges: (s) => s.smokeCharges,
    max: (s) => s.smokeMaxCharges,
    active: (s) => s.smokes.length > 0,
    icon: (g, x, y, s) => {
      g.fillStyle(0xb9b9c2, 1);
      g.fillCircle(x - s * 0.16, y + s * 0.06, s * 0.18);
      g.fillCircle(x + s * 0.16, y + s * 0.04, s * 0.2);
      g.fillCircle(x, y - s * 0.1, s * 0.22);
      g.fillCircle(x, y + s * 0.16, s * 0.16);
    },
  },
  {
    id: "nitro",
    name: "Nitro Boost",
    short: "NITRO",
    deploy: "_fireNitro",
    hudColor: "#7fd8ff",
    color: 0x7fd8ff,
    desc: "A short burst of extra acceleration and top speed — punch out of a box or clear a roadblock gap.",
    charges: (s) => s.nitroCharges,
    max: (s) => s.nitroMaxCharges,
    active: (s) => s.nitroTimer > 0,
    icon: (g, x, y, s) => {
      g.fillStyle(0x7fd8ff, 1);
      const w = s * 0.3,
        h = s * 0.22;
      for (const oy of [-s * 0.1, s * 0.14]) {
        g.fillTriangle(x, y + oy - h, x - w, y + oy, x + w, y + oy);
      }
    },
  },
  {
    id: "oil",
    name: "Oil Slick",
    short: "OIL",
    deploy: "_deployOilSlick",
    hudColor: "#d8c27a",
    color: 0xd8c27a,
    desc: "Drops an oil patch behind you; cops that drive over it lose grip and slide off course.",
    charges: (s) => s.oilCharges,
    max: (s) => s.oilMaxCharges,
    active: () => false,
    icon: (g, x, y, s) => {
      g.fillStyle(0x14140e, 1);
      g.fillCircle(x - s * 0.15, y + s * 0.08, s * 0.18);
      g.fillCircle(x + s * 0.16, y + s * 0.02, s * 0.2);
      g.fillCircle(x, y - s * 0.1, s * 0.17);
      g.fillStyle(0x6a6448, 0.85);
      g.fillCircle(x - s * 0.04, y - s * 0.02, s * 0.07);
    },
  },
  {
    id: "repair",
    name: "Repair Kit",
    short: "REPAIR",
    deploy: "_useRepairKit",
    hudColor: "#7dff9e",
    color: 0x7dff9e,
    desc: "Instantly fixes tires blown by a spike strip, restoring your speed and handling.",
    charges: (s) => s.repairCharges,
    max: (s) => s.repairMaxCharges,
    active: (s) => s.time.now < s._repairFlashUntil,
    icon: (g, x, y, s) => {
      g.fillStyle(0x7dff9e, 1);
      const t = s * 0.12,
        a = s * 0.32;
      g.fillRect(x - t, y - a, 2 * t, 2 * a);
      g.fillRect(x - a, y - t, 2 * a, 2 * t);
    },
  },
];

export const PLAYER_SLOT_KEYS = ["Z", "X", "C"]; // the 3 player loadout slots, in order
export const DEV_GADGET_KEYS = ["Z", "X", "C", "V"]; // dev: every gadget on its own key (registry order)
export const MAX_LOADOUT = 3;
export const DEFAULT_LOADOUT = ["smoke", "nitro", "oil"]; // sensible starter 3

export function gadgetById(id) {
  return GADGETS.find((g) => g.id === id) || null;
}
