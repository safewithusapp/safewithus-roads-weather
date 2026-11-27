#!/usr/bin/env python3
"""🌫️💧🌪️ Fog, humidity and dust history — straight from Open-Meteo's open data.

Open-Meteo publishes its whole weather database on AWS Open Data
(s3://openmeteo, CC-BY 4.0, no key, no daily limit). Instead of asking the
API cell by cell (10 000 calls a day), this script reads the stored files.

  weather <CC>   ecmwf_ifs (9 km, hourly): visibility, temperature, dew point
                 → data/<cc>/weatherHistory.ts  [lat, lon, fogHours, humidHours, hours]
  dustgrid       cams_global (0.4°, hourly): dust µg/m³ for the WHOLE world, once
                 → cache/dust-grid.npz
  dust <CC>      from that grid → data/<cc>/dustHistory.ts  [lat, lon, dustyHours, hours]

Same rules as the private repo's fetch-weather-history.mjs: a year of data,
fog = visibility < 1 km, humid = relative humidity ≥ 90 %, dusty = ≥ 150 µg/m³,
weather cells 0.5° and dust cells 1° along the country's travel roads.

⏯️ Resumable: weather keeps finished three-week chunks in cache/<cc>-weather.json.
⏰ DEADLINE_MS (env, Unix ms): no new chunk after it.
Prints STATUS=DONE / STATUS=PARTIAL / STATUS=FAILED on its last line.
"""

import json
import math
import os
import re
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

BUCKET = "openmeteo"
FOG_M = 1_000
HUMID_PCT = 90
DUSTY_UG = 150
THREADS = int(os.environ.get("THREADS", "24"))
DEADLINE = float(os.environ.get("DEADLINE_MS") or "inf") / 1000
os.makedirs("cache", exist_ok=True)


def log(*a):
    print(*a, flush=True)


def finish(status):
    log(f"STATUS={status}")
    sys.exit(0 if status != "FAILED" else 1)


# ── Reading .om files (python-omfiles) ───────────────────────────────────────
_fs = None


def fs():
    global _fs
    if _fs is None:
        import fsspec
        _fs = fsspec.filesystem("s3", anon=True, default_block_size=1 << 16)
    return _fs


def om_reader(path, local=False):
    """Open an .om file — a local path, or a key in the open bucket (read by byte ranges)."""
    import omfiles
    Reader = getattr(omfiles, "OmFileReader", None) or getattr(omfiles, "OmFilePyReader")
    tries = []
    if local:
        tries = [lambda: Reader(path), lambda: Reader.from_path(path)]
    else:
        uri = f"s3://{BUCKET}/{path}"
        tries = [
            lambda: Reader.from_fsspec(fs(), uri),
            lambda: Reader(fs().open(uri, "rb", block_size=1 << 16, cache_type="readahead")),
        ]
    err = None
    for make in tries:
        try:
            return make()
        except Exception as e:  # noqa: BLE001 — try the next way of opening
            err = e
    raise RuntimeError(f"cannot open {path}: {err}")


def read_all(reader):
    return np.asarray(reader[tuple(slice(0, s) for s in reader.shape)])


def chunks_of(model, var):
    names = fs().ls(f"{BUCKET}/data/{model}/{var}/", detail=False)
    return sorted(int(m.group(1)) for n in names if (m := re.search(r"chunk_(\d+)\.om$", n)))


def meta(model):
    with fs().open(f"{BUCKET}/data/{model}/static/meta.json") as f:
        return json.load(f)


def window():
    """A year, ending two days ago (the data lags a little) — in hours since 1970."""
    end_h = int(time.time() // 3600) - 48
    return end_h - 365 * 24, end_h


def day(h):
    return time.strftime("%Y-%m-%d", time.gmtime(h * 3600))


# ── Grids ────────────────────────────────────────────────────────────────────
# Places whose height we know roughly — the grid check reads the model's own
# surface-height file and keeps the layout that puts these places at the
# right height. A wrong layout would put Abha at sea level.
REFERENCE = [
    (24.71, 46.68, 612), (18.22, 42.50, 2270), (21.54, 39.17, 15), (21.27, 40.42, 1800),
    (39.74, -104.99, 1610), (19.43, -99.13, 2240), (-16.50, -68.15, 3640), (29.65, 91.10, 3650),
    (52.37, 4.90, 0), (-0.18, -78.47, 2850), (-1.29, 36.82, 1700), (9.03, 38.74, 2350),
    (46.80, 9.84, 1800), (-33.87, 151.21, 30), (35.68, 139.69, 40), (64.15, -21.94, 30),
]


class Reduced:
    """ECMWF O1280 reduced Gaussian grid (what Open-Meteo stores ecmwf_ifs on)."""

    N = 1280

    def __init__(self, north_first, lon0):
        n = self.N
        x, _ = np.polynomial.legendre.leggauss(2 * n)
        lats = np.degrees(np.arcsin(x))  # south → north
        counts = np.array([20 + 4 * i for i in range(n)] + [20 + 4 * i for i in reversed(range(n))])
        self.lats = lats[::-1] if north_first else lats
        self.counts = counts  # symmetric, so the same either way
        self.start = np.concatenate([[0], np.cumsum(counts)[:-1]])
        self.lon0 = lon0
        self.total = int(counts.sum())

    def index(self, lat, lon):
        row = int(np.argmin(np.abs(self.lats - lat)))
        n = int(self.counts[row])
        j = int(round(((lon - self.lon0) % 360) / (360 / n))) % n
        return int(self.start[row] + j)


class Regular:
    def __init__(self, ny, nx, south_first, lon0):
        self.ny, self.nx, self.south_first, self.lon0 = ny, nx, south_first, lon0
        self.dlat = 180 / (ny - 1)
        self.dlon = 360 / nx
        self.total = ny * nx

    def rowcol(self, lat, lon):
        r = int(round((lat + 90) / self.dlat))
        if not self.south_first:
            r = self.ny - 1 - r
        c = int(round(((lon - self.lon0) % 360) / self.dlon)) % self.nx
        return min(max(r, 0), self.ny - 1), c

    def index(self, lat, lon):
        r, c = self.rowcol(lat, lon)
        return r * self.nx + c


def pick_layout(heights, candidates):
    """The candidate grid whose heights best match REFERENCE."""
    best, best_err = None, float("inf")
    for g in candidates:
        if g.total != heights.size:
            continue
        err = float(np.mean([abs(heights[g.index(la, lo)] - h) for la, lo, h in REFERENCE]))
        log(f"   grid check {type(g).__name__} {vars_of(g)}: mean height error {err:.0f} m")
        if err < best_err:
            best, best_err = g, err
    if best is None or best_err > 300:
        raise RuntimeError(f"no grid layout matches the model's heights (best error {best_err:.0f} m)")
    return best


def vars_of(g):
    return {k: v for k, v in vars(g).items() if k in ("north_first", "south_first", "lon0")} or {"lon0": g.lon0}


def ifs_grid():
    tmp = os.path.join(tempfile.mkdtemp(), "HSURF.om")
    fs().get(f"{BUCKET}/data/ecmwf_ifs/static/HSURF.om", tmp)
    heights = read_all(om_reader(tmp, local=True)).astype(float).reshape(-1)
    log(f"ecmwf_ifs surface heights: {heights.size} points")
    cands = []
    for nf in (True, False):
        for lon0 in (0.0, -180.0):
            g = Reduced(nf, lon0)
            g.north_first = nf
            cands.append(g)
    return pick_layout(heights, cands)


# ── Road cells (same as the app server expects) ────────────────────────────────────────
def road_points(cc):
    path = f"data/{cc.lower()}/travelRoads.ts"
    if not os.path.exists(path):
        log(f"::error::{path} missing — the roads job for {cc} runs first.")
        finish("FAILED")
    text = open(path, encoding="utf8").read()
    return [(float(a), float(b)) for a, b in re.findall(r"\[(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\]", text)]


def js_round2(x):
    return math.floor(x * 100 + 0.5) / 100


def cells(points, deg):
    acc = {}
    for lat, lon in points:
        k = f"{math.floor(lat / deg)}:{math.floor(lon / deg)}"
        a = acc.setdefault(k, [0.0, 0.0, 0])
        a[0] += lat
        a[1] += lon
        a[2] += 1
    return {k: (js_round2(a[0] / a[2]), js_round2(a[1] / a[2])) for k, a in acc.items()}


def where(cc):
    return "Saudi" if cc == "SA" else cc


def write_ts(cc, file, header, const_line, rows):
    os.makedirs(f"data/{cc.lower()}", exist_ok=True)
    body = "\n".join(f"  [{', '.join(fmt(v) for v in r)}]," for r in rows)
    with open(f"data/{cc.lower()}/{file}", "w", encoding="utf8") as f:
        f.write(f"{header}\n//\n// {len(rows)} cells.\n\n{const_line}\n{body}\n];\n".replace("\n\n];", "\n];"))


def fmt(v):
    return str(int(v)) if float(v).is_integer() and abs(v) >= 1 or v == 0 else repr(round(float(v), 4))


# ── weather <CC> ─────────────────────────────────────────────────────────────
WEATHER_VARS = ("visibility", "temperature_2m", "dew_point_2m")
# Everything else that makes a road dangerous — read when the bucket has it for that chunk.
EXTRA_VARS = ("precipitation", "wind_gusts_10m", "snowfall_water_equivalent", "lightning_density")
HEAVY_RAIN_MM = 7.6  # mm in an hour — "heavy rain"
GUST_KMH = 62  # Beaufort 8 (gale) — hard to hold a car or a lorry straight
HEAT_C = 45  # tyres, engines and drivers suffer
# acc columns per cell: fog, humid, hours | rain, gust, heat, frost, ice, snow, storm
N_ACC = 10


def weather(cc):
    centres = cells(road_points(cc), 0.5)
    if not centres:
        log(f"No travel roads in {cc} — nothing to learn.")
        write_weather(cc, [], "-", "-")
        finish("DONE")
    keys = sorted(centres)
    cache_file = f"cache/{cc.lower()}-weather.json"
    cache = json.load(open(cache_file)) if os.path.exists(cache_file) else None
    start_h, end_h = window()
    if (not cache or cache.get("keys") != keys or cache.get("cols") != N_ACC or end_h - cache["end_h"] > 300 * 24):
        cache = {"start_h": start_h, "end_h": end_h, "keys": keys, "cols": N_ACC, "done": [], "acc": [[0] * N_ACC for _ in keys]}
    start_h, end_h = cache["start_h"], cache["end_h"]

    m = meta("ecmwf_ifs")
    L = int(m["chunk_time_length"])
    have = set.intersection(*(set(chunks_of("ecmwf_ifs", v)) for v in WEATHER_VARS))
    extra_have = {v: set(chunks_of("ecmwf_ifs", v)) for v in EXTRA_VARS}
    need = [c for c in range(start_h // L, (end_h - 1) // L + 1) if c in have and c not in cache["done"]]
    log(f"{cc} weather: {len(keys)} cells, {len(cache['done'])} chunks done, {len(need)} to read")

    grid = ifs_grid()
    idx = [grid.index(*centres[k]) for k in keys]
    order = np.argsort(idx)  # neighbours together — kinder to the byte-range cache

    def read_points(var, chunk, sel):
        r = om_reader(f"data/ecmwf_ifs/{var}/chunk_{chunk}.om")
        space = r.shape[:-1]
        nt = r.shape[-1]
        out = np.full((len(sel), nt), np.nan, dtype=np.float32)
        for row, p in enumerate(sel):
            pos = np.unravel_index(idx[p], space)
            sl = tuple(slice(int(q), int(q) + 1) for q in pos) + (slice(0, nt),)
            out[row] = np.asarray(r[sl], dtype=np.float32).reshape(-1)
        return out

    batch = max(1, math.ceil(len(keys) / 8))
    groups = [order[i:i + batch] for i in range(0, len(order), batch)]
    with ThreadPoolExecutor(THREADS) as pool:
        for chunk in need:
            if time.time() + 15 * 60 > DEADLINE:
                log("⏰ time is up for this run — the next run carries on.")
                break
            t0 = time.time()
            vars_now = list(WEATHER_VARS) + [v for v in EXTRA_VARS if chunk in extra_have[v]]
            jobs = {(v, g): pool.submit(read_points, v, chunk, list(groups[g])) for v in vars_now for g in range(len(groups))}
            data = {}
            for v in vars_now:
                try:
                    data[v] = np.concatenate([jobs[(v, g)].result() for g in range(len(groups))])
                except Exception as e:  # noqa: BLE001 — an extra variable may fail; the core three may not
                    if v in WEATHER_VARS:
                        raise
                    log(f"   ⚠️ {v} chunk {chunk}: {e} — counted as no data")
            sel = np.concatenate(groups)
            c0 = chunk * L
            a, b = max(0, start_h - c0), min(data["visibility"].shape[1], end_h - c0)
            cut = {v: d[:, a:b] for v, d in data.items()}
            nan = np.full_like(cut["visibility"], np.nan)
            vis, t, td = cut["visibility"], cut["temperature_2m"], cut["dew_point_2m"]
            pr = cut.get("precipitation", nan)
            gust = cut.get("wind_gusts_10m", nan)
            snow = cut.get("snowfall_water_equivalent", nan)
            light = cut.get("lightning_density", nan)
            with np.errstate(invalid="ignore", over="ignore"):
                if np.nanmedian(gust) < 18:  # stored in m/s, not km/h
                    gust = gust * 3.6
                rh = 100 * np.exp(17.625 * td / (243.04 + td)) / np.exp(17.625 * t / (243.04 + t))
                cols = [
                    np.sum(vis < FOG_M, axis=1),
                    np.sum(rh >= HUMID_PCT, axis=1),
                    np.sum(~(np.isnan(vis) & np.isnan(t) & np.isnan(td)), axis=1),
                    np.sum(pr >= HEAVY_RAIN_MM, axis=1),
                    np.sum(gust >= GUST_KMH, axis=1),
                    np.sum(t >= HEAT_C, axis=1),
                    np.sum(t <= 0, axis=1),
                    np.sum((t <= 1) & (pr > 0.1), axis=1),
                    np.sum(snow > 0.1, axis=1),
                    np.sum(light > 0, axis=1),
                ]
            for row, p in enumerate(sel):
                acc = cache["acc"][int(p)]
                for j, col in enumerate(cols):
                    acc[j] += int(col[row])
            cache["done"].append(chunk)
            json.dump(cache, open(cache_file, "w"))
            log(f"   chunk {chunk} ✓ {len(vars_now)} variables ({time.time() - t0:.0f} s)")

    if any(c not in cache["done"] for c in range(start_h // L, (end_h - 1) // L + 1) if c in have):
        finish("PARTIAL")
    order_keys = sorted(range(len(keys)), key=lambda i: centres[keys[i]])
    rows = [[*centres[keys[i]], *cache["acc"][i][:3]] for i in order_keys]
    extras = [[*centres[keys[i]], *cache["acc"][i][3:], cache["acc"][i][2]] for i in order_keys]
    expected = (end_h - start_h) * 0.5
    if sum(1 for r in rows if r[4] >= expected) < len(rows) * 0.5:
        log("::error::Most cells came back with less than half a year of hours — not writing; starting over next run.")
        os.remove(cache_file)
        finish("FAILED")
    write_weather(cc, rows, day(start_h), day(end_h), extras)
    log(f"✅ weather history for {cc}: {len(rows)} cells")
    finish("DONE")


def write_weather(cc, rows, start, end, extras=()):
    source = f"// GENERATED by safewithus-map-data/scripts/meteo.py — do not edit by hand.\n// Weather data by Open-Meteo.com (ECMWF IFS, CC-BY 4.0), {start} → {end}."
    write_ts(
        cc, "weatherHistory.ts",
        f"""// 🌫️💧 A year of weather history along {where(cc)} travel roads, per ~55 km cell.
// [latitude, longitude, fogHours (visibility < 1 km), humidHours (≥ 90 %), hoursWithData]
//
{source}
// Model data, not station readings: an estimate of where fog and humidity recur.""",
        "export const WEATHER_CELL_DEG = 0.5;\n\nexport const WEATHER_HISTORY: ReadonlyArray<readonly [number, number, number, number, number]> = [",
        rows,
    )
    write_ts(
        cc, "weatherExtras.ts",
        f"""// ⛈️💨🌡️❄️ More of the same year along {where(cc)} travel roads, per ~55 km cell — hours of:
// [latitude, longitude, heavyRain (≥ {HEAVY_RAIN_MM} mm/h), gusts (≥ {GUST_KMH} km/h), heat (≥ {HEAT_C} °C),
//  frost (≤ 0 °C), iceRisk (≤ 1 °C while it rains/snows), snow, lightning, hoursWithData]
//
{source}
// Model data, not station readings: an estimate of where these recur.""",
        "export const WEATHER_EXTRAS: ReadonlyArray<readonly [number, number, number, number, number, number, number, number, number, number]> = [",
        list(extras),
    )


# ── dustgrid — the whole world once ──────────────────────────────────────────
def dustgrid():
    m = meta("cams_global")
    L = int(m["chunk_time_length"])
    start_h, end_h = window()
    have = set(chunks_of("cams_global", "dust"))
    need = [c for c in range(start_h // L, (end_h - 1) // L + 1) if c in have]
    log(f"dust grid: {len(need)} chunks of {L} h")
    tmpdir = tempfile.mkdtemp()

    def one(chunk):
        p = os.path.join(tmpdir, f"{chunk}.om")
        fs().get(f"{BUCKET}/data/cams_global/dust/chunk_{chunk}.om", p)
        v = read_all(om_reader(p, local=True)).astype(np.float32)
        os.remove(p)
        c0 = chunk * L
        a, b = max(0, start_h - c0), min(v.shape[-1], end_h - c0)
        v = v[..., a:b]
        with np.errstate(invalid="ignore"):
            return (v >= DUSTY_UG).sum(axis=-1).astype(np.int32), (~np.isnan(v)).sum(axis=-1).astype(np.int32)

    dusty = hours = None
    with ThreadPoolExecutor(4) as pool:
        for d, h in pool.map(one, need):
            dusty = d if dusty is None else dusty + d
            hours = h if hours is None else hours + h
    dusty, hours = dusty.reshape(dusty.shape[-2:]), hours.reshape(hours.shape[-2:])
    ny, nx = dusty.shape
    # Which way up? The Sahara must be dustier than Scotland.
    frac = lambda g, la, lo: dusty.reshape(-1)[g.index(la, lo)] / max(1, hours.reshape(-1)[g.index(la, lo)])  # noqa: E731
    best = None
    for south_first in (True, False):
        for lon0 in (-180.0, 0.0):
            g = Regular(ny, nx, south_first, lon0)
            score = frac(g, 23, 10) + frac(g, 20, 45) - frac(g, 56, -4) - frac(g, -40, -70)
            log(f"   dust grid check south_first={south_first} lon0={lon0}: {score:.3f}")
            if best is None or score > best[0]:
                best = (score, south_first, lon0)
    if best[0] <= 0.02:
        log("::error::the dust grid does not look like the Earth (no Sahara) — not saved")
        finish("FAILED")
    np.savez_compressed("cache/dust-grid.npz", dusty=dusty.astype(np.int32), hours=hours.astype(np.int32),
                        south_first=best[1], lon0=best[2], start=day(start_h), end=day(end_h))
    log(f"✅ world dust grid {ny}×{nx}, {day(start_h)} → {day(end_h)}")
    finish("DONE")


# ── dust <CC> — from the world grid ──────────────────────────────────────────
def dust(cc):
    if not os.path.exists("cache/dust-grid.npz"):
        log("::error::cache/dust-grid.npz missing — the dustgrid job runs first.")
        finish("FAILED")
    z = np.load("cache/dust-grid.npz")
    dusty, hours = z["dusty"], z["hours"]
    g = Regular(dusty.shape[0], dusty.shape[1], bool(z["south_first"]), float(z["lon0"]))
    centres = cells(road_points(cc), 1)
    rows = []
    for k, (la, lo) in sorted(centres.items(), key=lambda kv: kv[1]):
        r, c = g.rowcol(la, lo)
        if hours[r, c] > 0:
            rows.append([la, lo, int(dusty[r, c]), int(hours[r, c])])
    write_ts(
        cc, "dustHistory.ts",
        f"""// 🌪️ A year of dust history along {where(cc)} travel roads, per ~110 km cell.
// [latitude, longitude, dustyHours (≥ {DUSTY_UG} µg/m³), hoursWithData]
//
// GENERATED by safewithus-map-data/scripts/meteo.py — do not edit by hand.
// Air-quality data by Open-Meteo.com (CAMS, CC-BY 4.0), {z["start"]} → {z["end"]}.
// Model data, not station readings: an estimate of where dust recurs.""",
        "export const DUST_CELL_DEG = 1;\n\nexport const DUST_HISTORY: ReadonlyArray<readonly [number, number, number, number]> = [",
        sorted(rows),
    )
    log(f"✅ dust history for {cc}: {len(rows)} cells")
    finish("DONE")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if cmd == "weather":
            weather(sys.argv[2].upper())
        elif cmd == "dustgrid":
            dustgrid()
        elif cmd == "dust":
            dust(sys.argv[2].upper())
        else:
            print(__doc__)
            sys.exit(2)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        log(f"::error::{type(e).__name__}: {e}")
        finish("FAILED")
