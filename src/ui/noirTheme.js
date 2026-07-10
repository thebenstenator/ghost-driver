// Shared look for the menu-layer scenes (MenuScene / GarageScene / OptionsScene): the noir
// cityscape backdrop + a legibility panel, plus the font/colour constants and the hover-grow
// menu-item builder used across all three. Keeps the "semi-transparent → grow + opaque on
// hover" interaction in one place instead of re-implemented per scene.
import { GAME_WIDTH, GAME_HEIGHT } from "../config.js";

export const NOIR = {
  titleFont: "Cinzel",
  uiFont: "Oswald",
  white: "#ffffff",
  dim: "#c8c8d4",
  faint: "#8a8a9a",
  amber: "#ffd23f",
  green: "#39ff14",
  danger: "#ff6b6b",
};

// The full-bleed background image (1672x941, exactly 16:9 — no crop needed) + a dark scrim so
// text stays legible over whatever's behind it (the art has bright spots — signage, rain glow).
export function addNoirBackground(scene, scrimAlpha = 0.35) {
  const bg = scene.add
    .image(GAME_WIDTH / 2, GAME_HEIGHT / 2, "title_bg")
    .setDisplaySize(GAME_WIDTH, GAME_HEIGHT);
  const scrim = scene.add.rectangle(
    GAME_WIDTH / 2,
    GAME_HEIGHT / 2,
    GAME_WIDTH,
    GAME_HEIGHT,
    0x05050a,
    scrimAlpha,
  );
  return { bg, scrim };
}

// A translucent rounded panel behind a block of UI, so hover/legibility doesn't depend on
// what's underneath in the art.
export function addPanel(scene, x, y, w, h, alpha = 0.4) {
  const g = scene.add.graphics();
  g.fillStyle(0x05050a, alpha);
  g.fillRoundedRect(x, y, w, h, 14);
  g.lineStyle(1, 0xffffff, 0.06);
  g.strokeRoundedRect(x, y, w, h, 14);
  return g;
}

// A menu-item text that idles semi-transparent and grows + goes fully opaque on hover.
// origin defaults to (1, 0.5) — right-aligned, so growth expands leftward and stays on screen.
export function addMenuItem(scene, x, y, label, opts = {}) {
  const {
    size = 24,
    idleAlpha = 0.55,
    growTo = 1.12,
    origin = [1, 0.5],
    onClick = null,
  } = opts;
  const item = scene.add
    .text(x, y, label, {
      fontFamily: NOIR.uiFont,
      fontSize: `${size}px`,
      fontStyle: "600",
      color: NOIR.white,
    })
    .setOrigin(origin[0], origin[1])
    .setAlpha(idleAlpha);
  if (onClick) item.setInteractive({ useHandCursor: true });
  item.on("pointerover", () => {
    scene.tweens.add({
      targets: item,
      alpha: 1,
      scaleX: growTo,
      scaleY: growTo,
      duration: 150,
      ease: "Quad.easeOut",
    });
  });
  item.on("pointerout", () => {
    scene.tweens.add({
      targets: item,
      alpha: idleAlpha,
      scaleX: 1,
      scaleY: 1,
      duration: 200,
      ease: "Quad.easeIn",
    });
  });
  if (onClick) item.on("pointerdown", onClick);
  return item;
}

// A small "← BACK" link, top-left, shared by Garage/Options.
export function addBackLink(scene, onClick) {
  const back = addMenuItem(scene, 28, 28, "← BACK", {
    size: 18,
    idleAlpha: 0.6,
    growTo: 1.08,
    origin: [0, 0.5],
    onClick,
  });
  scene.input.keyboard.on("keydown-ESC", onClick);
  return back;
}
