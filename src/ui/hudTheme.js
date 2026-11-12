// In-chase HUD palette + type ("Clear Top" — see specs/ui-ux.md). One place for the HUD's look so
// GameScene's draw code reads as layout, not colour codes.
//
// The rules the palette encodes:
//   • The road is the picture. HUD chrome is thin brass hairlines on a near-black plate, bone-white
//     for values. No saturated UI colours.
//   • RED means the pursuit, and only the pursuit (the heat ring, cop blips, "you are seen").
//   • Nothing lives at the top of the screen while you drive; objective text appears only when it
//     is news (a new step) or a correction (you're at the objective but failing its condition).
export const HUD = {
  bone: 0xece6d6,     // values, icons, the player blip
  boneDim: 0xa8a393,  // inactive / standing-down
  brass: 0xc9a961,    // hairlines, key tabs, frames
  brassHi: 0xe0c27a,  // charges, objective marker, the ditch countdown
  dim: 0x6b603f,      // spent / on-cooldown frame
  iconDim: 0x6f6b5f,  // icon while spent / on cooldown
  red: 0xff6a55,      // the pursuit
  plate: 0x0c0c11,    // backing behind tiles + the minimap
  css: {
    bone: "#ece6d6",
    boneDim: "#a8a393",
    brassHi: "#e0c27a",
    red: "#ff6a55",
    redSoft: "#ff8d7c",
    ink: "#0b0b10",
  },
  font: {
    deco: "Cinzel",              // short labels: PURSUIT, BUST, GHOST
    ui: "Oswald",                // numerals, key letters, cards
    text: '"Barlow Condensed"',  // objective hints, distances, status cues
  },
};
