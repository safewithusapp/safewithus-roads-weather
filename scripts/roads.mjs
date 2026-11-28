#!/usr/bin/env node
// 🗺️ Map layers for ONE country — from a Geofabrik extract of OpenStreetMap.
//
// Same layers and same file format as the private repo's fetch-zones.mjs, but
// instead of asking Overpass question by question (slow, busy servers) it
// takes the whole country file at once and reads it locally with osmium.
//
//   📦 download.geofabrik.de  → the country's .osm.pbf (big countries: their regions)
//   ✂️ osmium                  → keep only what we need, add node locations to ways
//   🧮 this script             → the layers below, written to data/<cc>/*.ts
//
//   🛣️ travelRoads   ↪️ sharpCurves   🚦 fastJunctions   ⚠️ speedBumps   🚸 schools
//   ⚠️ camelCrossings 🌊 wadiCrossings 🚂 levelCrossings 🔢 speedLimits
//
// Data © OpenStreetMap contributors, ODbL. No keys, no accounts.
// Env: COUNTRY (ISO alpha-2). Prints STATUS=DONE or STATUS=FAILED at the end.

import { execFileSync } from "node:child_process";
import { createReadStream, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CC = (process.env.COUNTRY ?? "SA").toUpperCase();
const OUT = `data/${CC.toLowerCase()}`;
const TMP = `work/${CC.toLowerCase()}`;
const STRICT = CC === "SA";
// 📸 Speed cameras only where warning about them is allowed (plan.json → noSpeedCameras).
const CAMERAS_OK = !(JSON.parse(readFileSync("plan.json", "utf8")).noSpeedCameras ?? []).includes(CC); // Saudi sizes are known — refuse a collapse
// Where the files will live in the app's server: Saudi in zones/, others in zones/countries/<cc>/
const GEO_IMPORT = CC === "SA" ? "../geo" : "../../../geo";
const MAX_PART_BYTES = 1_500_000_000; // bigger than this → use the country's regions instead
const UA = "SafeWithUs-map-data/1.0 (github.com/safewithusapp)";
const WHERE = STRICT ? "Saudi Arabia" : CC;
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
/** push without spreading (a spread of 200 000 points overflows the call stack) */
const append = (to, items) => { for (const x of items) to.push(x); };
const LAYERS = [
  ["travelRoads.ts", "TRAVEL_ROADS", `🛣️ Travel roads (motorway + trunk) in ${WHERE}`],
  ["sharpCurves.ts", "SHARP_CURVES", `↪️ Sharp curves (≥ 45° over ~300 m) on travel roads in ${WHERE}`],
  ["fastJunctions.ts", "FAST_JUNCTIONS", `🚦 At-grade junctions on motorway / trunk roads in ${WHERE}`],
  ["speedBumps.ts", "SPEED_BUMPS", `⚠️ Speed bumps (OSM traffic_calming) in ${WHERE}`],
  ["schools.ts", "SCHOOLS", `🚸 Schools and kindergartens in ${WHERE}`],
  ["camelCrossings.ts", "CAMEL_CROSSINGS", `⚠️ Animal (camel) crossing points in ${WHERE}`],
  ["wadiCrossings.ts", "WADI_CROSSINGS", `🌊 Roads crossing a wadi / stream at grade in ${WHERE}`],
  ["levelCrossings.ts", "LEVEL_CROSSINGS", `🚂 Railway level crossings in ${WHERE}`],
];

// ── 2. Each part → a small OPL text with only our objects ─────────────────
const FILTERS = [
  "nwr/amenity=school,kindergarten",
  "nwr/hazard=animal_crossing", "nwr/hazard:animal=camel", "nwr/animal_crossing", "n/traffic_sign",
  "w/highway=motorway,trunk,primary,secondary,tertiary",
  "w/waterway=wadi,river,stream",
  "n/ford=yes", "n/railway=level_crossing", "n/traffic_calming=bump,hump,table,cushion,yes",
  // ➕ roadExtras.ts
  "nwr/hazard", "n/highway=crossing", "n/mountain_pass=yes", "n/barrier=toll_booth", "n/maxheight",
  "nwr/amenity=hospital,fuel", "nwr/highway=rest_area,services", "n/highway=speed_camera",
];

async function download(url, file) {
  for (let t = 1; t <= 3; t++) {
    try {
      sh("curl", ["-fsSL", "--retry", "5", "--retry-connrefused", "--retry-delay", "20", "-A", UA, "-o", file, url]);
      return;
    } catch (e) {
      if (t === 3) throw e;
      await new Promise((r) => setTimeout(r, 30_000 * t));
    }
  }
}

/** Shared extracts (GCC States, Israel & Palestine …): keep only this country, by its own admin_level=2 border. */
function cutCountry(pbf) {
  const bnd = `${TMP}/borders.pbf`;
  const seq = `${TMP}/borders.geojsonseq`;
  sh("osmium", ["tags-filter", pbf, "r/boundary=administrative", "-o", bnd, "--overwrite"]);
  sh("osmium", ["export", bnd, "-f", "geojsonseq", "--geometry-types=polygon", "-o", seq, "--overwrite"]);
  const text = execFileSync("cat", [seq], { maxBuffer: 2 * 1024 ** 3 }).toString("utf8");
  let border = null;
  for (const line of text.split("\n")) {
    const s = line.replace(/^\x1e/, "").trim();
    if (!s) continue;
    let f;
    try { f = JSON.parse(s); } catch { continue; }
    const p = f.properties ?? {};
    if (String(p.admin_level) !== "2") continue;
    if ((p["ISO3166-1"] ?? p["ISO3166-1:alpha2"]) === CC) { border = f; break; }
  }
  if (!border) throw new Error(`no admin_level=2 border for ${CC} in the shared extract`);
  writeFileSync(`${TMP}/border.geojson`, JSON.stringify({ type: "Feature", properties: {}, geometry: border.geometry }));
  const cut = `${TMP}/cut.pbf`;
  sh("osmium", ["extract", "-p", `${TMP}/border.geojson`, pbf, "-o", cut, "--overwrite"]);
  rmSync(bnd, { force: true });
  rmSync(seq, { force: true });
  return cut;
}

function toOpl(pbf, n) {
  const filtered = `${TMP}/f${n}.pbf`;
  const opl = `${TMP}/f${n}.opl`;
  sh("osmium", ["tags-filter", pbf, ...FILTERS, "-o", filtered, "--overwrite"]);
  sh("osmium", ["add-locations-to-ways", filtered, "-f", "opl,add_metadata=false", "-o", opl, "--overwrite"]);
  rmSync(filtered, { force: true });
  return opl;
}

// ── 3. Read the OPL lines ──────────────────────────────────────────────────
const unescape = (s) => s.replace(/%([0-9a-fA-F]+)%/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
function parseTags(field) {
  const tags = {};
  if (!field || field === "T") return tags;
  for (const kv of field.slice(1).split(",")) {
    const i = kv.indexOf("=");
    if (i > 0) tags[unescape(kv.slice(0, i))] = unescape(kv.slice(i + 1));
  }
  return tags;
}
/** One OPL line → { type, id, tags, lat, lon, nodes:[{id, lat, lon}] } */
export function parseLine(line) {
  const parts = line.split(" ");
  const head = parts[0];
  const o = { type: head[0], id: Number(head.slice(1)), tags: {}, nodes: null };
  for (const f of parts.slice(1)) {
    if (f[0] === "T") o.tags = parseTags(f);
    else if (f[0] === "x" && f.length > 1) o.lon = Number(f.slice(1));
    else if (f[0] === "y" && f.length > 1) o.lat = Number(f.slice(1));
    else if (f[0] === "N") {
      o.nodes = [];
      for (const ref of f.slice(1).split(",")) {
        const m = ref.match(/^n(-?\d+)x(-?[\d.]+)y(-?[\d.]+)$/);
        if (m) o.nodes.push({ id: Number(m[1]), lon: Number(m[2]), lat: Number(m[3]) });
      }
    }
  }
  return o;
}
async function* lines(file) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const l of rl) if (l) yield l;
}

const FAST = new Set(["motorway", "trunk"]);
const SIDE = new Set(["primary", "secondary", "tertiary"]);
const LIMIT_ROADS = new Set(["motorway", "trunk", "primary", "secondary"]);
const BUMPS = new Set(["bump", "hump", "table", "cushion", "yes"]);
const isCamel = (t) => t.hazard === "animal_crossing" || t["hazard:animal"] === "camel" || t.animal_crossing !== undefined
  || /camel|animal/i.test(t.traffic_sign ?? "");
const centre = (o) => {
  if (typeof o.lat === "number") return { lat: o.lat, lon: o.lon };
  if (!o.nodes?.length) return null;
  let lat = 0, lon = 0;
  for (const n of o.nodes) { lat += n.lat; lon += n.lon; }
  return { lat: lat / o.nodes.length, lon: lon / o.nodes.length };
};

/** Reads one part's OPL (two passes) into the same shapes Overpass gave. */
export async function readPart(opl) {
  const r = { schools: [], camels: [], bumps: [], rails: [], fords: [], travel: [], limitWays: [], junctions: [], wadis: [], ...emptyExtras() };
  const crossingNodes = new Map(); // highway=crossing nodes → found on a fast road later
  const fastNodes = new Map(); // id → {lat, lon}
  const sideNodes = new Set();
  const groundRoadNodes = new Set(); // road nodes that are not on a bridge
  const busyNodes = new Set(); // primary road nodes — a zebra here is on a busy road
  for await (const l of lines(opl)) {
    const o = parseLine(l);
    const t = o.tags;
    if (o.type === "r") continue;
    if (t.amenity === "school" || t.amenity === "kindergarten") { const c = centre(o); if (c) r.schools.push(c); }
    if (isCamel(t)) { const c = centre(o); if (c) r.camels.push(c); }
    collectExtras(o, t, r, crossingNodes);
    if (o.type === "n") {
      if (BUMPS.has(t.traffic_calming)) r.bumps.push(o);
      if (t.railway === "level_crossing") r.rails.push(o);
      if (t.ford === "yes") r.fords.push(o);
      continue;
    }
    const hw = t.highway;
    if (!hw || !o.nodes) continue;
    const geometry = o.nodes.map((n) => ({ lat: n.lat, lon: n.lon }));
    if (FAST.has(hw)) {
      r.travel.push({ geometry, tags: t });
      for (const n of o.nodes) fastNodes.set(n.id, n);
    }
    if (SIDE.has(hw)) for (const n of o.nodes) sideNodes.add(n.id);
    if (hw === "primary") for (const n of o.nodes) busyNodes.add(n.id);
    if (LIMIT_ROADS.has(hw) && t.maxspeed) r.limitWays.push({ geometry, tags: { maxspeed: t.maxspeed } });
    if (!t.bridge) for (const n of o.nodes) groundRoadNodes.add(n.id);
  }
  for (const [id, n] of fastNodes) if (sideNodes.has(id)) r.junctions.push(n);
  for (const [id, n] of crossingNodes) if (fastNodes.has(id) || busyNodes.has(id)) r.crossings.push(n);
  // Pass 2 — a road node that a wadi / stream also uses = the road crosses it at grade (no bridge).
  for await (const l of lines(opl)) {
    if (l[0] !== "w" || !/(^| )T.*waterway=(wadi|river|stream)(,|$| )/.test(l)) continue;
    const o = parseLine(l);
    if (!["wadi", "river", "stream"].includes(o.tags.waterway) || !o.nodes) continue;
    for (const n of o.nodes) if (groundRoadNodes.has(n.id)) r.wadis.push(n);
  }
  return r;
}

// ── 3b. Everything else on or beside the road (roadExtras.ts) ─────────────
const UNPAVED = new Set(["unpaved", "gravel", "dirt", "sand", "ground", "earth", "compacted", "fine_gravel", "mud", "grass"]);
const MAIN = new Set(["motorway", "trunk", "primary", "secondary"]);
export function emptyExtras() {
  return { cameras: [], hazards: [], crossings: [], tunnels: [], darkWays: [], unpavedWays: [], passes: [], tolls: [], lowClearance: [], hospitals: [], fuel: [], restAreas: [] };
}
/** "4.5", "4.5 m", "14'6\"" → metres (null if unreadable) */
export function parseHeight(v) {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d+(?:\.\d+)?)\s*m?$/i);
  if (m) return Number(m[1]);
  m = s.match(/^(\d+)'\s*(\d+)?"?$/);
  if (m) return Math.round((Number(m[1]) * 0.3048 + Number(m[2] ?? 0) * 0.0254) * 100) / 100;
  return null;
}
function collectExtras(o, t, r, crossingNodes) {
  const c = () => centre(o);
  if (t.hazard && t.hazard !== "animal_crossing") { const p = c(); if (p) r.hazards.push({ ...p, kind: t.hazard }); }
  if (t.amenity === "hospital" && t.emergency !== "no") { const p = c(); if (p) r.hospitals.push(p); }
  if (t.amenity === "fuel") { const p = c(); if (p) r.fuel.push(p); }
  if (t.highway === "rest_area" || t.highway === "services") { const p = c(); if (p) r.restAreas.push(p); }
  if (o.type === "n") {
    if (t.highway === "crossing") crossingNodes.set(o.id, { lat: o.lat, lon: o.lon });
    if (t.mountain_pass === "yes") r.passes.push(o);
    if (t.barrier === "toll_booth") r.tolls.push(o);
    if (t.highway === "speed_camera" && CAMERAS_OK) r.cameras.push({ lat: o.lat, lon: o.lon, kmh: parseMaxspeed(t.maxspeed) ?? 0 });
    const h = parseHeight(t.maxheight);
    if (h && h < 6) r.lowClearance.push({ lat: o.lat, lon: o.lon, h });
    return;
  }
  const hw = t.highway;
  if (!hw || !o.nodes?.length) return;
  const geometry = o.nodes.map((n) => ({ lat: n.lat, lon: n.lon }));
  if (MAIN.has(hw) && t.tunnel && t.tunnel !== "no") r.tunnels.push(geometry[0]);
  if (FAST.has(hw) && t.lit === "no") r.darkWays.push({ geometry });
  if ((MAIN.has(hw) || hw === "tertiary") && UNPAVED.has(t.surface)) r.unpavedWays.push({ geometry });
  const h = parseHeight(t.maxheight);
  if (h && h < 6) r.lowClearance.push({ ...geometry[0], h });
}

// ── 4. The same layer maths as fetch-zones.mjs ─────────────────────────────
const R = 6_371_000;
const rad = (d) => (d * Math.PI) / 180;
const dist = (a, b) => R * Math.hypot(rad(b.lat - a.lat), rad(b.lon - a.lon) * Math.cos(rad((a.lat + b.lat) / 2)));
export function toPoints(list) {
  const seen = new Set();
  const points = [];
  for (const el of list) {
    if (typeof el.lat !== "number" || typeof el.lon !== "number") continue;
    const p = [Math.round(el.lat * 1e4) / 1e4, Math.round(el.lon * 1e4) / 1e4];
    const k = p.join(",");
    if (seen.has(k)) continue;
    seen.add(k);
    points.push(p);
  }
  return points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
const thin = (deg) => (points) => {
  const seen = new Set();
  return points.filter(([lat, lon]) => {
    const k = `${Math.floor(lat / deg)}:${Math.floor(lon / deg)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
const thinToGrid = thin(0.01); // ~1 km
const thinFine = thin(0.005); // ~550 m
const SAMPLE_M = 800;
export function roadPoints(ways) {
  const out = [];
  for (const { geometry: g } of ways) {
    if (!g.length) continue;
    out.push(g[0]);
    for (let i = 1; i < g.length; i++) {
      const a = g[i - 1], b = g[i], d = dist(a, b);
      for (let k = 1; k <= Math.floor(d / SAMPLE_M); k++) {
        const t = (k * SAMPLE_M) / d;
        out.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
      }
      out.push(b);
    }
  }
  return toPoints(out);
}
const CURVE_DEG = 45;
const CURVE_HALF_M = 150;
export function sharpCurves(ways) {
  const bearing = (a, b) => {
    const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
    return (Math.atan2(y, x) * 180) / Math.PI;
  };
  const out = [];
  for (const { geometry: g, tags } of ways) {
    if (g.length < 3 || tags?.junction === "roundabout") continue;
    const along = [0];
    for (let i = 1; i < g.length; i++) along.push(along[i - 1] + dist(g[i - 1], g[i]));
    let a = 0, b = 0;
    for (let i = 1; i < g.length - 1; i++) {
      while (a < i && along[i] - along[a + 1] >= CURVE_HALF_M) a++;
      if (b < i) b = i;
      while (b < g.length - 1 && along[b] - along[i] < CURVE_HALF_M) b++;
      if (along[i] - along[a] < CURVE_HALF_M || along[b] - along[i] < CURVE_HALF_M) continue;
      let turn = Math.abs(bearing(g[a], g[i]) - bearing(g[i], g[b])) % 360;
      if (turn > 180) turn = 360 - turn;
      if (turn >= CURVE_DEG) out.push(g[i]);
    }
  }
  return toPoints(out);
}
export function parseMaxspeed(v) {
  const m = String(v ?? "").trim().match(/^(\d{2,3})\s*(mph|km\/h|kmh)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const kmh = /mph/i.test(m[2] ?? "") ? Math.round(n * 1.609) : n;
  return kmh >= 10 && kmh <= 200 ? kmh : null;
}
export function speedLimitPoints(ways) {
  const seen = new Set();
  const out = [];
  const push = (lat, lon, kmh) => {
    const k = `${Math.floor(lat / 0.003)}:${Math.floor(lon / 0.003)}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push([Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4, kmh]);
  };
  for (const { geometry: g, tags } of ways) {
    const kmh = parseMaxspeed(tags?.maxspeed);
    if (!kmh || !g.length) continue;
    push(g[0].lat, g[0].lon, kmh);
    for (let i = 1; i < g.length; i++) {
      const d = dist(g[i - 1], g[i]);
      for (let k = 1; k <= Math.floor(d / 300); k++) {
        const t = (k * 300) / d;
        push(g[i - 1].lat + (g[i].lat - g[i - 1].lat) * t, g[i - 1].lon + (g[i].lon - g[i - 1].lon) * t, kmh);
      }
      push(g[i].lat, g[i].lon, kmh);
    }
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

// ── 5. Writing the files (same format the server already imports) ─────────
function writePoints(file, constName, title, points) {
  writeFileSync(`${OUT}/${file}`, `// ${title} — [latitude, longitude].
//
// GENERATED by safewithus-map-data/scripts/roads.mjs — do not edit by hand.
// Data © OpenStreetMap contributors, ODbL — https://www.openstreetmap.org/copyright
//
// ${points.length} points.
import type { LatLon } from '${GEO_IMPORT}';

export const ${constName}: ReadonlyArray<LatLon> = [
${points.map((p) => `  [${p[0]}, ${p[1]}],`).join("\n")}
];
`);
  console.log(`✅ ${file}: ${points.length}`);
}
function writeLimits(rows) {
  writeFileSync(`${OUT}/speedLimits.ts`, `// 🔢 Posted speed limits (OSM maxspeed) on main roads in ${WHERE} — [latitude, longitude, km/h].
//
// GENERATED by safewithus-map-data/scripts/roads.mjs — do not edit by hand.
// Data © OpenStreetMap contributors, ODbL — https://www.openstreetmap.org/copyright
//
// ${rows.length} points.

export const SPEED_LIMITS: ReadonlyArray<readonly [number, number, number]> = [
${rows.map((p) => `  [${p[0]}, ${p[1]}, ${p[2]}],`).join("\n")}
];
`);
  console.log(`✅ speedLimits.ts: ${rows.length}`);
}
function writeEmpty() {
  for (const [f, c, t] of LAYERS) writePoints(f, c, t, []);
  writeLimits([]);
  writeExtras({ ...emptyExtras(), darkRoads: [], unpavedRoads: [] });
}
/** One file for every extra layer — fewer files, same import style. */
export function writeExtras(x) {
  const asLL = (list) => list.map((p) => (Array.isArray(p) ? { lat: p[0], lon: p[1] } : p));
  const pts = (list, th = (v) => v) => th(toPoints(asLL(list)));
  const tagged = (list, field, cellDeg) => {
    const seen = new Set();
    const out = [];
    for (const p of list) {
      const lat = Math.round(p.lat * 1e4) / 1e4, lon = Math.round(p.lon * 1e4) / 1e4;
      const k = `${Math.floor(lat / cellDeg)}:${Math.floor(lon / cellDeg)}:${p[field]}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([lat, lon, p[field]]);
    }
    return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  };
  const L = (name, title, points) => `// ${title} — ${points.length}\nexport const ${name}: ReadonlyArray<LatLon> = [\n${points.map((p) => `  [${p[0]}, ${p[1]}],`).join("\n")}\n];\n`;
  const T = (name, title, type, rows, q) => `// ${title} — ${rows.length}\nexport const ${name}: ReadonlyArray<readonly [number, number, ${type}]> = [\n${rows.map((r) => `  [${r[0]}, ${r[1]}, ${q ? JSON.stringify(r[2]) : r[2]}],`).join("\n")}\n];\n`;
  const body = [
    T("SPEED_CAMERAS", CAMERAS_OK ? "📸 Speed cameras [lat, lon, km/h limit or 0]" : "📸 Speed cameras — none: warning about them is not allowed in this country", "number", tagged(x.cameras, "kmh", 0.002), false),
    T("HAZARDS", "⚠️ Signed hazards (OSM hazard=*: falling rocks, slippery, ice, flooding, curves …) [lat, lon, kind]", "string", tagged(x.hazards, "kind", 0.005), true),
    L("FAST_ROAD_CROSSINGS", "🚶 Pedestrian crossings on motorway / trunk / primary roads", pts(x.crossings, thinFine)),
    L("TUNNELS", "🚇 Tunnel entrances on main roads", pts(x.tunnels, thinFine)),
    L("DARK_ROADS", "🌑 Unlit travel roads (lit=no), ~1 km apart", pts(x.darkRoads, thinToGrid)),
    L("UNPAVED_ROADS", "🟫 Unpaved main roads, ~1 km apart", pts(x.unpavedRoads, thinToGrid)),
    L("MOUNTAIN_PASSES", "⛰️ Mountain passes", pts(x.passes)),
    L("TOLL_BOOTHS", "🛂 Toll booths", pts(x.tolls, thinFine)),
    T("LOW_CLEARANCE", "🚚 Low clearance under 6 m (bridges, tunnels) [lat, lon, metres]", "number", tagged(x.lowClearance, "h", 0.003), false),
    L("HOSPITALS", "🏥 Hospitals (with an emergency department or not stated)", pts(x.hospitals)),
    L("FUEL_STATIONS", "⛽ Fuel stations", pts(x.fuel)),
    L("REST_AREAS", "🅿️ Rest areas and motorway services", pts(x.restAreas)),
  ].join("\n");
  writeFileSync(`${OUT}/roadExtras.ts`, `// ➕ Everything else on or beside the road in ${WHERE}.
//
// GENERATED by safewithus-map-data/scripts/roads.mjs — do not edit by hand.
// Data © OpenStreetMap contributors, ODbL — https://www.openstreetmap.org/copyright
import type { LatLon } from '${GEO_IMPORT}';

${body}`);
  console.log("✅ roadExtras.ts");
}

// ── 6. Run (only when started directly — tests import the functions) ────────
const direct = fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
if (direct) await main();

async function main() {
mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });
// ── 1. Which Geofabrik files hold this country? ───────────────────────────
// Geofabrik refuses connections when many runners ask at once — wait and try again.
let index = null;
for (let t = 1; t <= 6 && !index; t++) {
  try {
    index = await (await fetch("https://download.geofabrik.de/index-v1-nogeom.json", { headers: { "user-agent": UA } })).json();
  } catch (e) {
    console.warn(`⚠️ Geofabrik index: ${e.cause?.code ?? e.message} (try ${t})`);
    // Not our fault: this runner's address is refused — try again next round on another runner.
    if (t === 6) { console.log("STATUS=PARTIAL"); process.exit(0); }
    await new Promise((r) => setTimeout(r, 60_000 * t));
  }
}
const features = index.features.map((f) => f.properties);
// Geofabrik keeps Saudi Arabia inside its "GCC States" file without listing SA there.
const HOME = { SA: "gcc-states" };
const mine = features
  .filter((p) => ((p["iso3166-1:alpha2"] ?? []).includes(CC) || p.id === HOME[CC]) && p.urls?.pbf)
  .sort((a, b) => (a["iso3166-1:alpha2"].length - b["iso3166-1:alpha2"].length) || (b.id.length - a.id.length));
if (mine.length === 0 && STRICT) {
  console.error("::error::No Geofabrik extract found for SA — refusing to write empty layers.");
  console.log("STATUS=FAILED");
  process.exit(1);
}
if (mine.length === 0) {
  console.log(`No Geofabrik extract lists ${CC} — nothing to do.`);
  writeEmpty();
  console.log("STATUS=DONE");
  process.exit(0);
}
const region = mine[0];
const shared = region["iso3166-1:alpha2"].length > 1; // e.g. GCC States = SA AE KW QA BH OM

async function sizeOf(url) {
  const res = await fetch(url, { method: "HEAD", headers: { "user-agent": UA } });
  return Number(res.headers.get("content-length") ?? 0);
}
/** A too-big file is replaced by its child regions (US → states, DE → Länder …). */
async function parts(p) {
  const size = await sizeOf(p.urls.pbf);
  const kids = features.filter((k) => k.parent === p.id && k.urls?.pbf);
  if (size <= MAX_PART_BYTES || kids.length === 0) return [{ id: p.id, url: p.urls.pbf, size }];
  const out = [];
  for (const k of kids) out.push(...(await parts(k)));
  return out;
}
const files = await parts(region);
console.log(`📦 ${CC}: ${files.map((f) => `${f.id} (${Math.round(f.size / 1e6)} MB)`).join(", ")}${shared ? " — shared extract, cut by the country border" : ""}`);


const all = { schools: [], camels: [], bumps: [], rails: [], fords: [], travel: [], limitWays: [], junctions: [], wadis: [] };
const results = { travelRoads: [], curves: [], limits: [] };
const extras = { ...emptyExtras(), darkRoads: [], unpavedRoads: [] };
for (let i = 0; i < files.length; i++) {
  const f = files[i];
  const pbf = `${TMP}/part.pbf`;
  console.log(`⬇️ ${f.id}`);
  try {
    await download(f.url, pbf);
  } catch {
    console.warn(`⚠️ ${f.id}: Geofabrik refused the download — the next round tries again on another runner.`);
    console.log("STATUS=PARTIAL");
    process.exit(0);
  }
  const src = shared ? cutCountry(pbf) : pbf;
  const opl = toOpl(src, i);
  rmSync(pbf, { force: true });
  rmSync(`${TMP}/cut.pbf`, { force: true });
  const r = await readPart(opl);
  rmSync(opl, { force: true });
  // Roads are turned into points per part, so a huge country never holds every way at once.
  append(results.travelRoads, roadPoints(r.travel));
  append(results.curves, sharpCurves(r.travel));
  append(results.limits, speedLimitPoints(r.limitWays));
  for (const k of ["schools", "camels", "bumps", "rails", "fords", "junctions", "wadis"]) append(all[k], r[k]);
  for (const k of ["cameras", "hazards", "crossings", "tunnels", "passes", "tolls", "lowClearance", "hospitals", "fuel", "restAreas"]) append(extras[k], r[k]);
  append(extras.darkRoads, roadPoints(r.darkWays));
  append(extras.unpavedRoads, roadPoints(r.unpavedWays));
  console.log(`   ${f.id}: ${r.travel.length} travel ways, ${r.schools.length} schools`);
}

const asLL = (pts) => pts.map(([lat, lon]) => ({ lat, lon }));
const travelRoads = thinToGrid(toPoints(asLL(results.travelRoads)));
const curves = thinFine(toPoints(asLL(results.curves)));
const limits = (() => { // dedupe across parts
  const seen = new Set();
  return results.limits.filter(([lat, lon]) => {
    const k = `${Math.floor(lat / 0.003)}:${Math.floor(lon / 0.003)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
})();
const layers = {
  "travelRoads.ts": travelRoads,
  "sharpCurves.ts": curves,
  "fastJunctions.ts": thinFine(toPoints(all.junctions)),
  "speedBumps.ts": thinFine(toPoints(all.bumps)),
  "schools.ts": toPoints(all.schools),
  "camelCrossings.ts": toPoints(all.camels),
  "wadiCrossings.ts": thinFine(toPoints(all.wadis.concat(all.fords))),
  "levelCrossings.ts": toPoints(all.rails),
};

// A collapse usually means a broken download, not that Saudi lost its schools.
if (STRICT && (layers["schools.ts"].length < 500 || travelRoads.length < 500)) {
  console.error(`::error::Only ${layers["schools.ts"].length} schools / ${travelRoads.length} road points for SA — refusing to write.`);
  console.log("STATUS=FAILED");
  process.exit(1);
}
for (const [f, c, t] of LAYERS) writePoints(f, c, t, layers[f]);
writeLimits(limits);
writeExtras(extras);
rmSync(TMP, { recursive: true, force: true });
console.log("STATUS=DONE");
}
