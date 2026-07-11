// Railway System — behavior driver (v1.1)
//
// Trains are simulated VIRTUALLY: each depot surveys its track line once
// (recording the path as waypoints), then trains run as pure data on a
// schedule — even while their chunks are unloaded. A rideable train entity
// is only materialized when a player is close enough to see/board it, and
// it chases the simulated position.
//
// Stations and lines can be named with a renamed Name Tag; trains do
// conductor callouts ("Next station: Glenmont") to riders.

import { world, system, BlockPermutation } from "@minecraft/server";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const SPEED = 0.35; // blocks per tick (7 m/s)
const DWELL_TICKS = 120; // 6s stop at stations
const DEFAULT_INTERVAL = 1200; // 60s between trains
const INTERVALS = [600, 1200, 2400, 6000]; // 30s / 60s / 2min / 5min
const FIRST_SPAWN_DELAY = 100;
const RETRY_DELAY = 100;
const MIN_LINE_LEN = 8; // cells of surveyed track before a line runs trains
const MAX_LINE_LEN = 4000;
const MATERIALIZE_R = 64; // player distance that keeps a physical train around
const MAX_TRAIN_AGE = 72000; // 1h safety net

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
const K_STATIONS = "trains:stations";
const K_LINES = "trains:lines";
const K_VTRAINS = "trains:vtrains";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const opposite = (d) => ({ x: -d.x, z: -d.z });
const leftOf = (d) => ({ x: d.z, z: -d.x });
const rightOf = (d) => ({ x: -d.z, z: d.x });

function yawOf(d) {
  if (d.z > 0) return 0;
  if (d.x < 0) return 90;
  if (d.z < 0) return 180;
  return 270;
}

function cardinalOf(d) {
  if (d.z < 0) return "north";
  if (d.z > 0) return "south";
  return d.x > 0 ? "east" : "west";
}

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

function dimOf(id) {
  try {
    return world.getDimension(id);
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
  // strip in-memory-only fields (leading underscore)
  world.setDynamicProperty(key, JSON.stringify(list, (k, v) => (k.startsWith("_") ? undefined : v)));
}

function announce(dim, loc, range, msg) {
  try {
    for (const p of dim.getPlayers({ location: loc, maxDistance: range })) {
      p.onScreenDisplay.setActionBar(msg);
    }
  } catch {}
}

function chatNear(dim, loc, range, msg) {
  try {
    for (const p of dim.getPlayers({ location: loc, maxDistance: range })) {
      p.sendMessage(msg);
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
// Persistent state (loaded once, saved periodically)
// ---------------------------------------------------------------------------
let inited = false;
let stations = []; // [{d,x,y,z,n}]
let lineCache = new Map(); // depotKey -> line record
let vtrains = []; // [{id,k,p,dir,dw,ns,born,_line,_dest}]
let nextVId = 1;
let stationCounter = 1;
let linesDirty = false;
let stationsDirty = false;
const depotNext = new Map(); // depotKey -> tick of next departure (per session)

function init() {
  stations = loadReg(K_STATIONS);
  stationCounter = stations.length + 1;
  for (const line of loadReg(K_LINES)) lineCache.set(line.k, line);
  for (const v of loadReg(K_VTRAINS)) {
    const line = lineCache.get(v.k);
    if (!line || !line.done) continue; // line gone/changed — drop the train
    v._line = line;
    v.born = system.currentTick; // ages restart with the session
    vtrains.push(v);
    if (v.id >= nextVId) nextVId = v.id + 1;
  }
}

function persist(tick) {
  if (linesDirty) {
    saveReg(K_LINES, [...lineCache.values()]);
    linesDirty = false;
  }
  if (stationsDirty) {
    saveReg(K_STATIONS, stations);
    stationsDirty = false;
  }
  if (tick % 60 === 0) {
    saveReg(
      K_VTRAINS,
      vtrains.map((v) => ({ id: v.id, k: v.k, p: v.p, dir: v.dir, dw: v.dw, ns: v.ns }))
    );
  }
}

// ---------------------------------------------------------------------------
// Station & line names
// ---------------------------------------------------------------------------
function stationAt(dimId, x, y, z) {
  return stations.find((s) => s.d === dimId && s.x === x && s.y === y && s.z === z);
}

function registerStation(block) {
  const l = block.location;
  if (stationAt(block.dimension.id, l.x, l.y, l.z)) return;
  stations.push({ d: block.dimension.id, x: l.x, y: l.y, z: l.z, n: `Station ${stationCounter++}` });
  stationsDirty = true;
}

function unregisterStation(dimId, l) {
  const before = stations.length;
  stations = stations.filter((s) => !(s.d === dimId && s.x === l.x && s.y === l.y && s.z === l.z));
  if (stations.length !== before) stationsDirty = true;
}

function stationName(dimId, x, y, z) {
  return stationAt(dimId, x, y, z)?.n ?? `the station at ${x}, ${z}`;
}

function depotRec(key) {
  return loadReg(K_DEPOTS).find((e) => posKey(e.d, e) === key);
}

function lineNameOf(key) {
  return depotRec(key)?.n;
}

// ---------------------------------------------------------------------------
// Line survey: walk the track from a depot and record the path.
// Runs incrementally — pauses at unloaded chunks and resumes later, so a
// long line only ever needs to be loaded ONCE (while you build/ride it).
// ---------------------------------------------------------------------------
function newLineFor(dep) {
  return {
    k: posKey(dep.d, dep),
    d: dep.d,
    y: dep.y,
    sx: dep.x,
    sz: dep.z,
    cx: dep.x,
    cz: dep.z,
    cdx: dep.fx ?? 0,
    cdz: dep.fz ?? 1,
    wp: [[dep.x, dep.z]],
    st: [], // [[distance, x, z], ...]
    len: 0,
    done: 0,
    loop: 0,
    endDepot: 0
  };
}

function finishLine(line) {
  line.done = 1;
  const last = line.wp[line.wp.length - 1];
  if (last[0] !== line.cx || last[1] !== line.cz) line.wp.push([line.cx, line.cz]);
  delete line._geom;
  linesDirty = true;
}

function surveyStep(line, budget) {
  const dim = dimOf(line.d);
  if (!dim) return;
  while (budget-- > 0 && !line.done) {
    const d = { x: line.cdx, z: line.cdz };
    const cellT = (ox, oz) => {
      const b = safeBlock(dim, { x: line.cx + ox, y: line.y, z: line.cz + oz });
      return b === undefined ? null : b.typeId;
    };
    const sT = cellT(d.x, d.z);
    if (sT === null) return; // unloaded — resume later
    let nd = null;
    if (TRACK_TYPES.has(sT)) {
      nd = d;
    } else {
      const L = leftOf(d);
      const R = rightOf(d);
      const lT = cellT(L.x, L.z);
      const rT = cellT(R.x, R.z);
      if (lT === null || rT === null) return; // unloaded — resume later
      const lOk = TRACK_TYPES.has(lT);
      const rOk = TRACK_TYPES.has(rT);
      nd = rOk && !lOk ? R : lOk && !rOk ? L : rOk ? R : null;
    }
    if (!nd) {
      finishLine(line); // dead end terminus
      return;
    }
    if (nd.x !== d.x || nd.z !== d.z) line.wp.push([line.cx, line.cz]);
    line.cx += nd.x;
    line.cz += nd.z;
    line.cdx = nd.x;
    line.cdz = nd.z;
    line.len++;
    linesDirty = true;
    if (line.cx === line.sx && line.cz === line.sz) {
      line.loop = 1;
      finishLine(line);
      return;
    }
    const t = cellT(0, 0);
    if (t === "trains:station_track") line.st.push([line.len, line.cx, line.cz]);
    else if (t === "trains:depot_track") {
      line.endDepot = 1;
      finishLine(line);
      return;
    }
    if (line.len > MAX_LINE_LEN) {
      finishLine(line);
      return;
    }
  }
}

function resetLine(dep) {
  const line = newLineFor(dep);
  lineCache.set(line.k, line);
  linesDirty = true;
  return line;
}

// Any track edit may have rerouted lines: re-survey everything in that dimension.
// Running trains keep their old path object until they finish their trip.
function invalidateLines(dimId) {
  const depots = loadReg(K_DEPOTS);
  for (const dep of depots) {
    if (dep.d !== dimId) continue;
    resetLine(dep);
  }
}

function geomOf(line) {
  if (line._geom) return line._geom;
  const segs = [];
  let total = 0;
  for (let i = 0; i + 1 < line.wp.length; i++) {
    const [ax, az] = line.wp[i];
    const [bx, bz] = line.wp[i + 1];
    const l = Math.abs(bx - ax) + Math.abs(bz - az);
    segs.push({ ax, az, dx: Math.sign(bx - ax), dz: Math.sign(bz - az), l, start: total });
    total += l;
  }
  line._geom = { segs, total };
  return line._geom;
}

function posAt(line, p) {
  const g = geomOf(line);
  p = Math.max(0, Math.min(p, g.total));
  for (let i = 0; i < g.segs.length; i++) {
    const s = g.segs[i];
    if (p <= s.start + s.l || i === g.segs.length - 1) {
      const t = p - s.start;
      return { x: s.ax + 0.5 + s.dx * t, z: s.az + 0.5 + s.dz * t, dx: s.dx, dz: s.dz };
    }
  }
  return { x: line.sx + 0.5, z: line.sz + 0.5, dx: line.cdx || 1, dz: line.cdz };
}

// Last station name in the direction of travel — the "toward X" destination.
function destOf(line, dir) {
  if (line.st.length === 0) return undefined;
  const s = dir > 0 ? line.st[line.st.length - 1] : line.st[0];
  return stationName(line.d, s[1], line.y, s[2]);
}

// ---------------------------------------------------------------------------
// Virtual trains
// ---------------------------------------------------------------------------
function ridersOf(e) {
  try {
    return (e.getComponent("minecraft:rideable")?.getRiders() ?? []).filter(
      (r) => r.typeId === "minecraft:player"
    );
  } catch {
    return [];
  }
}

function calloutRiders(v, msg) {
  const e = v._entity;
  if (!e) return;
  for (const p of ridersOf(e)) {
    try {
      p.sendMessage(msg);
      p.onScreenDisplay.setActionBar(msg);
    } catch {}
  }
}

function simPosOf(v) {
  const g = posAt(v._line, v.p);
  return { x: g.x, y: v._line.y + 0.3, z: g.z, dx: g.dx * v.dir, dz: g.dz * v.dir };
}

function removeVTrain(v) {
  const e = v._entity;
  if (e) {
    try {
      e.getComponent("minecraft:rideable")?.ejectRiders();
    } catch {}
    try {
      e.remove();
    } catch {}
  }
  vtrains = vtrains.filter((o) => o !== v);
}

function spawnVTrain(dep, line, tick) {
  const v = {
    id: nextVId++,
    k: line.k,
    p: 0,
    dir: 1,
    dw: 0,
    ns: 0,
    born: tick,
    _line: line
  };
  vtrains.push(v);
  const dim = dimOf(line.d);
  if (dim) {
    const dest = destOf(line, 1);
    const lname = dep.n ? `§e${dep.n}§b ` : "";
    const toward = dest ? ` toward §e${dest}` : "";
    const loc = { x: line.sx + 0.5, y: line.y + 1, z: line.sz + 0.5 };
    announce(dim, loc, 24, `§bThe ${lname}train${toward} is now departing`);
    try {
      dim.playSound("beacon.activate", loc);
    } catch {}
  }
  return v;
}

function announceDeparture(v) {
  const line = v._line;
  if (v.ns >= 0 && v.ns < line.st.length) {
    const s = line.st[v.ns];
    calloutRiders(v, `§6🚉 Next station: §e${stationName(line.d, s[1], line.y, s[2])}`);
  } else {
    const dest = v.dir > 0 && (line.endDepot || line.loop) ? undefined : destOf(line, v.dir);
    calloutRiders(
      v,
      dest ? `§6🚉 This train terminates after §e${dest}` : "§6🚉 Approaching the end of the line"
    );
  }
  const dim = dimOf(line.d);
  if (dim) {
    const sp = simPosOf(v);
    announce(dim, sp, 14, "§7Doors closing — train departing");
  }
}

function tickVTrain(v, tick) {
  const line = v._line;
  if (!line || !line.done) {
    removeVTrain(v);
    return;
  }
  if (tick - v.born > MAX_TRAIN_AGE) {
    removeVTrain(v);
    return;
  }

  if (v.dw > 0) {
    v.dw--;
    if (v.dw === 0) {
      v.ns += v.dir;
      announceDeparture(v);
    }
    syncEntity(v);
    return;
  }

  v.p += SPEED * v.dir;

  // station arrival
  if (v.ns >= 0 && v.ns < line.st.length) {
    const s = line.st[v.ns];
    const reached = v.dir > 0 ? v.p >= s[0] : v.p <= s[0];
    if (reached) {
      v.p = s[0];
      v.dw = DWELL_TICKS;
      const name = stationName(line.d, s[1], line.y, s[2]);
      calloutRiders(v, `§6🚉 This station is: §e${name}`);
      const dim = dimOf(line.d);
      if (dim) {
        const sp = simPosOf(v);
        announce(dim, sp, 20, `§eTrain now boarding at §f${name}`);
        try {
          dim.playSound("note.pling", sp);
        } catch {}
      }
      syncEntity(v);
      return;
    }
  }

  const total = geomOf(line).total;
  if (v.dir > 0 && v.p >= total) {
    if (line.endDepot || line.loop) {
      calloutRiders(v, "§6🚉 This is the last stop — thanks for riding!");
      const dim = dimOf(line.d);
      if (dim) announce(dim, simPosOf(v), 20, "§eTrain arrived — end of the line");
      removeVTrain(v);
      return;
    }
    // plain dead end: run the service back
    v.p = total;
    v.dir = -1;
    v.ns = line.st.length - 1;
    // don't double-stop at a station sitting right at the buffer
    if (v.ns >= 0 && Math.abs(line.st[v.ns][0] - v.p) < 0.5) v.ns--;
    calloutRiders(v, "§6🚉 End of track — this train now returns the other way");
  } else if (v.dir < 0 && v.p <= 0) {
    calloutRiders(v, "§6🚉 This is the last stop — thanks for riding!");
    removeVTrain(v); // back at its origin depot
    return;
  }

  syncEntity(v);
}

// ---------------------------------------------------------------------------
// Entity materialization: physical trains exist only near players
// ---------------------------------------------------------------------------
function syncEntity(v) {
  const line = v._line;
  const dim = dimOf(line.d);
  if (!dim) return;
  const sp = simPosOf(v);
  let e = v._entity;
  if (e) {
    try {
      if (!e.isValid) e = undefined;
    } catch {
      e = undefined;
    }
  }

  let nearPlayers;
  try {
    nearPlayers = dim.getPlayers({ location: sp, maxDistance: MATERIALIZE_R });
  } catch {
    nearPlayers = [];
  }

  if (!e) {
    v._entity = undefined;
    if (nearPlayers.length === 0) return;
    if (!safeBlock(dim, sp)) return; // chunk not loaded yet
    try {
      e = dim.spawnEntity("trains:train", { x: sp.x, y: sp.y, z: sp.z });
    } catch {
      return;
    }
    e.setDynamicProperty("vid", v.id);
    const dest = v.dir > 0 && (line.endDepot || line.loop) ? destOf(line, 1) : destOf(line, v.dir);
    const lname = lineNameOf(v.k);
    e.nameTag = dest ? `${lname ? lname + " — " : ""}to ${dest}` : lname ?? "Train";
    v._entity = e;
  }

  if (nearPlayers.length === 0 && ridersOf(e).length === 0) {
    try {
      e.remove();
    } catch {}
    v._entity = undefined;
    return; // simulation carries on without the entity
  }

  try {
    const el = e.location;
    const heading = { x: sp.dx, z: sp.dz };
    const dx = sp.x - el.x;
    const dz = sp.z - el.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 4 || Math.abs(sp.y - el.y) > 3) {
      e.teleport({ x: sp.x, y: sp.y, z: sp.z }, { rotation: { x: 0, y: yawOf(heading) } });
    } else {
      const cap = dist > 0.6 ? 0.6 / dist : 1;
      e.clearVelocity();
      e.applyImpulse({ x: dx * cap, y: 0, z: dz * cap });
    }
    if (heading.x !== 0 || heading.z !== 0) e.setRotation({ x: 0, y: yawOf(heading) });
  } catch {}
}

// Adopt persisted/loaded entities back onto their virtual trains, and clean
// up any train entity that no longer has a simulation behind it.
function reconcileEntities() {
  const byId = new Map(vtrains.map((v) => [v.id, v]));
  for (const id of DIM_IDS) {
    const dim = dimOf(id);
    if (!dim) continue;
    let list;
    try {
      list = dim.getEntities({ type: "trains:train" });
    } catch {
      continue;
    }
    for (const e of list) {
      let vid;
      try {
        vid = e.getDynamicProperty("vid");
      } catch {
        continue;
      }
      const v = vid !== undefined ? byId.get(vid) : undefined;
      let orphan = !v;
      if (v) {
        let cur = v._entity;
        try {
          if (cur && !cur.isValid) cur = undefined;
        } catch {
          cur = undefined;
        }
        if (!cur) v._entity = e;
        else if (cur.id !== e.id) orphan = true; // duplicate from a re-materialize
      }
      if (orphan) {
        // old version, /summon, finished trip while unloaded, or a duplicate
        try {
          e.getComponent("minecraft:rideable")?.ejectRiders();
        } catch {}
        try {
          e.remove();
        } catch {}
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Depots: registration, schedule, interaction
// ---------------------------------------------------------------------------
function registerDepot(block) {
  const list = loadReg(K_DEPOTS);
  const key = posKey(block.dimension.id, block.location);
  let dep = list.find((e) => posKey(e.d, e) === key);
  if (!dep) {
    const l = block.location;
    const f = travelDirOf(block);
    dep = { d: block.dimension.id, x: l.x, y: l.y, z: l.z, i: DEFAULT_INTERVAL, fx: f.x, fz: f.z };
    list.push(dep);
    saveReg(K_DEPOTS, list);
  }
  if (!lineCache.has(key)) resetLine(dep);
  if (!depotNext.has(key)) depotNext.set(key, system.currentTick + FIRST_SPAWN_DELAY);
  return dep;
}

function unregisterDepot(dimId, l) {
  const key = posKey(dimId, l);
  saveReg(
    K_DEPOTS,
    loadReg(K_DEPOTS).filter((e) => posKey(e.d, e) !== key)
  );
  depotNext.delete(key);
  lineCache.delete(key);
  linesDirty = true;
  for (const v of [...vtrains]) if (v.k === key) removeVTrain(v);
}

function tickDepots(tick) {
  const list = loadReg(K_DEPOTS);
  let dirty = false;
  const keep = [];
  for (const dep of list) {
    const key = posKey(dep.d, dep);
    const dim = dimOf(dep.d);
    const b = dim ? safeBlock(dim, dep) : undefined;
    if (b && b.typeId !== "trains:depot_track") {
      // depot destroyed by explosion/piston while we weren't looking
      depotNext.delete(key);
      lineCache.delete(key);
      linesDirty = true;
      dirty = true;
      continue;
    }
    keep.push(dep);
    if (b && dep.fx === undefined) {
      const f = travelDirOf(b);
      dep.fx = f.x;
      dep.fz = f.z;
      dirty = true;
    }
    let line = lineCache.get(key);
    if (!line) line = resetLine(dep);

    let next = depotNext.get(key);
    if (next === undefined) {
      next = tick + FIRST_SPAWN_DELAY;
      depotNext.set(key, next);
    }
    if (tick < next) continue;
    if (!line.done || line.len < MIN_LINE_LEN) {
      depotNext.set(key, tick + RETRY_DELAY);
      continue;
    }
    const blocked = vtrains.some((v) => v.k === key && v.p < 6);
    if (blocked) {
      depotNext.set(key, tick + RETRY_DELAY);
      continue;
    }
    spawnVTrain(dep, line, tick);
    depotNext.set(key, tick + (dep.i ?? DEFAULT_INTERVAL));
  }
  if (dirty) saveReg(K_DEPOTS, keep);
}

function depotInteract(player, block) {
  const dep = registerDepot(block);
  const key = posKey(block.dimension.id, block.location);
  const list = loadReg(K_DEPOTS);
  const ent = list.find((e) => posKey(e.d, e) === key) ?? dep;

  if (player.isSneaking) {
    const idx = (INTERVALS.indexOf(ent.i ?? DEFAULT_INTERVAL) + 1) % INTERVALS.length;
    ent.i = INTERVALS[idx];
    saveReg(K_DEPOTS, list);
    depotNext.set(key, system.currentTick + ent.i);
    player.sendMessage(`§bDepot: a train will now depart every ${ent.i / 20}s.`);
    return;
  }

  let line = lineCache.get(key);
  // A finished-but-useless survey usually means the line was built after the
  // depot — rescan on demand.
  if (line && line.done && line.len < MIN_LINE_LEN) {
    line = resetLine(ent);
    player.sendMessage("§7Re-scanning the line from this depot...");
  }
  const lname = ent.n ? `'${ent.n}' line` : "Unnamed line";
  const next = depotNext.get(key);
  const secs = next !== undefined ? Math.max(0, Math.ceil((next - system.currentTick) / 20)) : "?";
  const active = vtrains.filter((v) => v.k === key).length;
  if (!line || !line.done) {
    player.sendMessage(
      `§b${lname} — §esurveying the route (${line?.len ?? 0} blocks so far). §7Walk or fly along the track once so it can finish.`
    );
  } else {
    player.sendMessage(
      `§b${lname} — ${line.len} blocks, ${line.st.length} station(s)${line.loop ? ", loop" : line.endDepot ? ", ends at a depot" : ", out-and-back"}. Trains every ${(ent.i ?? DEFAULT_INTERVAL) / 20}s, next in ${secs}s, ${active} running now.`
    );
  }
  player.sendMessage(
    "§7Sneak+interact: change interval. Name this line with a renamed Name Tag."
  );
}

// ---------------------------------------------------------------------------
// Naming (renamed Name Tag on a station or depot, or /scriptevent)
// ---------------------------------------------------------------------------
function applyName(player, block, name) {
  const dimId = block.dimension.id;
  const l = block.location;
  if (block.typeId === "trains:station_track") {
    registerStation(block);
    const s = stationAt(dimId, l.x, l.y, l.z);
    s.n = name;
    stationsDirty = true;
    player.sendMessage(`§aStation named §e${name}`);
    return true;
  }
  if (block.typeId === "trains:depot_track") {
    registerDepot(block);
    const list = loadReg(K_DEPOTS);
    const ent = list.find((e) => posKey(e.d, e) === posKey(dimId, l));
    if (ent) {
      ent.n = name;
      saveReg(K_DEPOTS, list);
      player.sendMessage(`§aLine named §e${name}`);
    }
    return true;
  }
  return false;
}

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  const p = ev.sourceEntity;
  if (ev.id === "trains:name") {
    if (!p || p.typeId !== "minecraft:player") return;
    const name = (ev.message ?? "").trim();
    if (!name) {
      p.sendMessage("§7Usage: /scriptevent trains:name Glenmont (near a station or depot)");
      return;
    }
    // nearest registered station or depot within 8 blocks
    const pl = p.location;
    let best, bestD = 8;
    for (const s of stations) {
      if (s.d !== p.dimension.id) continue;
      const d = Math.hypot(s.x + 0.5 - pl.x, s.z + 0.5 - pl.z);
      if (d < bestD) { bestD = d; best = { kind: "station", rec: s }; }
    }
    for (const dep of loadReg(K_DEPOTS)) {
      if (dep.d !== p.dimension.id) continue;
      const d = Math.hypot(dep.x + 0.5 - pl.x, dep.z + 0.5 - pl.z);
      if (d < bestD) { bestD = d; best = { kind: "depot", rec: dep }; }
    }
    if (!best) {
      p.sendMessage("§7No station or depot within 8 blocks.");
    } else if (best.kind === "station") {
      best.rec.n = name;
      stationsDirty = true;
      p.sendMessage(`§aStation named §e${name}`);
    } else {
      const list = loadReg(K_DEPOTS);
      const ent = list.find((e) => posKey(e.d, e) === posKey(best.rec.d, best.rec));
      if (ent) {
        ent.n = name;
        saveReg(K_DEPOTS, list);
        p.sendMessage(`§aLine named §e${name}`);
      }
    }
  } else if (ev.id === "trains:clear") {
    for (const v of [...vtrains]) removeVTrain(v);
    if (p?.typeId === "minecraft:player") p.sendMessage("§7All trains removed.");
  } else if (ev.id === "trains:resurvey") {
    if (!p || p.typeId !== "minecraft:player") return;
    invalidateLines(p.dimension.id);
    p.sendMessage("§7All lines in this dimension are being re-surveyed.");
  }
});

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
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
  const dim = dimOf(dimId);
  if (dim) {
    const e = textEntityAt(dim, l);
    if (e) {
      try {
        e.remove();
      } catch {}
    }
  }
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

function screenText(s, tick) {
  const c = { x: s.x + 0.5, y: s.y + 0.5, z: s.z + 0.5 };

  // header: nearest named station
  let header = "== RAIL INFO ==";
  let hBest = 24;
  for (const st of stations) {
    if (st.d !== s.d || Math.abs(st.y - s.y) > 8) continue;
    const d = Math.hypot(st.x + 0.5 - c.x, st.z + 0.5 - c.z);
    if (d < hBest) {
      hBest = d;
      header = st.n.toUpperCase();
    }
  }

  let bestEta = Infinity;
  let boarding = false;
  for (const v of vtrains) {
    if (v._line.d !== s.d) continue;
    const sp = simPosOf(v);
    const dist = Math.hypot(sp.x - c.x, sp.y - c.y, sp.z - c.z);
    if (dist > 128) continue;
    if (dist < 10 && v.dw > 0) boarding = true;
    const eta = dist / (SPEED * 20);
    if (eta < bestEta) bestEta = eta;
  }

  let dep = Infinity;
  for (const [key, next] of depotNext) {
    const bar = key.indexOf("|");
    if (key.slice(0, bar) !== s.d) continue;
    const [x, , z] = key.slice(bar + 1).split(",").map(Number);
    if (Math.hypot(x + 0.5 - c.x, z + 0.5 - c.z) > 96) continue;
    const secs = (next - tick) / 20;
    if (secs >= 0 && secs < dep) dep = secs;
  }

  const lines = [`§b§l${header}§r`];
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
    const dim = dimOf(s.d);
    if (!dim) {
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
        e.nameTag = screenText(s, tick);
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
// Track planner: lays a 3x3 segment (centre rail + platform shoulders)
// ---------------------------------------------------------------------------
const wandCooldown = new Map();

function tryPlaceSegment(player, base) {
  const tick = system.currentTick;
  if ((wandCooldown.get(player.id) ?? -10) > tick - 4) return;
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
    invalidateLines(dim.id);
    player.onScreenDisplay.setActionBar(`§aTrack segment laid (3x3, heading ${cardinalOf(d)})`);
    try {
      dim.playSound("dig.stone", { x: bl.x + 0.5, y: y + 0.5, z: bl.z + 0.5 });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// World events
// ---------------------------------------------------------------------------
world.afterEvents.playerPlaceBlock.subscribe((ev) => {
  const t = ev.block.typeId;
  if (t === "trains:depot_track") registerDepot(ev.block);
  else if (t === "trains:arrival_screen") registerScreen(ev.block);
  else if (t === "trains:station_track") registerStation(ev.block);
  if (TRACK_TYPES.has(t)) invalidateLines(ev.block.dimension.id);
});

world.afterEvents.playerBreakBlock.subscribe((ev) => {
  const t = ev.brokenBlockPermutation.type.id;
  if (t === "trains:depot_track") unregisterDepot(ev.dimension.id, ev.block.location);
  else if (t === "trains:arrival_screen") unregisterScreen(ev.dimension.id, ev.block.location);
  else if (t === "trains:station_track") unregisterStation(ev.dimension.id, ev.block.location);
  if (TRACK_TYPES.has(t)) invalidateLines(ev.dimension.id);
});

world.afterEvents.playerInteractWithBlock.subscribe((ev) => {
  if (ev.isFirstEvent === false) return;
  const { block, player } = ev;
  if (!player) return;
  const item = ev.itemStack;

  if (item?.typeId === "minecraft:name_tag") {
    const name = item.nameTag?.trim();
    if (block.typeId === "trains:station_track" || block.typeId === "trains:depot_track") {
      if (name) applyName(player, block, name);
      else player.sendMessage("§7Rename the Name Tag on an anvil first, then tap the block with it.");
      return;
    }
  }
  if (item?.typeId === "trains:track_planner") {
    tryPlaceSegment(player, block);
    return;
  }
  if (block.typeId === "trains:depot_track") {
    depotInteract(player, block);
  } else if (block.typeId === "trains:arrival_screen") {
    registerScreen(block);
    player.onScreenDisplay.setActionBar("§bArrival screen linked.");
  } else if (block.typeId === "trains:station_track") {
    registerStation(block);
    const l = block.location;
    const s = stationAt(block.dimension.id, l.x, l.y, l.z);
    player.sendMessage(`§bStation: §e${s.n} §7— rename it with a renamed Name Tag.`);
  }
});

world.afterEvents.itemUse.subscribe((ev) => {
  if (ev.itemStack?.typeId !== "trains:track_planner") return;
  const p = ev.source;
  if (!p || p.typeId !== "minecraft:player") return;
  const hit = p.getBlockFromViewDirection({ maxDistance: 12 });
  if (hit?.block) tryPlaceSegment(p, hit.block);
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
system.runInterval(() => {
  try {
    if (!inited) {
      init();
      reconcileEntities(); // re-adopt persisted train entities before any sync
      inited = true;
    }
    const tick = system.currentTick;
    if (tick % 40 === 0) reconcileEntities();
    for (const v of [...vtrains]) {
      try {
        tickVTrain(v, tick);
      } catch {}
    }
    if (tick % 2 === 0) tickEscalators();
    if (tick % 10 === 0) tickDepots(tick);
    if (tick % 10 === 5) tickScreens(tick);
    if (tick % 20 === 0) {
      for (const line of lineCache.values()) {
        if (!line.done) surveyStep(line, 150);
      }
    }
    persist(tick);
  } catch {}
}, 1);
