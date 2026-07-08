#!/usr/bin/env bash
# Replay/stack smoke testleri + heatmap p95 ölçümü.
# Kullanım: scripts/test-dsl.sh   (stats-svc :8090'da çalışıyor olmalı)
set -euo pipefail

BASE="${STATS_URL:-http://localhost:8090}"

python3 - "$BASE" <<'EOF'
import json, sys, time, urllib.request

base = sys.argv[1]
fails = 0

def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

# Replay + stack smoke testleri (Faz 3 revize)
matches = json.load(urllib.request.urlopen(base + "/api/v1/matches"))
mirage = next(m for m in matches if m.get("map_name") == "de_mirage" and m["status"] == "ready")
mid = mirage["match_id"]

detail = json.load(urllib.request.urlopen(f"{base}/api/v1/matches/{mid}"))
ok = len(detail["rounds"]) == mirage["rounds"] and len(detail["kills"]) > 0
print(f"{'PASS' if ok else 'FAIL'} replay: maç detayı ({len(detail['rounds'])} raunt, {len(detail['kills'])} kill)")
fails += 0 if ok else 1

rn = detail["rounds"][2]["round_number"]
ticks = json.load(urllib.request.urlopen(f"{base}/api/v1/rounds/{mid}/{rn}/ticks"))
rx = [v for p in ticks["players"] for v in p["rx"] if v is not None]
ok = (len(ticks["players"]) == 10 and len(ticks["ticks"]) > 100
      and all(0 <= v <= 1024 for v in rx)
      and all(ticks["ticks"][0] <= k["tick"] <= ticks["ticks"][-1] for k in ticks["kills"]))
print(f"{'PASS' if ok else 'FAIL'} replay: raunt tick verisi (kareler={len(ticks['ticks'])}, radar sınırları, kill aralığı)")
fails += 0 if ok else 1

planted = [r["round_number"] for r in detail["rounds"] if r["bomb_plant_tick"]][:5]
st = post(base + "/api/v1/stack",
          {"rounds": [{"match_id": mid, "round_number": n} for n in planted], "align": "bomb_plant"})
layers = [l for l in st["layers"] if not l.get("skipped")]
ok = len(layers) == len(planted) and all(
    min(t for p in l["players"] for t in p["t"]) <= 0 <= max(t for p in l["players"] for t in p["t"])
    for l in layers)
print(f"{'PASS' if ok else 'FAIL'} stack: {len(layers)} katman bomb_plant hizalı, t=0 kapsanıyor")
fails += 0 if ok else 1

# Heatmap p95 (§4.4 hedefi: < 300 ms) — 20 istek, farklı filtre kombinasyonları
lat = []
combos = [("de_mirage","T","full"), ("de_mirage","CT",""), ("de_dust2","T","eco,semi"),
          ("de_nuke","CT","full"), ("de_overpass","T","")]
for i in range(20):
    m, s, b = combos[i % len(combos)]
    url = f"{base}/api/v1/heatmap?map={m}&side={s}" + (f"&buy_type={b}" if b else "")
    t = time.time()
    with urllib.request.urlopen(url, timeout=30) as r:
        json.load(r)
    lat.append((time.time() - t) * 1000)
lat.sort()
p95 = lat[int(len(lat) * 0.95) - 1]
print(f"\nheatmap latency: min {lat[0]:.0f} ms, median {lat[len(lat)//2]:.0f} ms, p95 {p95:.0f} ms "
      + ("(under the 300 ms target ✓)" if p95 < 300
         else "(over the 300 ms target — informational; scales with archive size and hardware)"))
# Latency is a performance target, not a correctness invariant, and it grows
# with archive size + hardware — so it is reported but does not fail the suite.

print(f"\n{'TÜM TESTLER GEÇTİ ✅' if fails == 0 else f'{fails} TEST BAŞARISIZ ❌'}")
sys.exit(1 if fails else 0)
EOF
