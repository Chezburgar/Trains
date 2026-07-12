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

import { world, system, BlockPermutation, GameMode, EquipmentSlot } from "@minecraft/server";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const SPEED = 0.6; // blocks per tick (12 m/s)
const DWELL_TICKS = 120; // 6s stop at stations
const DEFAULT_INTERVAL = 1200; // 60s between trains
const INTERVALS = [600, 1200, 2400, 6000]; // 30s / 60s / 2min / 5min
const FIRST_SPAWN_DELAY = 100;
const RETRY_DELAY = 100;
const MIN_LINE_LEN = 3; // cells of surveyed track before a line runs trains
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
const K_LINES = "trains:lines2"; // v2: waypoints carry a Y coordinate (slopes)
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

// The cardinal_direction state stores the direction the player was facing
// when the block was placed, so that IS the travel/departure direction.
function travelDirOf(block) {
  const st = block.permutation.getState("minecraft:cardinal_direction") ?? "north";
  return DIRS[st] ?? DIRS.north;
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
    if (v.dir === -1) continue; // pre-1.2 returning train — retire it
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
      vtrains.map((v) => ({ id: v.id, k: v.k, p: v.p, dw: v.dw, ns: v.ns, fin: v.fin ?? 0 }))
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
// Find the direction actual track leaves the depot — never trust facing alone.
// Preference order: block facing, its opposite, left, right; each checked at
// the same level and one block up/down.
function pickDepotDir(dim, dep) {
  const pref = { x: dep.fx ?? 0, z: dep.fz ?? 1 };
  for (const d of [pref, opposite(pref), leftOf(pref), rightOf(pref)]) {
    for (const dy of [0, 1, -1]) {
      const b = safeBlock(dim, { x: dep.x + d.x, y: dep.y + dy, z: dep.z + d.z });
      if (b && TRACK_TYPES.has(b.typeId)) return d;
    }
  }
  return pref;
}

function newLineFor(dep, dir) {
  return {
    k: posKey(dep.d, dep),
    d: dep.d,
    sx: dep.x,
    sy: dep.y,
    sz: dep.z,
    cx: dep.x,
    cy: dep.y,
    cz: dep.z,
    cdx: dir ? dir.x : dep.fx ?? 0,
    cdy: 0,
    cdz: dir ? dir.z : dep.fz ?? 1,
    wp: [[dep.x, dep.y, dep.z]],
    st: [], // [[distance, x, y, z], ...]
    len: 0,
    done: 0,
    loop: 0,
    endDepot: 0
  };
}

function finishLine(line) {
  line.done = 1;
  const last = line.wp[line.wp.length - 1];
  if (last[0] !== line.cx || last[1] !== line.cy || last[2] !== line.cz) {
    line.wp.push([line.cx, line.cy, line.cz]);
  }
  delete line._geom;
  linesDirty = true;
}

function surveyStep(line, budget) {
  const dim = dimOf(line.d);
  if (!dim) return;
  while (budget-- > 0 && !line.done) {
    const d = { x: line.cdx, z: line.cdz };
    const cellT = (ox, oy, oz) => {
      const b = safeBlock(dim, { x: line.cx + ox, y: line.cy + oy, z: line.cz + oz });
      return b === undefined ? null : b.typeId;
    };
    // probe a direction at the same level, one up, one down
    const probe = (dd) => {
      for (const dy of [0, 1, -1]) {
        const t = cellT(dd.x, dy, dd.z);
        if (t === null) return "unloaded";
        if (TRACK_TYPES.has(t)) return dy;
      }
      return undefined;
    };
    const s = probe(d);
    if (s === "unloaded") return; // resume later
    let nd = null;
    let ny = 0;
    if (s !== undefined) {
      nd = d;
      ny = s;
    } else {
      const L = leftOf(d);
      const R = rightOf(d);
      const ls = probe(L);
      const rs = probe(R);
      if (ls === "unloaded" || rs === "unloaded") return; // resume later
      if (rs !== undefined && ls === undefined) {
        nd = R;
        ny = rs;
      } else if (ls !== undefined && rs === undefined) {
        nd = L;
        ny = ls;
      } else if (rs !== undefined) {
        nd = R;
        ny = rs;
      }
    }
    if (!nd) {
      finishLine(line); // dead end terminus
      return;
    }
    if (nd.x !== line.cdx || nd.z !== line.cdz || ny !== line.cdy) {
      line.wp.push([line.cx, line.cy, line.cz]);
    }
    line.cx += nd.x;
    line.cy += ny;
    line.cz += nd.z;
    line.cdx = nd.x;
    line.cdy = ny;
    line.cdz = nd.z;
    line.len++;
    linesDirty = true;
    if (line.cx === line.sx && line.cy === line.sy && line.cz === line.sz) {
      line.loop = 1;
      finishLine(line);
      return;
    }
    const t = cellT(0, 0, 0);
    if (t === "trains:station_track") line.st.push([line.len, line.cx, line.cy, line.cz]);
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
  let dir;
  const dim = dimOf(dep.d);
  if (dim && safeBlock(dim, dep)) dir = pickDepotDir(dim, dep);
  const line = newLineFor(dep, dir);
  line._resetAt = system.currentTick;
  lineCache.set(line.k, line);
  linesDirty = true;
  return line;
}

// True if (x,y,z) lies on or right next to the line's surveyed path.
function lineTouches(line, x, y, z) {
  const near = (ax, ay, az, bx, by, bz) => {
    const minx = Math.min(ax, bx) - 2, maxx = Math.max(ax, bx) + 2;
    const minz = Math.min(az, bz) - 2, maxz = Math.max(az, bz) + 2;
    const miny = Math.min(ay, by) - 2, maxy = Math.max(ay, by) + 2;
    return x >= minx && x <= maxx && z >= minz && z <= maxz && y >= miny && y <= maxy;
  };
  for (let i = 0; i + 1 < line.wp.length; i++) {
    const [ax, ay, az] = line.wp[i];
    const [bx, by, bz] = line.wp[i + 1];
    if (near(ax, ay, az, bx, by, bz)) return true;
  }
  const last = line.wp[line.wp.length - 1];
  if (near(last[0], last[1], last[2], line.cx, line.cy, line.cz)) return true;
  return near(line.sx, line.sy, line.sz, line.sx, line.sy, line.sz);
}

// A track edit only re-surveys lines whose path runs near the edited block,
// so unrelated lines keep running undisturbed. Running trains keep their old
// path object until they finish their trip.
function invalidateLines(dimId, loc) {
  const depots = loadReg(K_DEPOTS);
  for (const dep of depots) {
    if (dep.d !== dimId) continue;
    const line = lineCache.get(posKey(dep.d, dep));
    if (line && loc && line.len > 0 && !lineTouches(line, loc.x, loc.y, loc.z)) continue;
    resetLine(dep);
  }
}

function geomOf(line) {
  if (line._geom) return line._geom;
  const segs = [];
  let total = 0;
  for (let i = 0; i + 1 < line.wp.length; i++) {
    const [ax, ay, az] = line.wp[i];
    const [bx, by, bz] = line.wp[i + 1];
    const l = Math.max(1, Math.abs(bx - ax) + Math.abs(bz - az));
    segs.push({
      ax,
      ay,
      az,
      dx: Math.sign(bx - ax),
      dy: (by - ay) / l,
      dz: Math.sign(bz - az),
      l,
      start: total
    });
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
      return {
        x: s.ax + 0.5 + s.dx * t,
        y: s.ay + s.dy * t,
        z: s.az + 0.5 + s.dz * t,
        dx: s.dx,
        dz: s.dz
      };
    }
  }
  return { x: line.sx + 0.5, y: line.sy, z: line.sz + 0.5, dx: line.cdx || 1, dz: line.cdz };
}

// The last station on the line — every train's final stop / destination.
function destOf(line) {
  if (line.st.length === 0) return undefined;
  const s = line.st[line.st.length - 1];
  return stationName(line.d, s[1], s[2], s[3]);
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
  return { x: g.x, y: g.y + 0.3, z: g.z, dx: g.dx, dz: g.dz };
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
    dw: 0,
    ns: 0,
    fin: 0,
    born: tick,
    _line: line
  };
  vtrains.push(v);
  const dim = dimOf(line.d);
  if (dim) {
    const dest = destOf(line);
    const lname = dep.n ? `§e${dep.n}§b ` : "";
    const toward = dest ? ` toward §e${dest}` : "";
    const loc = { x: line.sx + 0.5, y: line.sy + 1, z: line.sz + 0.5 };
    announce(dim, loc, 24, `§bThe ${lname}train${toward} is now departing`);
    try {
      dim.playSound("beacon.activate", loc);
    } catch {}
  }
  return v;
}

function announceDeparture(v) {
  const line = v._line;
  if (v.ns < line.st.length) {
    const s = line.st[v.ns];
    const name = stationName(line.d, s[1], s[2], s[3]);
    const final = v.ns === line.st.length - 1;
    calloutRiders(v, final ? `§6🚉 Next and final station: §e${name}` : `§6🚉 Next station: §e${name}`);
  } else {
    calloutRiders(v, "§6🚉 Approaching the end of the line");
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
      if (v.fin) {
        // dwell at the final station is over — train goes out of service
        calloutRiders(v, "§6🚉 This train is now out of service. Thanks for riding!");
        const dim = dimOf(line.d);
        if (dim) announce(dim, simPosOf(v), 16, "§7Train out of service");
        removeVTrain(v);
        return;
      }
      v.ns += 1;
      announceDeparture(v);
    }
    syncEntity(v);
    return;
  }

  v.p += SPEED;

  // station arrival
  if (v.ns < line.st.length) {
    const s = line.st[v.ns];
    if (v.p >= s[0]) {
      v.p = s[0];
      v.dw = DWELL_TICKS;
      const name = stationName(line.d, s[1], s[2], s[3]);
      const final = v.ns === line.st.length - 1;
      if (final) v.fin = 1; // delete after this stop instead of continuing
      calloutRiders(
        v,
        final
          ? `§6🚉 This is §e${name}§6 — the final stop. All change, please!`
          : `§6🚉 This station is: §e${name}`
      );
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

  // ran out of track (line with no stations, loop, or opposite depot)
  if (v.p >= geomOf(line).total) {
    calloutRiders(v, "§6🚉 This is the end of the line — thanks for riding!");
    const dim = dimOf(line.d);
    if (dim) announce(dim, simPosOf(v), 20, "§eTrain arrived — end of the line");
    removeVTrain(v);
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
    const dest = destOf(line);
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
    const dy = sp.y - el.y;
    const dz = sp.z - el.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 4 || Math.abs(dy) > 3) {
      e.teleport({ x: sp.x, y: sp.y, z: sp.z }, { rotation: { x: 0, y: yawOf(heading) } });
    } else {
      const cap = dist > 1.2 ? 1.2 / dist : 1;
      // lift against gravity on ramps; stay grounded on the flat
      const vy = Math.abs(dy) > 0.3 ? Math.max(-0.7, Math.min(0.7, dy)) + 0.08 : 0;
      e.clearVelocity();
      e.applyImpulse({ x: dx * cap, y: vy, z: dz * cap });
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
    if (b) {
      // ALWAYS trust the live block for the departure direction — stale saved
      // facings (e.g. from before a direction fix) silently killed spawning.
      const f = travelDirOf(b);
      if (dep.fx !== f.x || dep.fz !== f.z) {
        dep.fx = f.x;
        dep.fz = f.z;
        dirty = true;
        resetLine(dep);
      }
    }
    let line = lineCache.get(key);
    if (!line) line = resetLine(dep);
    // self-heal: a finished survey that found no usable track (line built after
    // the depot, or a bad facing) rescans automatically while the depot is loaded
    if (b && line.done && line.len < MIN_LINE_LEN && tick - (line._resetAt ?? 0) > 200) {
      line = resetLine(dep);
    }

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
    const blocked = vtrains.some((v) => v.k === key && v.p < 4);
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
  if (line && line.done && line.len < MIN_LINE_LEN) {
    player.sendMessage(
      `§c${lname} — no usable track found from this depot (checked all four directions, level and one block up/down). Lay railway track leading away from this block; it rescans automatically.`
    );
  } else if (!line || !line.done) {
    player.sendMessage(
      `§b${lname} — §esurveying: ${line?.len ?? 0} blocks scanned, currently at ${line?.cx}, ${line?.cy}, ${line?.cz}. §7If it stays stuck, the track has a gap there (or that area needs to be loaded once — walk the line).`
    );
  } else {
    const a = line.wp[0];
    const b2 = line.wp[1] ?? [line.cx, line.cy, line.cz];
    const hd = cardinalOf({ x: Math.sign(b2[0] - a[0]), z: Math.sign(b2[2] - a[2]) });
    player.sendMessage(
      `§a${lname} — READY. §b${line.len} blocks heading ${hd}, ${line.st.length} station(s)${line.loop ? ", loop" : line.endDepot ? ", ends at a depot" : ""}. Trains every ${(ent.i ?? DEFAULT_INTERVAL) / 20}s, next in ${secs}s, ${active} running now.`
    );
  }
  player.sendMessage(
    "§7Sneak+interact: change interval. Name this line with a renamed Name Tag."
  );
}

// ---------------------------------------------------------------------------
// Naming (renamed Name Tag on a station or depot, or /scriptevent)
// ---------------------------------------------------------------------------
const nameCooldown = new Map();

function applyName(player, block, name) {
  const tick = system.currentTick;
  if ((nameCooldown.get(player.id) ?? -10) > tick - 4) return true; // both events can fire per tap
  nameCooldown.set(player.id, tick);
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
    // nearest registered station or depot within 12 blocks
    const pl = p.location;
    let best, bestD = 12;
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
      p.sendMessage(
        "§7No registered station or depot within 12 blocks. Tap the station/depot block once (registers it), then retry."
      );
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
    invalidateLines(p.dimension.id); // no location = reset every line
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
  let notReady = false;
  for (const [key, next] of depotNext) {
    const bar = key.indexOf("|");
    if (key.slice(0, bar) !== s.d) continue;
    const [x, , z] = key.slice(bar + 1).split(",").map(Number);
    if (Math.hypot(x + 0.5 - c.x, z + 0.5 - c.z) > 96) continue;
    const line = lineCache.get(key);
    if (!line || !line.done || line.len < MIN_LINE_LEN) {
      notReady = true; // don't show a countdown that can't deliver a train
      continue;
    }
    const secs = (next - tick) / 20;
    if (secs >= 0 && secs < dep) dep = secs;
  }

  const lines = [`§b§l${header}§r`];
  if (boarding) lines.push("§a>> NOW BOARDING <<");
  else if (bestEta < Infinity) lines.push(`§eTrain arriving in ~${Math.max(1, Math.ceil(bestEta))}s`);
  else lines.push("§7No trains approaching");
  if (dep < Infinity) lines.push(`§7Next departure: ${Math.ceil(dep)}s`);
  else if (notReady) lines.push("§cLine not ready — tap the depot for details");
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
    for (let f = -1; f <= 3; f++) {
      reshapeTrack(dim, bl.x + d.x * f, y, bl.z + d.z * f);
      reshapeTrack(dim, bl.x + d.x * f, y - 1, bl.z + d.z * f);
      reshapeTrack(dim, bl.x + d.x * f, y + 1, bl.z + d.z * f);
    }
    invalidateLines(dim.id, { x: bl.x, y, z: bl.z });
    player.onScreenDisplay.setActionBar(`§aTrack segment laid (3x3, heading ${cardinalOf(d)})`);
    try {
      dim.playSound("dig.stone", { x: bl.x + 0.5, y: y + 0.5, z: bl.z + 0.5 });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Track auto-shaping: plain track blocks pick straight/corner/slope shapes
// from their neighbours, like vanilla rails.
// ---------------------------------------------------------------------------
function reshapeTrack(dim, x, y, z) {
  const b = safeBlock(dim, { x, y, z });
  if (!b || b.typeId !== "trains:track") return;
  const isTrack = (ox, oy, oz) => {
    const nb = safeBlock(dim, { x: x + ox, y: y + oy, z: z + oz });
    return nb !== undefined && TRACK_TYPES.has(nb.typeId);
  };

  const flat = []; // neighbours at the same level
  const up = []; // neighbours one block up (ramp climbs toward these)
  let touchingSides = 0; // sides with ANY track at level or +/-1
  for (const [name, d] of Object.entries(DIRS)) {
    const s = isTrack(d.x, 0, d.z);
    const u = isTrack(d.x, 1, d.z);
    const dn = isTrack(d.x, -1, d.z);
    if (s) flat.push({ name, d });
    if (u) up.push({ name, d });
    if (s || u || dn) touchingSides++;
  }

  let shape = "straight";
  let card = flat[0]?.name ?? null;

  if (up.length > 0) {
    // a raised neighbour means this is a ramp up toward it
    shape = "slope";
    card = up[0].name;
  } else if (flat.length === 2 && touchingSides === 2) {
    // exactly two neighbours, both flat, nothing else touching:
    // opposite -> straight, perpendicular -> a clean corner
    const [a, c] = flat;
    const opp = a.d.x === -c.d.x && a.d.z === -c.d.z;
    if (!opp) {
      // base corner connects <card> and right-of-<card>
      const set = new Set([a.name, c.name]);
      for (const [name, d] of Object.entries(DIRS)) {
        if (set.has(name) && set.has(cardinalOf(rightOf(d)))) {
          shape = "corner";
          card = name;
          break;
        }
      }
    }
  }
  // junctions / crossings / parallel double-track (3+ touching sides) stay straight

  if (!card) return; // isolated block: leave as placed
  try {
    const cur = b.permutation;
    if (
      cur.getState("trains:shape") === shape &&
      cur.getState("minecraft:cardinal_direction") === card
    ) {
      return;
    }
    b.setPermutation(
      BlockPermutation.resolve("trains:track", {
        "minecraft:cardinal_direction": card,
        "trains:shape": shape
      })
    );
  } catch {}
}

function reshapeAround(dim, loc) {
  for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const dy of [-1, 0, 1]) {
      reshapeTrack(dim, loc.x + dx, loc.y + dy, loc.z + dz);
    }
  }
}

// ---------------------------------------------------------------------------
// Tunnel maker: bores a 6x6x6 tunnel — digs solids out of the interior and
// lines floor/walls/ceiling with cobblestone wherever there's a gap.
// ---------------------------------------------------------------------------
function consumeDurability(player, itemType) {
  try {
    if (player.getGameMode() === GameMode.Creative) return;
    const eq = player.getComponent("minecraft:equippable");
    const item = eq?.getEquipment(EquipmentSlot.Mainhand);
    if (!item || item.typeId !== itemType) return;
    const dur = item.getComponent("minecraft:durability");
    if (!dur) return;
    if (dur.damage + 1 >= dur.maxDurability) {
      eq.setEquipment(EquipmentSlot.Mainhand, undefined);
      try {
        player.dimension.playSound("random.break", player.location);
      } catch {}
    } else {
      dur.damage += 1;
      eq.setEquipment(EquipmentSlot.Mainhand, item);
    }
  } catch {}
}

const TUNNEL_PROTECTED = new Set([
  ...TRACK_TYPES,
  "trains:platform",
  "trains:arrival_screen",
  "trains:escalator_up",
  "trains:escalator_down",
  "minecraft:bedrock"
]);

function boreTunnel(player, base) {
  const tick = system.currentTick;
  if ((wandCooldown.get(player.id) ?? -10) > tick - 4) return;
  wandCooldown.set(player.id, tick);

  const dim = player.dimension;
  const d = facingDir(player);
  const perp = { x: -d.z, z: d.x };
  const bl = base.location;
  let changed = 0;

  const lineWith = (pos) => {
    const b = safeBlock(dim, pos);
    if (b && (b.isAir || b.isLiquid)) {
      try {
        b.setType("minecraft:cobblestone");
        changed++;
      } catch {}
    }
  };

  for (let f = 1; f <= 6; f++) {
    for (let s = -2; s <= 3; s++) {
      const cx = bl.x + d.x * f + perp.x * s;
      const cz = bl.z + d.z * f + perp.z * s;
      // interior 6 wide x 6 high: dig out anything solid (except railway gear)
      for (let dy = 1; dy <= 6; dy++) {
        const b = safeBlock(dim, { x: cx, y: bl.y + dy, z: cz });
        if (b && !b.isAir && !TUNNEL_PROTECTED.has(b.typeId)) {
          try {
            b.setType("minecraft:air");
            changed++;
          } catch {}
        }
      }
      // floor & ceiling: patch gaps with cobblestone
      lineWith({ x: cx, y: bl.y, z: cz });
      lineWith({ x: cx, y: bl.y + 7, z: cz });
    }
    // side walls: patch gaps with cobblestone
    for (const s of [-3, 4]) {
      const cx = bl.x + d.x * f + perp.x * s;
      const cz = bl.z + d.z * f + perp.z * s;
      for (let dy = 0; dy <= 7; dy++) lineWith({ x: cx, y: bl.y + dy, z: cz });
    }
    // lighting: a torch on the floor against each wall, midway through the bore
    if (f === 3) {
      for (const s of [-2, 3]) {
        const b = safeBlock(dim, {
          x: bl.x + d.x * f + perp.x * s,
          y: bl.y + 1,
          z: bl.z + d.z * f + perp.z * s
        });
        if (b && b.isAir) {
          try {
            b.setType("minecraft:torch");
            changed++;
          } catch {}
        }
      }
    }
  }

  if (changed > 0) {
    player.onScreenDisplay.setActionBar("§aTunnel bored (6x6, 6 deep)");
    try {
      dim.playSound("dig.stone", { x: bl.x + 0.5, y: bl.y + 1.5, z: bl.z + 0.5 });
    } catch {}
    consumeDurability(player, "trains:tunnel_maker");
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
  if (TRACK_TYPES.has(t)) {
    reshapeAround(ev.block.dimension, ev.block.location);
    invalidateLines(ev.block.dimension.id, ev.block.location);
  }
});

world.afterEvents.playerBreakBlock.subscribe((ev) => {
  const t = ev.brokenBlockPermutation.type.id;
  if (t === "trains:depot_track") unregisterDepot(ev.dimension.id, ev.block.location);
  else if (t === "trains:arrival_screen") unregisterScreen(ev.dimension.id, ev.block.location);
  else if (t === "trains:station_track") unregisterStation(ev.dimension.id, ev.block.location);
  if (TRACK_TYPES.has(t)) {
    reshapeAround(ev.dimension, ev.block.location);
    invalidateLines(ev.dimension.id, ev.block.location);
  }
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
  if (item?.typeId === "trains:tunnel_maker") {
    boreTunnel(player, block);
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
  const t = ev.itemStack?.typeId;
  if (t !== "trains:track_planner" && t !== "trains:tunnel_maker" && t !== "minecraft:name_tag") return;
  const p = ev.source;
  if (!p || p.typeId !== "minecraft:player") return;
  const hit = p.getBlockFromViewDirection({ maxDistance: 12 });
  if (!hit?.block) return;
  if (t === "trains:track_planner") tryPlaceSegment(p, hit.block);
  else if (t === "trains:tunnel_maker") boreTunnel(p, hit.block);
  else {
    // second path for naming — some platforms deliver name-tag taps here
    const b = hit.block;
    if (b.typeId !== "trains:station_track" && b.typeId !== "trains:depot_track") return;
    const name = ev.itemStack.nameTag?.trim();
    if (name) applyName(p, b, name);
    else p.sendMessage("§7Rename the Name Tag on an anvil first, then tap the block with it.");
  }
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
