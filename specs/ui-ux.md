# Ghost Driver — UI / UX

## Philosophy
Every screen in Ghost Driver should feel like it belongs in Obsidian Bay. The UI is not a layer on top of the game — it is part of the world. Art Deco geometry, noir typography, amber and neon color palette. Functional first, atmospheric always.

UI that requires reading during a chase has failed. Everything in the HUD must be readable at a glance.

---

## Design Language

### Typography
- **Primary font:** Art Deco inspired — geometric, strong verticals, period appropriate
- **Secondary font:** Clean monospace for data readouts (cash amounts, timers, stats)
- **All caps** for headers and labels — period newspaper aesthetic
- No rounded modern fonts anywhere in the game

### Color Palette
| Use | Color |
|-----|-------|
| Background / dark | Deep black `#0a0a0f` |
| Primary text | Warm off-white `#f0e6cc` |
| Accent / highlight | Amber `#c8882a` |
| Danger / pursuit | Deep red `#8b1a1a` |
| Cooldown / safe | Teal `#1a6b6b` |
| Neon accent 1 | Electric green `#39ff14` |
| Neon accent 2 | Hot pink `#ff2d78` |
| Disabled / locked | Dark grey `#3a3a3a` |

### Visual Motifs
- Art Deco geometric borders — chevrons, fan shapes, stepped frames
- Horizontal rule dividers with center ornament
- Subtle film grain overlay on all screens
- Rain streaks on glass effect for menu backgrounds
- Holographic shimmer on wanted poster elements
- Riveted metal texture on panel backgrounds

---

## Screen Inventory

### 1. Main Menu
The first impression of Ghost Driver. Sets tone immediately.

**Layout:**
- Full screen animated background — aerial view of Obsidian Bay at night, rain falling, neon reflections on the harbor
- Game logo centered — GHOST DRIVER in Art Deco lettering, amber on black
- Tagline beneath logo: *"They never see you coming. They never see you go."*
- Menu options centered below:
  - NEW GAME
  - CONTINUE
  - GARAGE
  - SETTINGS
  - QUIT

**Atmosphere:**
- Jazz/noir ambient track playing softly
- Rain sound layer under music
- Subtle camera drift on background — slow pan across the city
- Logo has a faint neon flicker animation — not distracting, just alive

---

### 2. Mission Briefing Screen
The narrative moment before every mission. Sets stakes, establishes tone, delivers objective.

**Layout:**
- Dark panel taking up 60% of screen width, centered
- Illustrated backdrop behind panel — Obsidian Bay location relevant to the mission (financial district, docks, etc.) in noir illustration style
- Top: Mission number and name in Art Deco header — "MISSION 01 — FIRST RUN"
- Body: Internal monologue of the Ghost Driver — short, noir-voiced, first person
- Bottom section: Objective summary — clean, brief, no more than two lines
- Vehicle and notoriety status shown bottom left — reminder of current heat
- Two buttons: GARAGE (returns to loadout) and BEGIN

**Writing tone:**
Terse. Cinematic. The Ghost Driver doesn't waste words.
*"Bank job. Clean exit, they said. The cops hit the block before I hit the wheel. Clean exit. Right."*

---

### 3. Garage / Loadout Screen
The management hub between missions. Where strategy happens.

**Layout — Three Panels:**

**Left Panel — Vehicle Fleet**
- Grid of owned vehicles showing top-down sprites
- Each vehicle card shows:
  - Vehicle name
  - Notoriety tier (color coded — clean green through legendary red)
  - Stat bars (speed, handling, durability — abbreviated)
  - Gadget slots available / total
- Selected vehicle highlighted with amber border
- Locked/unowned vehicle slots shown greyed with purchase price

**Center Panel — Selected Vehicle Detail**
- Front 3/4 illustration of selected vehicle — large, cinematic
- Vehicle name and flavor text below illustration
- Notoriety tier with decay progress indicator
- Action buttons:
  - VISUAL MODS (repaint, plates, body kit — notoriety reduction)
  - UPGRADE SLOTS (purchase additional gadget slots)
  - BURN VEHICLE (confirmation required — nuclear option)
- Rear 3/4 illustration toggle — tap to flip between front and rear view

**Right Panel — Gadget Loadout**
- Shows available gadget slots for selected vehicle
- Each slot shows equipped gadget or empty slot indicator
- Tap a slot to open gadget selection overlay
- Gadget selection overlay shows:
  - All unlocked gadgets with icons and brief descriptions
  - Cooldown duration or use count shown per gadget
  - Locked gadgets greyed with unlock requirement
- Currency balance shown top right — always visible
- PROCEED TO MISSION button bottom right

---

### 4. HUD (In-Game Heads Up Display)
The most important UI in the game. Must be readable at 60mph in the rain.

**Design principles:**
- Minimal — only what the player needs right now
- Positioned at screen edges — never obscures the road ahead
- State-aware — elements appear and disappear based on pursuit state
- Readable at a glance — no text that requires reading during a chase

#### HUD Elements

**Pursuit Level Indicator — Top Center**
- Five police badge icons in a horizontal row
- Filled badges = active pursuit level (amber glow)
- Empty badges = inactive levels (dark, barely visible)
- At level 5 all badges pulse red — maximum urgency
- Subtle "WANTED" text flash when level increases

**Cooldown Timer — Center Screen (Cooldown state only)**
- Large circular timer, prominent
- Teal color — signals safety / progress
- Counts down to zero
- Disappears instantly if pursuit resumes (timer reset)
- On reaching zero: "GHOST" flash — large, centered, amber — then fades

**Objective Reminder — Top Left**
- Small text card, one or two lines maximum
- Shows current objective only
- Fades to 50% opacity during active pursuit — present but not distracting
- Pulses briefly when objective becomes completable (cooldown achieved)

**Vehicle Health — Bottom Left**
- Horizontal bar, subtle
- Color shifts amber → red as damage accumulates
- Small vehicle icon beside it
- Smoke particle effect on vehicle sprite mirrors health state

**Notoriety Indicator — Bottom Left (below health)**
- Current vehicle's notoriety tier shown as colored dot + tier name
- Reminder that this vehicle is accumulating heat
- Subtle — not meant to demand attention during chase

**Minimap — Bottom Right**
- Circular minimap, moderate size
- Shows immediate surrounding area
- Player car: white dot, center
- Cop cars: red dots
- Active objective: gold marker
- Parking garages: small P indicator
- Toggleable with M key — some players prefer clean screen
- During cooldown: cop dots show search pattern movement

**Speed Indicator — Bottom Center (optional)**
- Subtle analog gauge aesthetic — Art Deco dial
- Not critical information but adds atmosphere
- Can be toggled off in settings

**Gadget Bar — Bottom Center**
- Row of equipped gadget icons
- Active cooldown shown as depleting overlay on icon
- Limited use gadgets show remaining use count
- Selected gadget highlighted
- Cycle through gadgets with Q/E or d-pad

**Lights Indicator — Bottom Left (small)**
- Small headlight icon
- Lit = lights on / Dim = lights off (Kill Lights active)
- Only relevant in dark conditions — could auto-hide in daylight missions

#### HUD States

**Active Pursuit**
- Pursuit badges glow and pulse at current level
- Cooldown timer hidden
- Objective reminder fades to 50%
- Screen edge vignette darkens — subtle red tint
- Intensity increases with pursuit level

**Cooldown**
- Cooldown timer appears large and prominent
- Pursuit badges dim
- Objective reminder pulses — completable now
- Screen edge vignette shifts to teal
- Minimap shows cop search pattern

**Ditched**
- "GHOST" flash — large, amber, centered, fades after 2 seconds
- All pursuit indicators dim to inactive
- Brief moment of silence in audio before mission complete triggers
- Screen vignette clears

**Undercover**
- Pursuit badges replaced by a single COVER indicator (green = safe)
- Speed warning indicator appears — exceeding safe speed flashes the cover indicator
- Normal HUD elements hidden — cleaner, more tense

---

### 5. Mission Complete Screen
The payoff screen. Should feel like a win even on tough missions.

**Layout:**
- Dark overlay fades in over gameplay
- "GHOST" text large at top — the identity confirmation
- Mission name and number
- Star rating (1-3 stars) with criteria breakdown:
  - Time completed
  - Pursuit level reached (lower = better)
  - Civilian collisions
  - Gadgets used (clean run bonus)
- Cash earned — large, amber, counts up with a satisfying animation
- Unlocks revealed if applicable (new gadget, vehicle, next mission)
- Buttons: CONTINUE / RETRY / GARAGE

---

### 6. Mission Failed Screen
Respectful. Not punishing. Get them back in quickly.

**Layout:**
- Dark red tinted overlay
- "BLOWN" in large Art Deco text — the opposite of GHOST
- Brief one-line failure reason: "Pursuit caught up." / "Vehicle destroyed." / "Cover blown."
- No lengthy penalty — just the fact
- Buttons: RETRY / GARAGE
- Retry loads instantly — friction-free return to the mission

---

### 7. Settings Screen
Clean and functional. No unnecessary complexity.

**Options:**
- Master volume / Music volume / SFX volume
- Display resolution
- Fullscreen toggle
- Control remapping (keyboard)
- Gamepad sensitivity
- Minimap toggle default
- Speed indicator toggle
- Colorblind mode (adjusts red/green indicators)
- Language (future)

---

### 8. Pause Menu
Minimal. Accessible mid-mission without breaking immersion.

**Options:**
- RESUME
- RESTART MISSION
- GARAGE (returns to loadout, restarts mission)
- SETTINGS
- MAIN MENU (confirmation required)

**Visual:**
- Blurred gameplay visible behind pause overlay
- Rain continues falling on the blurred background
- Audio ducks but doesn't stop completely — the city keeps breathing

---

## Transition Design
Transitions between screens should feel cinematic, not functional.

- **Into mission:** Briefing screen fades to black, then snaps to gameplay mid-action — no loading screen visible
- **Mission complete:** Gameplay freezes on the ditch moment, "GHOST" flash, then complete screen fades in
- **Mission failed:** Gameplay freezes on caught moment, brief pause, "BLOWN" fade in
- **Into garage:** Art Deco geometric wipe — panels slide in from edges
- **Between screens:** Default fade through black with film grain

---

## MVP UI Scope
Not all UI needs to be polished for Phase 5. Prioritized for MVP:

**Must be functional and styled for demo:**
- Main Menu
- Mission Briefing (text only, no illustrated backdrop yet)
- HUD (all elements functional, Art Deco style applied)
- Mission Complete screen
- Mission Failed screen
- Basic Garage screen (functional, placeholder illustrations)

**Can be placeholder for demo:**
- Settings screen (functional but unstyled)
- Garage illustrations (placeholder sprites until art pass)
- Transition animations (simple fade until polish phase)
- Animated main menu background (static image until polish phase)

**Deferred to Phase 7 (Polish):**
- Illustrated mission briefing backdrops
- Animated main menu
- Front 3/4 and rear 3/4 garage illustrations
- Full transition animation suite
- Film grain and rain glass overlays
- Art Deco border detail work
