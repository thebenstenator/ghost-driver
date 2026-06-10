# Ghost Driver — Tech Stack

## Philosophy
Browser-first, iterative development. Build with AI assistance using well-documented, widely-supported tools that maximize the quality of AI-generated code. No over-engineering. Ship fun first.

---

## Core Framework
**Phaser.js (v3)**
- Industry standard JavaScript game framework
- Handles game loop, physics, sprites, input, camera, tilemaps, scenes, and asset loading
- Massive community and documentation — maximizes AI assistance quality
- Runs entirely in the browser, no install required for players
- https://phaser.io

---

## Language
**JavaScript (ES6+)**
- No TypeScript for now — keeps iteration fast and AI output clean
- Can migrate to TypeScript later if project scale demands it

---

## Map Editing
**Tiled Map Editor**
- Free desktop app for designing top-down tile-based maps
- Exports to JSON which Phaser reads natively
- Paint maps visually using tilesets — no code required for map layout
- https://www.mapeditor.org

---

## Asset Pipeline

### Placeholder Assets (MVP Phase)
- **Kenney.nl** — free top-down city and vehicle asset packs for early development
- Focus on gameplay feel before visual identity
- https://kenney.nl

### Final Assets (Art Pass Phase)
- AI-generated sprites (Midjourney, Leonardo.ai) for retro-futuristic noir style
- Custom illustrations from artist collaborators for garage screen car art
- Front 3/4 and rear 3/4 car illustrations for garage/customization screens

---

## Project Structure
```
ghost-driver/
├── specs/              # All design and planning documents
├── public/
│   └── index.html      # Game entry point
├── src/
│   ├── scenes/         # Phaser scenes (Boot, Menu, Game, Garage, GameOver)
│   ├── entities/       # Game objects (PlayerCar, CopCar, Roadblock etc)
│   ├── systems/        # Game logic (NotorietySystem, PursuitSystem, MissionSystem)
│   ├── ui/             # HUD, menus, overlays
│   ├── maps/           # Tiled map JSON files
│   └── config.js       # Phaser game config
├── assets/
│   ├── sprites/        # Car sprites, environment tiles, effects
│   ├── tilemaps/       # Tiled tilesets
│   ├── audio/          # Music, SFX
│   └── ui/             # Fonts, icons, garage illustrations
├── package.json
└── README.md
```

---

## Build Tools
**Vite**
- Fast dev server with hot reload — see changes instantly in the browser
- Simple build pipeline for production
- Works seamlessly with Phaser.js
- Same tool used in modern React projects — already familiar territory

---

## Physics
**Phaser Arcade Physics**
- Built into Phaser — no extra library needed
- Fast and reliable for top-down 2D
- Handles car vs environment collision, cop vs player collision, projectiles
- Simpler than Phaser's Matter.js physics but more than sufficient for Ghost Driver's needs

---

## Audio
**Phaser built-in Web Audio**
- Handles music and SFX natively
- Jazz/noir soundtrack (looping background tracks per scene)
- SFX: engine sounds, tire squeals, police sirens, collision impacts

---

## Save System
**Browser LocalStorage (MVP)**
- Stores campaign progress, unlocked vehicles, mission completion, notoriety levels
- No backend required for single player
- Simple JSON read/write via Phaser's built-in data manager

**Future: Backend save system**
- If multiplayer or leaderboards are added, migrate to a lightweight backend
- Node.js + Express + MongoDB (familiar MERN stack)
- Hosted on Railway (same as HomeWise)

---

## Deployment

### Development
- Vite dev server — local browser testing

### Production (MVP)
- **itch.io** — upload as an HTML5 game, instant publish, zero cost
- Vite builds to a /dist folder, zip and upload

### Production (Future)
- **Steam** via Electron wrapper
- Electron packages the browser game as a desktop executable
- Submit through Steamworks ($100 one-time developer fee)
- No code changes required — same game, new wrapper

---

## Demo vs Full Game Gating
- Demo and full game are the **same codebase**
- A single config flag controls which missions/vehicles are accessible
- Demo players see locked content with a purchase prompt
- Full unlock delivered via a license key or itch.io purchase verification

---

## Development Approach
- **AI-assisted pair coding** — describe features in plain English, iterate in browser
- Build one system at a time — get car movement right before adding cops, get cops right before adding missions
- Phaser's scene system maps naturally to iterative development — each screen is its own isolated unit
- Keep specs folder updated as decisions are made

---

## MVP Tech Checklist
- [ ] Vite + Phaser.js project scaffolded
- [ ] Player car moving on screen with arcade physics
- [ ] Basic tilemap city loaded from Tiled
- [ ] Camera following player car
- [ ] Basic cop AI chasing player
- [ ] Pursuit cooldown / ditch mechanic working
- [ ] One complete mission loop (start → objective → ditch → complete)
- [ ] Notoriety system attached to vehicle
- [ ] Basic HUD (wanted level, cooldown timer, minimap)
- [ ] Menu scene and game over scene
- [ ] Deployable to itch.io as HTML5
