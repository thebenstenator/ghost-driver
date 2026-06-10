# Ghost Driver — Roadmap

## Philosophy
Build the smallest version that is genuinely fun. Every feature that isn't in MVP is a feature that didn't slow down shipping. A tight, polished small game beats an ambitious unfinished one every time. Add depth after the core loop is proven.

---

## Development Phases

### Phase 0 — Foundation
*Get something moving on screen.*

The goal of Phase 0 is not a game — it's a proof of concept. A car that moves and feels good. Nothing else matters until this is right.

**Deliverables:**
- [ ] Vite + Phaser.js project scaffolded and running in browser
- [ ] Player car renders on screen as placeholder sprite
- [ ] Car moves with WASD/Arrow keys with arcade physics
- [ ] Handbrake drift functional
- [ ] Camera follows player car with smooth lag
- [ ] Basic tilemap loaded from Tiled (placeholder tiles)
- [ ] Car collides with walls and obstacles
- [ ] Frame rate stable at 60fps

**Exit criteria:** The car feels good to drive. Not fun yet — just right. If driving feels wrong here it will feel wrong forever.

---

### Phase 1 — The Chase
*Add cops. Make them scary.*

A game isn't Ghost Driver until there's something chasing you. Phase 1 adds pursuit and nothing else.

**Deliverables:**
- [ ] Basic cop car spawns and pursues player
- [ ] Cop AI follows player position
- [ ] Cop AI attempts basic flanking / interception
- [ ] Pursuit level system (1-5) implemented
- [ ] Pursuit escalates over time during active chase
- [ ] Basic cop car disabling — player can ram cops into obstacles
- [ ] Pursuit level affects cop count and aggression
- [ ] Police siren audio pans based on cop position
- [ ] Basic HUD — pursuit level indicator visible

**Exit criteria:** Being chased feels threatening and dynamic. Cops should feel like they're thinking, not just following.

---

### Phase 2 — The Ditch
*Make vanishing feel incredible.*

The signature mechanic. Phase 2 is complete when disappearing from pursuit feels like a genuine skill payoff.

**Deliverables:**
- [ ] Line of sight system — cops lose player when sight is broken
- [ ] Pursuit states implemented (Active → Cooldown → Ditched)
- [ ] Cooldown timer functional and displayed in HUD
- [ ] Timer resets on re-acquisition
- [ ] Parking garage hide mechanic functional
- [ ] Kill Lights mechanic reduces detection radius
- [ ] "GHOST" flash on successful ditch
- [ ] Cooldown duration scales with pursuit level
- [ ] Basic alleyway navigation (narrower than cop cars)

**Exit criteria:** Successfully ditching cops feels earned and satisfying. The "GHOST" flash should feel like a fist pump moment.

---

### Phase 3 — One Mission
*Build the loop end to end.*

A complete mission from briefing to ditch. Rough edges acceptable — the full loop must exist.

**Deliverables:**
- [ ] Mission briefing screen (text card, noir style)
- [ ] Garage / loadout screen (placeholder UI)
- [ ] Mission drop-in — starts mid-action, cops already coming
- [ ] One mid-mission objective (reach a location during cooldown)
- [ ] Mission complete condition (ditch + objective)
- [ ] Mission failed condition (caught / vehicle destroyed)
- [ ] Cash reward displayed on mission complete
- [ ] Game over screen
- [ ] Mission restarts cleanly

**Exit criteria:** A friend can sit down, play one mission start to finish, and understand what the game is.

---

### Phase 4 — The Garage
*Give players something to manage.*

Progression and economy. Phase 4 adds the systems that make players want to play again.

**Deliverables:**
- [ ] Two vehicles with distinct handling profiles (Pilgrim + Razorback)
- [ ] Vehicle selection in garage screen
- [ ] Notoriety system per vehicle — builds through missions
- [ ] Passive notoriety decay implemented
- [ ] Visual mod system — basic repaint reduces notoriety
- [ ] Currency earned from missions
- [ ] Currency persists between sessions (LocalStorage)
- [ ] Vehicle purchase with currency
- [ ] Gadget slot system per vehicle
- [ ] Two starter gadgets functional (Oil Slick + Nitro Boost)

**Exit criteria:** Players feel the pull to earn more money and upgrade their garage between missions.

---

### Phase 5 — MVP Campaign
*Five missions. A beginning, middle, and end.*

The demo slice. Act 1 complete plus Mission 6 as a teaser. This is the first version that goes to real players.

**Deliverables:**
- [ ] All 5 Act 1 missions playable end to end
- [ ] Mission 6 teaser with purchase prompt
- [ ] Full gadget roster (all 11 gadgets functional)
- [ ] All vehicle classes represented (at least one per class)
- [ ] Notoriety system fully functional including visual mods
- [ ] Basic cop unit variety (Patrol, Interceptor, Roadblock)
- [ ] Helicopter pursuit implemented
- [ ] Spike strips functional
- [ ] Full HUD implemented
- [ ] Main menu screen
- [ ] Basic settings (volume, controls)
- [ ] Deployed to itch.io as HTML5

**Exit criteria:** The demo is playable by strangers. It hooks them. They want to know what happens next.

---

### Phase 6 — Full Campaign
*Twenty missions. The complete Ghost Driver story.*

Acts 2 and 3. The full game. All systems at full depth.

**Deliverables:**
- [ ] All 20 missions complete
- [ ] Undercover mechanic implemented (Missions 8, 12, 16)
- [ ] All vehicle roster complete (8 vehicles)
- [ ] All districts of Obsidian Bay mapped and playable
- [ ] Elevated highway with construction zone jumps
- [ ] Drawbridge mechanic in Docks district
- [ ] Detective antagonist AI (Mission 13+)
- [ ] Full narrative briefings for all missions
- [ ] Star rating system per mission
- [ ] New Game+ mode
- [ ] Full save system
- [ ] Demo gating via config flag
- [ ] Deployed to itch.io as paid full game

**Exit criteria:** The game is completable start to finish. The story lands. Mission 20 feels like a farewell.

---

### Phase 7 — Polish
*The difference between good and memorable.*

No new features. Only refinement. This phase separates an indie game from a great indie game.

**Deliverables:**
- [ ] Final art pass — placeholder assets replaced with Ghost Driver aesthetic
- [ ] Garage screen illustrations (front 3/4 and rear 3/4 per vehicle)
- [ ] Vehicle damage states visible on sprites
- [ ] Rain and weather effects polished
- [ ] Neon reflections on wet road surfaces
- [ ] Full audio pass — engine sounds, tire squeals, sirens, ambient city audio
- [ ] Jazz/noir soundtrack per district
- [ ] Screen edge vignette during high pursuit
- [ ] Slow motion on near-miss collisions
- [ ] Cop headlights visible before cop car (warning system)
- [ ] Holographic wanted poster UI elements
- [ ] Art Deco font system throughout
- [ ] Accessibility options (colorblind mode, remappable controls)
- [ ] Performance optimization pass

**Exit criteria:** Screenshots of the game look like a real product. The audio makes the chase feel cinematic.

---

### Phase 8 — Steam Release
*Take it to the next level.*

Electron wrapper, Steamworks integration, Steam page.

**Deliverables:**
- [ ] Electron wrapper tested and stable
- [ ] Steam achievements designed and implemented
- [ ] Steam cloud save integration
- [ ] Controller support polished (full gamepad)
- [ ] Steam page — art, description, trailer
- [ ] Pricing set ($8-12 suggested for full game)
- [ ] Demo version configured for Steam
- [ ] Launch trailer produced
- [ ] Press kit assembled

**Exit criteria:** Ghost Driver is on Steam. The page looks professional. The trailer sells the fantasy.

---

## Post-Launch Roadmap (Future Scope)

These features are not in scope until the base game ships and performs well. Listed here to capture the vision without letting it bloat the MVP.

### v1.1 — Quality of Life
- Mission replay from campaign map
- Extended vehicle customization options
- Additional visual mods per vehicle
- Community feedback integration

### v1.2 — New Content
- Additional missions (side jobs, optional contracts)
- One additional vehicle class
- Expanded Obsidian Bay map areas
- Additional gadgets

### v2.0 — Cop Mode
- Play as pursuit units
- Coordinate with AI partners
- Catch the Ghost Driver (AI or player-controlled)
- Separate progression system

### v3.0 — Multiplayer
- One Ghost Driver vs multiple Cop players
- BeamMP-style session system
- Cosmetic system introduced for multiplayer identity
- Leaderboards and session stats

### Ghost Driver: Origins (Separate Game)
- Prequel campaign
- Younger Ghost Driver, origin story
- New city or earlier version of Obsidian Bay
- Expands lore established in base game

---

## Scope Protection Rules
These rules exist to protect the project from scope creep — the primary cause of unfinished indie games:

1. **No new features in Phases 0-3.** The core loop comes first. Everything else waits.
2. **One phase at a time.** Don't start Phase 2 until Phase 1 exit criteria are met.
3. **Fun before polish.** Placeholder art is fine until Phase 7. Unpolished fun beats polished boredom.
4. **When in doubt, cut.** A feature that doesn't serve the chase or the ditch doesn't belong in MVP.
5. **The demo is the milestone.** Phase 5 completion is the first real achievement. Everything before it is building toward that moment.
6. **Post-launch features stay post-launch.** Cop mode and multiplayer are not in scope until the base game ships. No exceptions.

---

## Realistic Timeline Estimate
Solo developer, AI-assisted, part-time development:

| Phase | Estimated Duration |
|-------|-------------------|
| Phase 0 — Foundation | 1-2 weeks |
| Phase 1 — The Chase | 2-3 weeks |
| Phase 2 — The Ditch | 2-3 weeks |
| Phase 3 — One Mission | 2-4 weeks |
| Phase 4 — The Garage | 3-4 weeks |
| Phase 5 — MVP Campaign | 4-6 weeks |
| Phase 6 — Full Campaign | 8-12 weeks |
| Phase 7 — Polish | 4-6 weeks |
| Phase 8 — Steam | 2-4 weeks |

**Total estimate: 6-10 months part-time**

This is a realistic range, not a deadline. Quality over speed. The exit criteria matter more than the timeline.
