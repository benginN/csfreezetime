#!/usr/bin/env bash
# Faz 4 doğrulaması: ml-jobs çıktılarının tutarlılığı.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
set -a; source "$ROOT/infra/.env"; set +a

PSQL="docker compose -f $ROOT/infra/docker-compose.yml exec -T postgres psql -tA -U $POSTGRES_USER -d $POSTGRES_DB -c"

FAILS=0
check() {  # check <ad> <sorgu> <beklenen>
    local got; got=$($PSQL "$2")
    if [ "$got" = "$3" ]; then echo "PASS $1 ($got)"
    else echo "FAIL $1: beklenen $3, gelen $got"; FAILS=$((FAILS+1)); fi
}

# 1. Kümeleme kapsamı: ready maçlardaki her harita için T ve CT kümeleri var
check "küme kapsamı (harita×taraf çifti)" \
  "SELECT count(DISTINCT (map_name, side)) FROM strategy_clusters" \
  "$($PSQL "SELECT count(DISTINCT map_name)*2 FROM matches WHERE status='ready' AND map_name IS NOT NULL")"

# 2. Raunt küme ataması: T kümesi atanmış raunt oranı ≥ %90
RATIO=$($PSQL "SELECT round(100.0*count(*) FILTER (WHERE t_strategy_cluster IS NOT NULL)/count(*)) FROM rounds r JOIN matches m ON m.match_id=r.match_id WHERE m.status='ready'")
if [ "$RATIO" -ge 90 ]; then echo "PASS raunt küme ataması (%$RATIO)"
else echo "FAIL raunt küme ataması: %$RATIO < 90"; FAILS=$((FAILS+1)); fi

# 3. Eğilim olasılıkları (takım,harita,taraf) başına 1'e toplanır
check "eğilim olasılık toplamı=1 (sapan grup sayısı)" \
  "SELECT count(*) FROM (SELECT team_id,map_name,side FROM team_tendencies GROUP BY 1,2,3 HAVING abs(sum(shrunk_prob)-1) > 0.001) x" \
  "0"

# 4. Anomali bayrakları eşiğin üstünde
check "anomali |z| > eşik (ihlal sayısı)" \
  "SELECT count(*) FROM anomaly_flags WHERE abs(z) <= 1.5" \
  "0"

# 5. Küme özet boyutları raunt atamalarıyla tutarlı (T tarafı)
check "küme boyutları tutarlı (sapan küme)" \
  "SELECT count(*) FROM strategy_clusters sc
   WHERE sc.size <> (SELECT count(*) FROM rounds r JOIN matches m ON m.match_id=r.match_id
                     WHERE m.map_name=sc.map_name AND m.status='ready'
                       AND ((sc.side='T' AND r.t_strategy_cluster=sc.cluster_id)
                         OR (sc.side='CT' AND r.ct_strategy_cluster=sc.cluster_id)))" \
  "0"

# 6. Koşullu eğilim olasılıkları grup başına 1'e toplanır
check "koşullu olasılık toplamı=1 (sapan grup)" \
  "SELECT count(*) FROM (SELECT team_id,map_name,side,buy_type FROM team_tendencies_cond GROUP BY 1,2,3,4 HAVING abs(sum(prob)-1) > 0.001) x" \
  "0"

# 7. prediction_meta tüm kümelenmiş çiftleri kapsıyor ve kazanan tutarlı
check "tahmin meta kapsamı" \
  "SELECT count(*) FROM prediction_meta" \
  "$($PSQL "SELECT count(DISTINCT (map_name, side)) FROM strategy_clusters")"
check "kazanan yöntem log-loss'u gerçekten en düşük (ihlal)" \
  "SELECT count(*) FROM prediction_meta
   WHERE (best_method='league'   AND (logloss_league > logloss_team OR logloss_league > logloss_team_buy))
      OR (best_method='team'     AND (logloss_team > logloss_league OR logloss_team > logloss_team_buy))
      OR (best_method='team_buy' AND (logloss_team_buy > logloss_league OR logloss_team_buy > logloss_team))" \
  "0"

# 8. Utility kümeleri: pay toplamı ≤1, min sayı, etiket dolu
check "utility pay toplamı ≤1 (ihlal)" \
  "SELECT count(*) FROM (SELECT team_id,map_name,side,type FROM utility_spots GROUP BY 1,2,3,4 HAVING sum(share) > 1.001) x" "0"
check "utility min küme boyutu (ihlal)" \
  "SELECT count(*) FROM utility_spots WHERE count < 3" "0"
check "utility etiketsiz küme" \
  "SELECT count(*) FROM utility_spots WHERE label IS NULL" "0"

# 9. Kurulum desenleri: pay ≤1, örneklem kapısı, desen 4-5 oyunculu
check "setup pay toplamı ≤1 (ihlal)" \
  "SELECT count(*) FROM (SELECT team_id,map_name,side,t_offset FROM team_setups GROUP BY 1,2,3,4 HAVING sum(share) > 1.001) x" "0"
check "setup örneklem kapısı (<8 raunt yazılmış)" \
  "SELECT count(*) FROM team_setups WHERE sample_size < 8" "0"
check "setup desen boyutu 4-5 (ihlal)" \
  "SELECT count(*) FROM team_setups ts WHERE (SELECT sum((e->>'n')::int) FROM jsonb_array_elements(pattern) e) NOT BETWEEN 4 AND 5" "0"

# 10. Roller: eşik altında etiket yok, paylar 0-1 aralığında
check "rol etiketi kanıt eşiği (ihlal)" \
  "SELECT count(*) FROM player_roles WHERE cardinality(tags) > 0 AND rounds < 30" "0"
check "rol pay aralığı (ihlal)" \
  "SELECT count(*) FROM player_roles WHERE entry_attempt_share NOT BETWEEN 0 AND 1 OR awp_round_share NOT BETWEEN 0 AND 1 OR anchor_share NOT BETWEEN 0 AND 1" "0"

echo
[ $FAILS -eq 0 ] && echo "ML TESTLERİ GEÇTİ ✅" || { echo "$FAILS TEST BAŞARISIZ ❌"; exit 1; }
