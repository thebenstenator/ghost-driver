# Ghost Driver — Gameplay Mechanics

## Philosophy
Every mechanic should serve one of two feelings: the thrill of the chase, or the satisfaction of the vanish. If a system doesn't contribute to either, it doesn't belong in Ghost Driver.

---

## Camera
- Top-down 2D, fixed overhead angle
- Camera follows the player car smoothly with slight lag — gives a sense of speed
- Slight zoom out at higher speeds to show more of the road ahead
- Minimap in HUD corner shows cop positions and objective markers

---

## Car Handling
Ghost Driver uses arcade physics — responsive and fun over realistic simulation. The goal is a car that feels weighty and satisfying without being a sim.

### Core Properties (per vehicle)
- **Speed** — top speed
- **Acceleration** — how quickly it reaches top speed
- **Handling** — turn radius and responsiveness
- **Mass** — affects collision force and ramming capability
- **Brake Force** — stopping distance

### Handling Feel
- Cars have momentum — you can't instantly change direction
- Handbrake triggers a drift/slide — essential for tight corner escapes
- Heavier vehicles (armored trucks) feel planted but slow to turn
- Sports cars are twitchy and fast but harder to control at speed
- All vehicles are controllable — none should feel punishing to drive

### Controls
- **WASD or Arrow Keys** — accelerate, brake/reverse, steer
- **Spacebar** — handbrake / drift
- **L** — kill lights (turns off headlights, reduces visibility to cops at night/dark areas)
- **M** — toggle minimap
- **Gamepad support** — left stick steer, right trigger accelerate, left trigger brake, face button handbrake

---

## Pursuit System
The heart of Ghost Driver. Pursuit is a dynamic, escalating system — not a binary "chasing / not chasing" state.

### Pursuit Levels (1–5)
Each level represents how hard the cops are looking for you:

| Level | Trigger | Response |
|-------|---------|----------|
| 1 | Spotted by a single unit | 1-2 patrol cars, basic pursuit |
| 2 | Sustained chase or minor collision | 3-4 units, faster response times |
| 3 | Extended chase, roadblock evaded | Roadblocks set ahead, units attempt to box in |
| 4 | Multiple roadblocks evaded, significant damage caused | Spike strips deployed, helicopter surveillance begins |
| 5 | Prolonged high-speed chase, helicopter active | Maximum units, spike strips on all major routes, helicopter tracks even when out of sight |

### Pursuit Escalation
- Pursuit level increases over time during active chase
- Increases faster if player causes collisions, damages cop cars, or evades roadblocks
- Does NOT increase during cooldown phase
- Resets to 0 only when ditch is fully completed

### Cop Unit Types
- **Patrol Car** — standard pursuit unit, moderate speed, attempts to follow
- **Interceptor** — faster than player sports cars, appears at level 3+
- **Roadblock Unit** — positions cars across road ahead of player's predicted path
- **Spike Strip Unit** — deploys strips at chokepoints, level 4+
- **Helicopter** — tracks player position even through line-of-sight breaks, level 4+. Cannot be ditched by hiding — must break its visual range entirely

---

## Cop AI Behavior
Cops don't just chase — they think (within limits). The goal is AI that feels threatening and clever without being unfair.

### Pursuit Behavior
- **Chaser units** follow the player's actual position
- **Interceptor units** predict player path and cut off routes ahead
- **Flanking** — at level 2+, units attempt to approach from side streets
- **Boxing** — units try to surround the player and slow them to a stop
- Cops avoid excessive collisions with civilians — they're police, not demolition cars

### Communication Simulation
- Cops share player's last known position
- If player breaks line of sight, cops converge on last known location
- After a set time with no sighting, cops begin search pattern radiating outward
- Search pattern is the window the player exploits to complete the ditch

### Cop Car Disabling
Cop cars can be fully disabled and removed from pursuit — but it comes at a cost. This is a skilled driving game, not a combat game. The satisfaction comes from outsmarting cops, not destroying them.

**Disabled, Not Destroyed**
- Disabled cop cars spin out, smoke from the hood, and come to a stop
- Officers climb out on foot — unharmed, just out of the chase
- The car is gone from pursuit but the radio call goes out immediately
- Every disable raises pursuit level faster — it's a tradeoff, not a free win

**Methods of Disabling**
- **Ram into obstacles** — bait a pursuing cop into a barrier, wall, or parked car. Skill-based setup, most satisfying method.
- **Player spike strips** — deploy behind you, pursuing cops hit them and blow tires, grinding to a stop
- **EMP blast** — temporarily disables all nearby cop electronics. Cars stall for 10-15 seconds then recover. Not a permanent disable but buys critical time.
- **Destructible environment** — knock a market stall or barrier into a cop's path
- **Baiting into civilian traffic** — lure a pursuer into a busy intersection. Risky — civilian collisions raise heat too.
- **Pinch maneuver reversal** — when cops attempt to box you in, use their own momentum against them by braking sharply and letting them overshoot into each other or obstacles

**The Tradeoff**
- Each disable = immediate pursuit level escalation
- Disabling aggressively is a valid strategy but guarantees harder reinforcements sooner
- Sometimes the smarter play is to avoid cops entirely rather than take them out
- Late campaign elite units are harder to disable and recover faster

**What Cannot Disable Cops**
- Direct frontal ramming at speed — cops are heavier than they look, player takes more damage than they do
- Gadgets alone without environmental setup (EMP excepted)
- Violence of any kind — this is a driving game, not GTA

### Difficulty Scaling
- Early missions: cops react slowly, pursue predictably, give up quickly
- Mid missions: faster reaction, some flanking, longer pursuit endurance, faster recovery from disables
- Late missions: near-instant response, coordinated tactics, helicopters deployed quickly, elite units resistant to basic disable attempts

---

## The Ditch Mechanic
The defining skill of Ghost Driver. Simply outrunning cops is not enough — you must fully vanish.

### Pursuit States
1. **Active Pursuit** — cops have visual on player. Pursuit level escalates. No objectives can be completed.
2. **Cooldown** — player has broken line of sight. Cooldown timer begins counting down. Cops searching last known location. Mid-mission objectives CAN be completed during this window.
3. **Ditched** — cooldown timer expires with no re-sighting. Cops stand down. Mission complete condition met.

### Cooldown Timer
- Duration scales with current pursuit level (level 1 = shorter, level 5 = much longer)
- Timer resets immediately if any cop re-acquires visual on player
- Helicopter resets timer even without ground unit sighting — must evade helicopter separately
- Timer displayed prominently in HUD during cooldown phase

### Ditch Techniques
These are environmental tools the player uses to break and maintain lost-sight status:

- **Parking Garages** — enter and stop. Cops cannot see inside. Timer runs. Must exit carefully.
- **Kill Lights** — reduces detection radius significantly in dark areas and at night. Useless in daylight/well-lit streets.
- **Alleyways** — narrow routes cops in large vehicles cannot follow. Breaks pursuit chain.
- **Destructible Blockades** — crash through fences, barriers, market stalls to access shortcuts cops don't know about
- **Decoy Routes** — lure cops down one street, double back while they're committed
- **Tunnels** — breaks helicopter line of sight while inside

### Helicopter Counter-Play
Helicopter is the hardest pursuit element to shake:
- Fly over is indicated by spotlight on player
- Must get under cover (parking garage, tunnel, dense building overhang) to break spotlight
- Once spotlight broken, helicopter must relocate — takes time
- Destroying helicopter is not possible (keeps tone grounded, avoids escalation loop)

---

## Notoriety System
Notoriety is the game's risk/reward backbone.

### How It Works
- Notoriety is tracked **per vehicle**, not per player
- Completing jobs in a vehicle increases that vehicle's notoriety
- Higher notoriety = faster initial police response, higher starting pursuit level, more aggressive AI

### Notoriety Tiers
| Tier | Name | Effect |
|------|------|--------|
| 0 | Clean | No heat. Normal police response. |
| 1 | Known | Slightly faster response. Cops recognize the vehicle on sight. |
| 2 | Wanted | Pursuit starts at level 2. Interceptors deployed sooner. |
| 3 | Notorious | Pursuit starts at level 3. Roadblocks pre-positioned. |
| 4 | Legendary | Maximum heat. Pursuit starts at level 4. Elite units deployed immediately. |

### Notoriety Decay
Notoriety is not permanent — it can be reduced through passive decay and active measures. This prevents the garage from becoming a dead end of hot vehicles.

**Passive Decay**
- Every 3-4 missions completed using OTHER vehicles ticks notoriety down one tier on idle vehicles
- Represents heat cooling naturally — cops move on, witnesses forget, time passes
- Rewards smart vehicle rotation — players who spread jobs across their garage keep heat manageable
- Decay does not apply to the vehicle currently being used

**Active Reduction — Visual Modifications**
- Players can spend in-game currency on visual mods to immediately reduce notoriety
- Available in the garage screen
- Mod options: repaint (new color/finish), plate swap, body kit change, window tint
- Each mod reduces notoriety by roughly one tier
- Multiple mods can be stacked for larger reductions on heavily notorious vehicles
- Visual changes are reflected in the garage screen art — the car actually looks different
- Narrative flavor: the Ghost Driver changes the car's appearance so cops can't recognize it

**Burning a Vehicle**
- Nuclear option — player abandons/destroys a vehicle entirely
- Removes it from garage permanently
- Grants a cash bonus (insurance payout, scrap value)
- Frees the garage slot for a new clean vehicle
- Best used when a vehicle is Legendary tier and the cost of mods outweighs its value

### Vehicle Management Strategy
- Players build a garage of vehicles with varying notoriety levels
- Smart players rotate vehicles across jobs to trigger passive decay on idle cars
- Some jobs REQUIRE specific vehicle types (armored truck for cash transport, sports car for high-speed extraction)
- Visual mods serve dual purpose — cosmetic identity AND heat management
- Currency decisions: spend on mods to cool a hot vehicle, or burn it and buy something new?

---

## Destructible Environment
Supports both the chase feel and the ditch mechanic.

### Destructible Elements
- **Market stalls / street vendors** — crash through for shortcuts, leave debris that slows cops
- **Wooden fences / barriers** — break through to access back alleys
- **Parked cars** — can be rammed, become obstacles for pursuing cops
- **Fire hydrants** — burst on impact, temporary water spray obscures view
- **Trash cans / dumpsters** — scatter debris, minor obstacles
- **Road barriers** — cops deploy these, player can ram through at cost of vehicle damage

### What Is NOT Destructible
- Buildings — keep map readable and navigation consistent
- Bridge structures — avoid exploitable geometry
- Cop cars cannot be destroyed — disabled temporarily by ramming but return to pursuit

### Vehicle Damage
- Player car accumulates damage from collisions
- Damage affects handling (damaged tire = pull to one side, damaged engine = reduced top speed)
- Visible on car sprite — scratches, dents, smoke
- Repaired between missions automatically (narrative: your crew fixes it overnight)
- Mid-mission repair not available — encourages careful driving

---

## HUD (Heads Up Display)
Clean and readable. Noir aesthetic. Never obscures gameplay.

### HUD Elements
- **Pursuit Level indicator** — top center, 1-5 stars (noir style — could be police badges)
- **Cooldown Timer** — large, prominent when in cooldown state. Hidden during active pursuit and ditched states.
- **Vehicle Health bar** — bottom left, subtle
- **Notoriety indicator** — bottom left, shows current vehicle's notoriety tier
- **Minimap** — bottom right, shows immediate area, cop positions (red dots), objectives (gold markers)
- **Objective reminder** — top left, brief text showing current task
- **Lights indicator** — small icon showing whether headlights are on or off
- **Speed indicator** — optional, bottom center

### HUD States
- **Active Pursuit** — pursuit level pulses/glows. Cooldown timer hidden.
- **Cooldown** — timer appears large and counting. Pursuit level dims.
- **Ditched** — brief "GHOST" flash on screen. All indicators dim. Mission complete triggers.

---

## Undercover Mechanic
Select missions begin in an undercover phase — the Ghost Driver is operating in disguise, blending into the city before the job goes loud. These missions are special events in the campaign, not the standard formula. They add a layer of tension distinct from the chase — the threat of discovery rather than the chaos of pursuit.

### How It Works
- Player starts in a cover vehicle (delivery van, work truck, taxi, police vehicle etc.)
- Cops are present but not alerted — normal city traffic
- Player has an undercover objective to complete before the mission goes loud
- Cover is maintained by following basic traffic rules and avoiding suspicious behavior

### Blowing Cover
Cover is blown by:
- Speeding significantly or running red lights
- Getting too close to a cop car long enough for inspection
- A civilian witnessing something suspicious and calling it in
- A mission-specific trigger (a contact recognizes you, a timer expires)
- **Player choice** — deliberately blowing cover to skip the stealth phase entirely

### The Two Paths
**Stealth path** — complete the undercover objective without detection. Cops are never alerted. Mission transitions directly to the ditch/delivery phase with zero pursuit. Higher cash reward for clean completion.

**Guns blazing path** — blow cover intentionally or accidentally. Chase phase begins immediately. Cover vehicle is slower and not built for escape — sprint to the preset swap car before pursuit overwhelms you.

### The Swap Car
- Every undercover mission has a preset swap car hidden nearby
- Location is shown on minimap once cover is blown
- The swap car is always positioned with intention — close enough to reach, far enough to create urgency
- Vehicle type varies by mission — sometimes a sports car, sometimes something unexpected
- Swap car enters the garage after mission completion

### Gadget Consideration
Undercover missions create unique loadout decisions:
- Gadgets useful for the chase phase may be useless during undercover
- Stealth-path players may want Chassis Cloak or Scrambler
- Guns-blazing players front-load escape gadgets
- No single loadout is optimal for both paths — player must choose their intent before the mission

### Cover Vehicle Behavior
- Cover vehicles handle differently — heavier, slower, not built for pursuit
- Cannot perform handbrake slides without immediately blowing cover
- Gadgets are hidden and cannot be used during undercover phase — activating one blows cover instantly
- Kill Lights available but suspicious at daytime

### Reward Structure
- **Clean completion** (undercover objective completed without detection) — full cash reward + bonus
- **Blown cover, swap car used** — standard cash reward
- **Blown cover, escaped in cover vehicle** — reduced reward (harder, less optimal, but valid)

---
Gadgets are the wild cards of Ghost Driver. They give players identity, enable creative escapes, and make each run feel different. Rooted in the retro-futuristic noir setting — think James Bond meets 1920s gangster tech.

### Core Rules
- Gadgets are **unlocked permanently** with in-game currency — no consumables, no restocking
- Once unlocked, a gadget is always available to equip
- Gadgets **recharge between missions** automatically
- Players select a **loadout before each mission** from their unlocked gadget library
- Each vehicle has a **base slot count** and an **upgradeable maximum cap**
- Slot upgrades are purchased per vehicle with in-game currency

### Slot Counts by Vehicle Type
| Vehicle Type | Base Slots | Max Slots |
|-------------|-----------|----------|
| Sports Car | 1 | 3 |
| Sedan | 2 | 4 |
| SUV | 3 | 5 |
| Armored Truck | 3 | 6 |
| Specialty | Varies | Varies |

### Economy Balance
Players must choose how to spend in-game currency across:
- Buying new vehicles
- Upgrading gadget slots per vehicle
- Unlocking new gadgets
- Cosmetic customization (future)

No single path is dominant — a player who invests in gadgets on a modest vehicle can outperform a player with an expensive car and no tools.

### Gadget Roster

#### Escape Gadgets
- **Oil Slick** — deploys a slick behind the car. Pursuing cops hit it and spin out. Classic. *(Starter gadget — available early)* **[Limited uses: 2 per mission]**
- **Smoke Screen** — releases a dense cloud behind the car. Breaks cop line of sight temporarily. Useful for initiating cooldown phase. **[Limited uses: 2 per mission]**
- **Spike Strips** — player-deployed strips behind the car. Damages cop tires, slows pursuit significantly. Ironic reversal of a cop tool. **[Limited uses: 2 per mission]**
- **Decoy Beacon** — drops a device that broadcasts the player's GPS signal from a stationary point. Cops swarm the beacon while player goes dark. High skill ceiling. **[Limited uses: 1 per mission]**
- **EMP Blast** — short range pulse that disables cop cars and helicopter electronics briefly. Stalls pursuit completely for a few seconds. Powerful — unlocked mid-campaign. **[Cooldown: long]**

#### Movement Gadgets
- **Nitro Boost** — short burst of extreme acceleration. Good for breaking out of boxing attempts or clearing a roadblock gap. *(Starter gadget)* **[Cooldown: short]**
- **Grappling Hook** — dual purpose tool, the most skill-expressive gadget in the roster:
  - *Cornering* — fires at a fixed anchor point on a building corner, whipping the car around tight turns at speed without losing momentum
  - *Environmental weapon* — fires at a parked car and slings it into the road behind you, creating an instant improvised blockade for pursuing cops. Requires a parked car in range and the awareness to spot the opportunity mid-chase.
  High skill ceiling, high reward. Unlocked late campaign — feels earned when you finally get it. **[Cooldown: medium]**
- **Chassis Cloak** — briefly removes the player's vehicle from cop minimap and dispatch systems. Ground units lose predicted path data. Does not affect helicopter spotlight. **[Cooldown: long]**

#### Utility Gadgets
- **Scrambler** — jams police radio for a short duration. Slows reinforcement calls, delays pursuit level escalation. Strategic — best used just before level jump. **[Cooldown: medium]**
- **Repair Kit** — restores partial vehicle health mid-mission. **[Limited uses: 1 per mission]**
- **Bribe Drop** — tosses a cash bundle out the window. Causes civilian vehicles to swerve and stop, creating a roadblock of chaos behind you. Slows cops more than it helps them. **[Limited uses: 2 per mission]**

#### Upgrade Effect on Gadgets
Gadget upgrades are purchasable with in-game currency and apply per gadget:
- **Cooldown gadgets** — upgrades reduce recharge time
- **Limited use gadgets** — upgrades increase uses per mission (e.g. Oil Slick goes from 2 to 3 uses)
- Upgrades represent another meaningful currency decision alongside vehicles, slots, and visual mods

### Gadget Unlock Progression
Gadgets unlock through campaign progression AND currency purchase — you need both to unlock (reach the mission tier that makes it available, then buy it):

| Unlock Tier | Gadgets Available |
|-------------|------------------|
| Starting | Oil Slick, Nitro Boost |
| Early Campaign | Smoke Screen, Repair Kit |
| Mid Campaign | Spike Strips, Scrambler, Bribe Drop, Chassis Cloak |
| Late Campaign | EMP Blast, Decoy Beacon, Grappling Hook |

### Pre-Mission Loadout Screen
- Shown after mission briefing, before mission starts
- Displays current vehicle's available slots
- Shows all unlocked gadgets with brief descriptions
- Locked gadgets shown greyed out with unlock requirement
- Loadout is saved per vehicle as a default — can be changed each mission

---

## Game Feel Details
Small details that make Ghost Driver feel polished:

- Tire squeal on hard turns and handbrake slides
- Engine pitch changes with speed
- Screen edge vignette darkens during high pursuit levels — increases tension
- Rain effects always present — puddle splashes, wet road reflections
- Police siren audio pans left/right based on cop position relative to player
- "WANTED" flash on screen when pursuit level increases
- Slow motion (0.5s) on near-miss collision — emphasizes danger
- Camera shake on heavy impacts
- Cop headlights visible before the car is — gives player warning of incoming units
