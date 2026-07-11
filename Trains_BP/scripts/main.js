// Railway System — behavior driver
// Trains follow lines built from trains:track blocks, depart from depots on a
// schedule, dwell at stations for boarding, and despawn at the far terminus.

import { world, system, BlockPermutation } from "@minecraft/server";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const SPEED = 0.35; // blocks per tick (7 m/s)
const DWELL_TICKS = 120; // 6s stop at stations
const DEFAULT_INTERVAL = 1200; // 60s between trains
const INTERVALS = [600, 1200, 2400, 6000]; // 30s / 60s / 2min / 5min
const FIRST_SPAWN_DELAY = 100; // 5s after a depot is placed / world loads
const MAX_AGE_TICKS = 48000; // 40 min safety despawn
const MIN_TRIP_CELLS = 6; // cells travelled before a depot counts as terminus
const SCREEN_TRAIN_RANGE = 128;
const SCREEN_DEPOT_RANGE = 96;

const TRACK_TYPES = new Set(["trains:track", "trains:station_track", "trains:depot_track"]);
const DIM_IDS = ["overworld", "nether", "the_end"];
const DIRS = {
  north: { x: 0, z: -1 },
  south: { x: 0, z: 1 },
  east: { x: 1, z: 0 },
  west: { x: -1, z: 0 }
};

const K_DEPOTS = "trains:depots";
const K_SCREENS = "trains:screens";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const opposite = (d) => ({ x: -d.x, z: -d.z });
const leftOf = (d) => ({ x: d.z, z: -d.x });
const rightOf = (d) => ({ x: -d.z, z: d.x });

function yawOf(d) {
  if (d.z > 0) return 0; // south
  if (d.x < 0) return 90; // west
  if (d.z < 0) return 180; // north
  return 270; // east
}

function cardinalOf(d) {
  if (d.z < 0) return "north";
  if (d.z > 0) return "south";
  return d.x > 0 ? "east" : "west";
}

// Direction the player is looking, snapped to a cardinal.
function facingDir(player) {
  const y = ((player.getRotation().y % 360) + 360) % 360;
  if (y >= 315 || y < 45) return DIRS.south;
  if (y < 135) return DIRS.west;
  if (y < 225) return DIRS.north;
  return DIRS.east;
}

function safeBlock(dim, loc) {
  try {
    return dim.getBlock({ x: Math.floor(loc.x), y: Math.floor(loc.y), z: Math.floor(loc.z) });
  } catch {
    return undefined;
  }
}

function posKey(dimId, l) {
  return `${dimId}|${l.x},${l.y},${l.z}`;
}

function loadReg(key) {
  try {
    return JSON.parse(world.getDynamicProperty(key) ?? "[]");
  } catch {
    return [];
  }
}

function saveReg(key, list) {
  world.setDynamicProperty(key, JSON.stringify(list));
}

function announce(dim, loc, range, msg) {
  try {
    for (const p of dim.getPlayers({ location: loc, maxDistance: range })) {
      p.onScreenDisplay.setActionBar(msg);
    }
  } catch {}
}

// The cardinal_direction state points AT the player who placed the block
// (y_rotation_offset 180), so travel/facing directions are its opposite.
function travelDirOf(block) {
  const st = block.permutation.getState("minecraft:cardinal_direction") ?? "north";
  return opposite(DIRS[st] ?? DIRS.north);
}

// ---------------------------------------------------------------------------
// Registries: depots & screens
// ---------------------------------------------------------------------------
const depotNext = new Map(); // posKey -> tick of next departure (session only)

function registerDepot(block) {
  const list = loadReg(K_DEPOTS);
  const key = posKey(block.dimension.id, block.location);
  if (!list.some((e) => posKey(e.d, e) === key)) {
    const l = block.location;
    list.push({ d: block.dimension.id, x: l.x, y: l.y, z: l.z, i: DEFAULT_INTERVAL });
    saveReg(K_DEPOTS, list);
  }
  if (!depotNext.has(key)) depotNext.set(key, system.currentTick + FIRST_SPAWN_DELAY);
}

function unregisterDepot(dimId, l) {
  const key = posKey(dimId, l);
  saveReg(
    K_DEPOTS,
    loadReg(K_DEPOTS).filter((e) => posKey(e.d, e) !== key)
  );
  depotNext.delete(key);
}

function textEntityAt(dim, l) {
  try {
    const found = dim.getEntities({
      type: "trains:screen_text",
      location: { x: l.x + 0.5, y: l.y + 0.45, z: l.z + 0.5 },
      maxDistance: 1.0
    });
    return found[0];
  } catch {
    return undefined;
  }
}

function ensureTextEntity(dim, l) {
  let e = textEntityAt(dim, l);
  if (!e) {
    try {
      e = dim.spawnEntity("trains:screen_text", { x: l.x + 0.5, y: l.y + 0.45, z: l.z + 0.5 });
    } catch {
      return undefined;
    }
  }
  return e;
}

function registerScreen(block) {
  const list = loadReg(K_SCREENS);
  const key = posKey(block.dimension.id, block.location);
  if (!list.some((e) => posKey(e.d, e) === key)) {
    const l = block.location;
    list.push({ d: block.dimension.id, x: l.x, y: l.y, z: l.z });
    saveReg(K_SCREENS, list);
  }
  ensureTextEntity(block.dimension, block.location);
}

function unregisterScreen(dimId, l) {
  const key = posKey(dimId, l);
  saveReg(
    K_SCREENS,
    loadReg(K_SCREENS).filter((e) => posKey(e.d, e) !== key)
  );
  try {
    const e = textEntityAt(world.getDimension(dimId), l);
    if (e) e.remove();
  } catch {}
}

// ---------------------------------------------------------------------------
// Block place / break / interact events
// ---------------------------------------------------------------------------
world.afterEvents.playerPlaceBlock.subscribe((ev) => {
  const t = ev.block.typeId;
  if (t === "trains:depot_track") registerDepot(ev.block);
  else if (t === "trains:arrival_screen") registerScreen(ev.block);
});

world.afterEvents.playerBreakBlock.subscribe((ev) => {
  const t = ev.brokenBlockPermutation.type.id;
  if (t === "trains:depot_track") unregisterDepot(ev.dimension.id, ev.block.location);
  else if (t === "trains:arrival_screen") unregisterScreen(ev.dimension.id, ev.block.location);
});

world.afterEvents.playerInteractWithBlock.subscribe((ev) => {
  if (ev.isFirstEvent === false) return;
  const { block, player } = ev;
  if (!player) return;
  if (ev.itemStack?.typeId === "trains:track_planner") {
    tryPlaceSegment(player, block);
    return;
  }
  if (block.typeId === "trains:depot_track") depotInteract(player, block);
  else if (block.typeId === "trains:arrival_screen") {
    registerScreen(block);
    player.onScreenDisplay.setActionBar("§bArrival screen linked.");
  }
});

// Using the planner in the air: build where the player is looking.
world.afterEvents.itemUse.subscribe((ev) => {
  if (ev.itemStack?.typeId !== "trains:track_planner") return;
  const p = ev.source;
  if (!p || p.typeId !== "minecraft:player") return;
  const hit = p.getBlockFromViewDirection({ maxDistance: 12 });
  if (hit?.block) tryPlaceSegment(p, hit.block);
});

// ---------------------------------------------------------------------------
// Track planner: lays a 3x3 segment (centre rail + platform shoulders)
// ---------------------------------------------------------------------------
const wandCooldown = new Map(); // playerId -> tick

function tryPlaceSegment(player, base) {
  const tick = system.currentTick;
  if ((wandCooldown.get(player.id) ?? -10) > tick - 4) return; // both events can fire per click
  wandCooldown.set(player.id, tick);

  const dim = player.dimension;
  const d = facingDir(player);
  const perp = { x: -d.z, z: d.x };
  const bl = base.location;
  const extending = TRACK_TYPES.has(base.typeId) || base.typeId === "trains:platform";
  const y = extending ? bl.y : bl.y + 1;

  let placed = 0;
  for (let f = 0; f < 3; f++) {
    for (let s = -1; s <= 1; s++) {
      const pos = { x: bl.x + d.x * f + perp.x * s, y, z: bl.z + d.z * f + perp.z * s };
      const b = safeBlock(dim, pos);
      if (!b) continue;
      try {
        if (s === 0) {
          if (b.isAir || b.isLiquid || b.typeId === "trains:platform") {
            b.setPermutation(
              BlockPermutation.resolve("trains:track", { "minecraft:cardinal_direction": cardinalOf(d) })
            );
            placed++;
          }
        } else if (b.isAir || b.isLiquid) {
          b.setPermutation(BlockPermutation.resolve("trains:platform"));
          placed++;
        }
      } catch {}
    }
  }
  if (placed > 0) {
    player.onScreenDisplay.setActionBar(`§aTrack segment laid (3x3, heading ${cardinalOf(d)})`);
    try {
      dim.playSound("dig.stone", { x: bl.x + 0.5, y: y + 0.5, z: bl.z + 0.5 });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Depot interaction: status / interval cycling
// ---------------------------------------------------------------------------
function depotInteract(player, block) {
  const list = loadReg(K_DEPOTS);
  const key = posKey(block.dimension.id, block.location);
  let ent = list.find((e) => posKey(e.d, e) === key);
  if (!ent) {
    const l = block.location;
    ent = { d: block.dimension.id, x: l.x, y: l.y, z: l.z, i: DEFAULT_INTERVAL };
    list.push(ent);
    saveReg(K_DEPOTS, list);
  }
  if (!depotNext.has(key)) depotNext.set(key, system.currentTick + FIRST_SPAWN_DELAY);

  if (player.isSneaking) {
    const idx = (INTERVALS.indexOf(ent.i ?? DEFAULT_INTERVAL) + 1) % INTERVALS.length;
    ent.i = INTERVALS[idx];
    saveReg(K_DEPOTS, list);
    depotNext.set(key, system.currentTick + ent.i);
    player.sendMessage(`§bDepot: a train will now depart every ${ent.i / 20}s.`);
  } else {
    const next = depotNext.get(key);
    const secs = next !== undefined ? Math.max(0, Math.ceil((next - system.currentTick) / 20)) : "?";
    player.sendMessage(
      `§bDepot — trains every ${(ent.i ?? DEFAULT_INTERVAL) / 20}s, next departure in ${secs}s. §7(Sneak + interact to change the interval.)`
    );
  }
}

// ---------------------------------------------------------------------------
// Train movement
// ---------------------------------------------------------------------------
function endTrain(t, reason) {
  try {
    t.getComponent("minecraft:rideable")?.ejectRiders();
  } catch {}
  if (reason === "terminus") announce(t.dimension, t.location, 20, "§eEnd of the line — all change, please!");
  try {
    t.remove();
  } catch {}
}

function tickTrain(t, tick) {
  const dim = t.dimension;

  const born = t.getDynamicProperty("born");
  if (born === undefined) {
    // Not spawned by a depot (e.g. /summon) — give it a fighting chance by
    // initialising from wherever it stands, heading south.
    const l = t.location;
    t.setDynamicProperty("born", tick);
    t.setDynamicProperty("dx", 0);
    t.setDynamicProperty("dz", 1);
    t.setDynamicProperty("wx", Math.floor(l.x) + 0.5);
    t.setDynamicProperty("wy", Math.floor(l.y) + 0.3);
    t.setDynamicProperty("wz", Math.floor(l.z) + 0.5);
    t.setDynamicProperty("traveled", 0);
    t.setDynamicProperty("lastStop", "");
    return;
  }
  if (tick - born > MAX_AGE_TICKS) {
    endTrain(t, "expired");
    return;
  }

  const dwellUntil = t.getDynamicProperty("dwellUntil") ?? 0;
  if (tick < dwellUntil) {
    t.clearVelocity();
    return;
  }

  const wx = t.getDynamicProperty("wx");
  const wy = t.getDynamicProperty("wy");
  const wz = t.getDynamicProperty("wz");
  const dx = t.getDynamicProperty("dx");
  const dz = t.getDynamicProperty("dz");
  if (wx === undefined || dx === undefined) {
    endTrain(t, "orphan");
    return;
  }

  const loc = t.location;
  if (loc.y < wy - 2) {
    endTrain(t, "derailed");
    return;
  }

  // Cruise toward the current waypoint (centre of the next track cell).
  const rex = wx - loc.x;
  const rez = wz - loc.z;
  const rem = Math.hypot(rex, rez);
  if (rem > SPEED) {
    try {
      t.clearVelocity();
      t.applyImpulse({ x: (rex / rem) * SPEED, y: 0, z: (rez / rem) * SPEED });
    } catch {}
    return;
  }

  // Arrived at the waypoint cell — handle stops, then pick the next cell.
  const cx = Math.floor(wx);
  const cz = Math.floor(wz);
  const trackY = Math.round(wy - 0.3);
  const hereBlock = safeBlock(dim, { x: cx, y: trackY, z: cz });
  if (!hereBlock) {
    t.clearVelocity(); // chunk not loaded — wait
    return;
  }
  const hereType = hereBlock.typeId;
  const traveled = t.getDynamicProperty("traveled") ?? 0;
  const hereKey = `${cx},${cz}`;

  if (hereType === "trains:depot_track" && traveled > MIN_TRIP_CELLS) {
    endTrain(t, "terminus");
    return;
  }
  if (hereType === "trains:station_track" && t.getDynamicProperty("lastStop") !== hereKey) {
    t.setDynamicProperty("lastStop", hereKey);
    t.setDynamicProperty("dwellUntil", tick + DWELL_TICKS);
    t.clearVelocity();
    announce(dim, loc, 20, "§eTrain at the platform — hop on! (interact to board)");
    try {
      dim.playSound("note.pling", loc);
    } catch {}
    return;
  }

  const isTrack = (ox, oz) => {
    const b = safeBlock(dim, { x: cx + ox, y: trackY, z: cz + oz });
    return b !== undefined && TRACK_TYPES.has(b.typeId);
  };

  let d = { x: dx, z: dz };
  let nd = null;
  if (isTrack(d.x, d.z)) {
    nd = d;
  } else {
    const L = leftOf(d);
    const R = rightOf(d);
    const lOk = isTrack(L.x, L.z);
    const rOk = isTrack(R.x, R.z);
    if (rOk && !lOk) nd = R;
    else if (lOk && !rOk) nd = L;
    else if (rOk) nd = R; // T-junction: bear right
  }
  if (!nd) {
    // Dead end — run the service back the other way.
    nd = opposite(d);
    if (!isTrack(nd.x, nd.z)) {
      endTrain(t, "stranded");
      return;
    }
    announce(dim, loc, 16, "§7End of track — train reversing");
  }

  if (hereType !== "trains:station_track") t.setDynamicProperty("lastStop", "");
  t.setDynamicProperty("dx", nd.x);
  t.setDynamicProperty("dz", nd.z);
  t.setDynamicProperty("wx", cx + nd.x + 0.5);
  t.setDynamicProperty("wz", cz + nd.z + 0.5);
  t.setDynamicProperty("wy", wy);
  t.setDynamicProperty("traveled", traveled + 1);
  try {
    t.setRotation({ x: 0, y: yawOf(nd) });
    t.clearVelocity();
    t.applyImpulse({ x: nd.x * SPEED, y: 0, z: nd.z * SPEED });
  } catch {}
}

// ---------------------------------------------------------------------------
// Depots: scheduled departures
// ---------------------------------------------------------------------------
function spawnTrainAt(dim, block) {
  const l = block.location;
  const d = travelDirOf(block);
  const ahead = safeBlock(dim, { x: l.x + d.x, y: l.y, z: l.z + d.z });
  if (!ahead || !TRACK_TYPES.has(ahead.typeId)) return false; // line not connected yet

  try {
    const blocking = dim.getEntities({
      type: "trains:train",
      location: { x: l.x + 0.5, y: l.y + 1, z: l.z + 0.5 },
      maxDistance: 4
    });
    if (blocking.length > 0) return false; // platform occupied
  } catch {
    return false;
  }

  let t;
  try {
    t = dim.spawnEntity("trains:train", { x: l.x + 0.5, y: l.y + 0.35, z: l.z + 0.5 });
  } catch {
    return false;
  }
  t.setDynamicProperty("born", system.currentTick);
  t.setDynamicProperty("dx", d.x);
  t.setDynamicProperty("dz", d.z);
  t.setDynamicProperty("wx", l.x + d.x + 0.5);
  t.setDynamicProperty("wy", l.y + 0.3);
  t.setDynamicProperty("wz", l.z + d.z + 0.5);
  t.setDynamicProperty("traveled", 0);
  t.setDynamicProperty("lastStop", "");
  try {
    t.setRotation({ x: 0, y: yawOf(d) });
  } catch {}
  announce(dim, l, 24, "§bA train is departing the depot");
  try {
    dim.playSound("beacon.activate", { x: l.x + 0.5, y: l.y + 1, z: l.z + 0.5 });
  } catch {}
  return true;
}

function tickDepots(tick) {
  const list = loadReg(K_DEPOTS);
  let dirty = false;
  const keep = [];
  for (const dpt of list) {
    let dim;
    try {
      dim = world.getDimension(dpt.d);
    } catch {
      keep.push(dpt);
      continue;
    }
    const key = posKey(dpt.d, dpt);
    const b = safeBlock(dim, dpt);
    if (!b) {
      keep.push(dpt); // chunk unloaded — keep, but don't run its clock
      continue;
    }
    if (b.typeId !== "trains:depot_track") {
      depotNext.delete(key); // removed by explosion/piston/etc.
      dirty = true;
      continue;
    }
    keep.push(dpt);
    let next = depotNext.get(key);
    if (next === undefined) {
      next = tick + FIRST_SPAWN_DELAY;
      depotNext.set(key, next);
    }
    if (tick >= next) {
      const ok = spawnTrainAt(dim, b);
      depotNext.set(key, tick + (ok ? dpt.i ?? DEFAULT_INTERVAL : FIRST_SPAWN_DELAY));
    }
  }
  if (dirty) saveReg(K_DEPOTS, keep);
}

// ---------------------------------------------------------------------------
// Arrival screens
// ---------------------------------------------------------------------------
let trainsCache = [];

function screenText(dimId, s, tick) {
  const c = { x: s.x + 0.5, y: s.y + 0.5, z: s.z + 0.5 };
  let bestEta = Infinity;
  let boarding = false;
  for (const t of trainsCache) {
    let tl;
    try {
      if (t.dimension.id !== dimId) continue;
      tl = t.location;
    } catch {
      continue;
    }
    const dist = Math.hypot(tl.x - c.x, tl.y - c.y, tl.z - c.z);
    if (dist > SCREEN_TRAIN_RANGE) continue;
    if (dist < 10 && tick < (t.getDynamicProperty("dwellUntil") ?? 0)) boarding = true;
    const eta = dist / (SPEED * 20);
    if (eta < bestEta) bestEta = eta;
  }

  let dep = Infinity;
  for (const [key, next] of depotNext) {
    const bar = key.indexOf("|");
    if (key.slice(0, bar) !== dimId) continue;
    const [x, , z] = key.slice(bar + 1).split(",").map(Number);
    if (Math.hypot(x + 0.5 - c.x, z + 0.5 - c.z) > SCREEN_DEPOT_RANGE) continue;
    const secs = (next - tick) / 20;
    if (secs >= 0 && secs < dep) dep = secs;
  }

  const lines = ["§b§l== RAIL INFO ==§r"];
  if (boarding) lines.push("§a>> NOW BOARDING <<");
  else if (bestEta < Infinity) lines.push(`§eTrain arriving in ~${Math.max(1, Math.ceil(bestEta))}s`);
  else lines.push("§7No trains approaching");
  if (dep < Infinity) lines.push(`§7Next departure: ${Math.ceil(dep)}s`);
  else if (bestEta === Infinity) lines.push("§8(no depot within range)");
  return lines.join("\n");
}

function tickScreens(tick) {
  const list = loadReg(K_SCREENS);
  let dirty = false;
  const keep = [];
  for (const s of list) {
    let dim;
    try {
      dim = world.getDimension(s.d);
    } catch {
      keep.push(s);
      continue;
    }
    const b = safeBlock(dim, s);
    if (!b) {
      keep.push(s); // unloaded
      continue;
    }
    if (b.typeId !== "trains:arrival_screen") {
      const e = textEntityAt(dim, s);
      if (e) {
        try {
          e.remove();
        } catch {}
      }
      dirty = true;
      continue;
    }
    keep.push(s);
    const e = ensureTextEntity(dim, s);
    if (e) {
      try {
        e.nameTag = screenText(s.d, s, tick);
      } catch {}
    }
  }
  if (dirty) saveReg(K_SCREENS, keep);
}

// ---------------------------------------------------------------------------
// Escalators
// ---------------------------------------------------------------------------
function tickEscalators() {
  for (const p of world.getAllPlayers()) {
    const dim = p.dimension;
    const l = p.location;
    const fx = Math.floor(l.x);
    const fz = Math.floor(l.z);
    let b = safeBlock(dim, { x: fx, y: Math.floor(l.y + 0.01), z: fz });
    if (!b || (b.typeId !== "trains:escalator_up" && b.typeId !== "trains:escalator_down")) {
      b = safeBlock(dim, { x: fx, y: Math.floor(l.y - 0.35), z: fz });
    }
    if (!b) continue;
    if (b.typeId === "trains:escalator_up") {
      const d = travelDirOf(b);
      try {
        p.applyKnockback({ x: d.x * 0.18, z: d.z * 0.18 }, 0.24);
      } catch {}
    } else if (b.typeId === "trains:escalator_down") {
      const d = travelDirOf(b);
      try {
        p.applyKnockback({ x: d.x * 0.17, z: d.z * 0.17 }, 0);
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
system.runInterval(() => {
  const tick = system.currentTick;
  try {
    trainsCache = [];
    for (const id of DIM_IDS) {
      try {
        const dim = world.getDimension(id);
        for (const t of dim.getEntities({ type: "trains:train" })) trainsCache.push(t);
      } catch {}
    }
    for (const t of trainsCache) {
      try {
        tickTrain(t, tick);
      } catch {}
    }
    if (tick % 2 === 0) tickEscalators();
    if (tick % 10 === 0) tickDepots(tick);
    if (tick % 10 === 5) tickScreens(tick);
  } catch {}
}, 1);
