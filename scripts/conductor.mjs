#!/usr/bin/env node
// 🧠 The conductor — picks the work, runs one task, saves the results.
//
//   plan                 → which tasks run now (up to plan.parallel at once), in the planned country order
//   work <CC> <JOB>      → runs one task and puts only ITS files in out/ (one artifact per task)
//   save                 → copies every task's files into the repo, updates state.json + progress.md
//
// Jobs per country: osm (roads.mjs) → weather, dust, slopes (meteo.py / slopes.py).
// One world job: dustgrid (the whole world's dust, used by every country's dust job).
// A task that fails three times rests 7 days so it never blocks the queue.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

const PLAN = JSON.parse(readFileSync("plan.json", "utf8"));
const STATE_FILE = "state.json";
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
state.done ??= {};
state.fails ??= {};
const today = new Date().toISOString().slice(0, 10);
const COUNTRIES = PLAN.rings.flat();
const COUNTRY_JOBS = ["osm", "weather", "slopes", "dust"];
const LAYER_FILES = ["travelRoads", "sharpCurves", "fastJunctions", "speedBumps", "schools", "camelCrossings", "wadiCrossings", "levelCrossings", "speedLimits", "roadExtras"];

const key = (cc, job) => `${cc}:${job}`;
function due(cc, job, now = Date.now()) {
  const k = key(cc, job);
  const f = state.fails[k];
  if (f && f.count >= 3 && now - Date.parse(f.last) < 7 * 86_400_000) return false; // resting
  const d = state.done[k];
  if (!d) return true;
  // 🔁 A job whose version went up in plan.json is done again (new layers in an old job).
  if ((state.ver?.[k] ?? 1) < (PLAN.jobVersion?.[job] ?? 1)) return true;
  return (now - Date.parse(d)) / 86_400_000 >= (PLAN.refreshDays[job] ?? Infinity);
}

// 🙏 Geofabrik is a free server: at most PLAN.maxOsm downloads at once, and
// never two countries that live in the same file (GCC States …) together.
const sharedGroup = (cc) => (PLAN.sharedFiles ?? []).findIndex((g) => g.includes(cc));
function osmAllowed(tasks, cc) {
  const osm = tasks.filter((t) => t.job === "osm");
  if (osm.length >= (PLAN.maxOsm ?? 2)) return false;
  const g = sharedGroup(cc);
  return g < 0 || !osm.some((t) => sharedGroup(t.cc) === g);
}

export function nextTasks(limit = PLAN.parallel ?? 6) {
  const tasks = [];
  if (due("WORLD", "dustgrid")) tasks.push({ cc: "WORLD", job: "dustgrid" });
  const gridBusy = tasks.length > 0;
  for (const cc of COUNTRIES) {
    if (tasks.length >= limit) break;
    if (due(cc, "osm")) { if (osmAllowed(tasks, cc)) tasks.push({ cc, job: "osm" }); continue; } // its other jobs need the roads first
    if (!state.done[key(cc, "osm")]) continue; // osm resting after failures
    for (const job of ["weather", "slopes", "dust"]) {
      if (tasks.length >= limit) break;
      if (job === "dust" && (gridBusy || !state.done[key("WORLD", "dustgrid")])) continue;
      if (due(cc, job)) tasks.push({ cc, job });
    }
  }
  return tasks;
}

function outputsOf(cc, job) {
  const d = `data/${cc.toLowerCase()}`;
  if (job === "osm") return LAYER_FILES.map((f) => `${d}/${f}.ts`);
  if (job === "weather") return [`${d}/weatherHistory.ts`, `${d}/weatherExtras.ts`, `cache/${cc.toLowerCase()}-weather.json`];
  if (job === "dust") return [`${d}/dustHistory.ts`, `${d}/dustLevels.ts`];
  if (job === "slopes") return [`${d}/steepSlopes.ts`];
  if (job === "dustgrid") return ["cache/dust-grid.npz"];
  return [];
}

function plan() {
  const tasks = nextTasks();
  console.log(`tasks=${JSON.stringify(tasks)}`);
  console.log(`any=${tasks.length > 0 ? "yes" : "no"}`);
  console.error(`🧠 ${tasks.length} task(s): ${tasks.map((t) => key(t.cc, t.job)).join(", ") || "none — everything is done and fresh"}`);
}

function work(cc, job) {
  const minutes = Number(process.env.WORK_MINUTES ?? 320);
  const env = { ...process.env, COUNTRY: cc, DEADLINE_MS: String(Date.now() + minutes * 60_000) };
  const cmd = job === "osm" ? ["node", ["scripts/roads.mjs"]]
    : job === "slopes" ? ["python3", ["scripts/slopes.py", cc]]
    : job === "dustgrid" ? ["python3", ["scripts/meteo.py", "dustgrid"]]
    : ["python3", ["scripts/meteo.py", job, cc]];
  const r = spawnSync(cmd[0], cmd[1], { env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 256 * 1024 * 1024 });
  process.stdout.write(r.stdout ?? "");
  const status = (r.stdout ?? "").match(/STATUS=(\w+)\s*$/)?.[1] ?? "FAILED";
  mkdirSync("out/status", { recursive: true });
  // Only this task's own files, so parallel tasks of one country never overwrite each other.
  const files = status === "DONE" ? outputsOf(cc, job)
    : status === "PARTIAL" ? outputsOf(cc, job).filter((f) => f.startsWith("cache/")) : [];
  for (const f of files) if (existsSync(f)) cpSync(f, `out/${f}`, { recursive: true });
  writeFileSync(`out/status/${cc}-${job}.json`, JSON.stringify({ cc, job, status }));
  console.log(`🏁 ${cc} ${job}: ${status}`);
}

function save() {
  const dir = "results";
  if (existsSync(`${dir}/data`)) cpSync(`${dir}/data`, "data", { recursive: true });
  if (existsSync(`${dir}/cache`)) cpSync(`${dir}/cache`, "cache", { recursive: true });
  const statuses = existsSync(`${dir}/status`)
    ? readdirSync(`${dir}/status`).map((f) => JSON.parse(readFileSync(`${dir}/status/${f}`, "utf8"))) : [];
  // A task with no status at all (its runner died) counts as a failure.
  const planned = JSON.parse(process.env.TASKS ?? "[]");
  for (const t of planned) if (!statuses.some((s) => s.cc === t.cc && s.job === t.job)) statuses.push({ ...t, status: "FAILED" });
  for (const s of statuses) {
    const k = key(s.cc, s.job);
    if (s.status === "DONE") {
      state.done[k] = today;
      delete state.fails[k];
      if ((PLAN.jobVersion?.[s.job] ?? 1) > 1) (state.ver ??= {})[k] = PLAN.jobVersion[s.job];
    }
    else if (s.status === "FAILED") state.fails[k] = { count: (state.fails[k]?.count ?? 0) + 1, last: today };
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  writeProgress(statuses);
  const more = nextTasks().length > 0;
  console.log(`more=${more ? "yes" : "no"}`);
  console.error(`💾 ${statuses.map((s) => `${key(s.cc, s.job)}=${s.status}`).join(", ")}`);
}

function writeProgress(last) {
  const NAMES = ["🇸🇦 السعودية", "🌴 الخليج", "🇪🇺 أوروبا", "🗣️ الدول الإنجليزية", "🌍 باقي العالم"];
  const lines = ["# 📊 تقدّم تحديث البيانات", "", `آخر تحديث: ${today}`, "", "| الحلقة | دول مكتملة | مهام مكتملة |", "|---|---|---|"];
  let doneAll = 0, total = 0;
  PLAN.rings.forEach((ring, i) => {
    const jobs = ring.flatMap((cc) => COUNTRY_JOBS.map((j) => key(cc, j)));
    const done = jobs.filter((k) => state.done[k]).length;
    const countries = ring.filter((cc) => COUNTRY_JOBS.every((j) => state.done[key(cc, j)])).length;
    doneAll += done; total += jobs.length;
    lines.push(`| ${NAMES[i] ?? `حلقة ${i + 1}`} | ${countries} / ${ring.length} | ${done} / ${jobs.length} |`);
  });
  lines.push("", `**المجموع: ${doneAll} / ${total} مهمة (${Math.round((100 * doneAll) / Math.max(1, total))}٪)**`, "",
    "## 🕐 آخر تشغيل", "", ...last.map((s) => `- ${s.status === "DONE" ? "✅" : s.status === "PARTIAL" ? "⏳" : "❌"} ${s.cc} · ${s.job}`), "");
  const resting = Object.entries(state.fails).filter(([, f]) => f.count >= 3);
  if (resting.length) lines.push("## 😴 مهام ترتاح أسبوع بعد ٣ محاولات", "", ...resting.map(([k]) => `- ${k}`), "");
  writeFileSync("progress.md", lines.join("\n"));
}

const [mode, a, b] = process.argv.slice(2);
if (mode === "plan") plan();
else if (mode === "work") work(a.toUpperCase(), b);
else if (mode === "save") save();
