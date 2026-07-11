# Railway System Add-On (Minecraft Bedrock)

A metro-style railway for Minecraft Bedrock Edition (1.21.80+): lay 3-wide track
lines, and trains automatically depart on a schedule, stop at stations so players
can board, and run to the end of the line. Includes live arrival screens and
escalators for building proper stations.

Trains are **simulated virtually** — once a line has been surveyed, its trains
keep running on time even while the chunks are unloaded. A physical, rideable
train only appears when a player is nearby, exactly where the simulation says
it should be. Stations and lines can be **named**, and trains make conductor
**callouts** to riders: *"Next station: Glenmont"*.

**No experimental toggles required** — everything uses stable APIs.

## Install

Grab `dist/TrainsRailway.mcaddon` and open it (double-click, or share it to
Minecraft on mobile). Then enable **both** packs on your world:

- Behavior pack: *Railway System [BP]*
- Resource pack: *Railway System [RP]*

## What's included

| Thing | Identifier | What it does |
|---|---|---|
| Railway Track | `trains:track` | The rail bed trains drive on (flat plate, rails align to how you face when placing) |
| Station Track | `trains:station_track` | Trains stop here for 6 seconds so players can board |
| Train Depot | `trains:depot_track` | Spawns a train on a schedule; the green arrow shows departure direction |
| Platform Block | `trains:platform` | Concrete shoulder used for the outer lanes of the 3-wide track bed |
| Arrival Screen | `trains:arrival_screen` | Glowing wall panel with floating live text: arrivals, boarding, next departure |
| Escalator (Up/Down) | `trains:escalator_up` / `_down` | Carries players up or down when they step on it |
| Track Planner | `trains:track_planner` | Wand that lays a whole 3×3 track segment (centre rail + platform shoulders) per use |
| Tunnel Maker | `trains:tunnel_maker` | Bores a 6×6×6 tunnel: digs out solid blocks and patches floor/walls/ceiling with cobblestone wherever there's a gap. Has 2 durability (unlimited in creative) |
| Train | `trains:train` | 8-seat rideable train with a walk-in interior (benches, open windows), spawned automatically by depots |

Everything is in the Creative inventory, or use `/give @s trains:track_planner` etc.

## Building your first line

1. **Lay the track.** Hold the **Track Planner** and use it on the ground: each
   use lays a 3×3 segment (3 wide as requested — centre rail plus two platform
   shoulders) heading the way you face. Use it on the end of an existing
   segment to extend the line. You can also hand-place `trains:track` blocks;
   the rails align to your facing.
2. **Add stations.** Swap a centre track block for **Station Track** wherever
   trains should stop. Build your platform beside it.
3. **Add a depot.** Place a **Train Depot** block *in* the track line at one
   end, facing down the line (green arrow = departure direction). A train
   departs every 60 seconds by default. Trains run **one way**: the last
   station on the line is the final stop — the train opens its doors there,
   then goes out of service and disappears. You set the final stop simply by
   which station is furthest along the line. (A line with no stations runs to
   the end of the track and disappears there.) For service in both directions,
   put a depot at each end.
   - **Interact** with the depot to see the line's status.
   - **Sneak + interact** to cycle the departure interval: 30s / 60s / 2min / 5min.
4. **Let the depot survey the line.** The depot walks the track once and
   memorizes the route (interact with it to watch progress). If the line spans
   unloaded chunks, just walk/fly/ride along it once so the survey can finish.
   **After that, trains run on schedule forever — even in unloaded chunks.**
   Editing the track triggers an automatic re-survey.
5. **Hang arrival screens.** Place an **Arrival Screen** on a wall facing the
   platform. It shows floating live text: the station's name, `Train arriving
   in ~12s`, `>> NOW BOARDING <<`, and the next scheduled departure.
6. **Add escalators.** Face the direction you want to travel, then place
   **Escalator (Up)** blocks in an ascending diagonal line (each one a block
   higher, going away from you). Step on and it carries you up and forward.
   **Escalator (Down)** works the same: face travel direction (downhill) while
   placing, on a descending diagonal. The steps and handrails visually ascend
   the right way — if they don't, you placed it while facing across the slope.
7. **Going underground?** Use the **Tunnel Maker** on a wall: each use bores a
   6-wide, 6-high, 6-deep tunnel in the direction you face — digging out rock
   and automatically lining the floor, walls and ceiling with cobblestone
   wherever it would otherwise be open air or water. It has 2 uses in survival
   (unlimited in creative).

## Naming stations & lines

Rename a **Name Tag** on an anvil (e.g. to `Glenmont`), then tap:

- a **Station Track** block with it → names that station,
- a **Train Depot** block with it → names that line (e.g. `Red Line`).

The name tag is not consumed. No anvil handy? Stand next to the station or
depot and run `/scriptevent trains:name Glenmont`.

Names show up everywhere: arrival screens use the nearest station's name as
their header, physical trains are labeled `Red Line — to Glenmont`, and the
conductor uses them in callouts.

## Riding & callouts

When a train pulls into a station it dwells for 6 seconds — walk up and
**interact** with it to board (8 seats). **Sneak** to get off.

While riding you get conductor callouts in chat and on the action bar:

- `Next station: Glenmont` when departing each stop (`Next and final station:`
  as you approach the last one)
- `This station is: Glenmont` on arrival
- `This is Glenmont — the final stop. All change, please!` at the last station,
  then the train goes out of service and disappears

Players on the platform see `Train now boarding at Glenmont` / `Doors closing`.

## Admin commands

- `/scriptevent trains:name <name>` — name the nearest station or depot (within 8 blocks)
- `/scriptevent trains:resurvey` — force every line in your dimension to re-scan its track
- `/scriptevent trains:clear` — remove all running trains

## Tips & limits

- Lines are **flat** (one Y level). Change levels at stations with escalators.
- Turns: track corners turn trains automatically; at T-junctions trains bear right.
- Trains **do** keep running through unloaded chunks (the simulation is
  chunk-independent once the line is surveyed) — you'll see them arrive on
  time when you get to the platform.
- Single track + two depots means head-on meets; like a real metro, busy lines
  work best double-tracked (one line per direction).
- If you place depots/screens/stations with commands or structures instead of
  by hand, interact with them once to register them.

## Repo layout / development

- `Trains_BP/` — behavior pack (blocks, entities, item, `scripts/main.js` drives everything)
- `Trains_RP/` — resource pack (geometry, textures, client entities, lang)
- `tools/gen_textures.py` — regenerates every PNG procedurally (stdlib only)
- `tools/package.py` — zips both packs into `dist/TrainsRailway.mcaddon`
- `./build.sh` — runs both

