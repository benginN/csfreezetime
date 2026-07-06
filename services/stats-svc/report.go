// Rakip Hazırlık Raporu (Faz 5): tek JSON'da takım+harita istihbaratı.
// overview/economy canlı SQL; tendencies/setups/utility/players ml-jobs
// tablolarından. Her bölüm sample_size taşır; azsa insufficient=true (§10).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// eligibleMatches: pencere (since) + kadro filtresi (rosterMin: takımın SON
// maçındaki beşliden en az N kişinin sahada olduğu maçlar). Filtre yoksa nil
// döner (SQL tarafında NULL → süzme kapalı). Koç bilgisi demolarda olmadığı
// için "koç dönemi" filtresi yoktur; kadro çekirdeği bunun pratik vekilidir.
func (s *server) eligibleMatches(ctx context.Context, teamID uuid.UUID, since string, rosterMin int) []string {
	if since == "" && rosterMin <= 0 {
		return nil
	}
	rows, err := s.pg.Query(ctx, `
		WITH lm AS (
		    SELECT r.match_id
		    FROM rounds r JOIN matches m ON m.match_id = r.match_id AND m.status = 'ready'
		    WHERE r.t_team_id = $1 OR r.ct_team_id = $1
		    GROUP BY r.match_id
		    ORDER BY max(m.played_at) DESC NULLS LAST LIMIT 1
		),
		roster AS (
		    SELECT DISTINCT s.player_id
		    FROM player_round_states s
		    JOIN rounds r ON (r.match_id, r.round_number) = (s.match_id, s.round_number)
		    WHERE s.match_id = (SELECT match_id FROM lm)
		      AND ((s.side = 'T' AND r.t_team_id = $1) OR (s.side = 'CT' AND r.ct_team_id = $1))
		)
		SELECT m.match_id
		FROM matches m
		WHERE m.status = 'ready'
		  AND ($2 = '' OR m.played_at >= $2::timestamptz)
		  AND EXISTS (SELECT 1 FROM rounds r WHERE r.match_id = m.match_id
		              AND (r.t_team_id = $1 OR r.ct_team_id = $1))
		  AND ($3 <= 0 OR (
		      SELECT count(DISTINCT s.player_id)
		      FROM player_round_states s
		      JOIN rounds r2 ON (r2.match_id, r2.round_number) = (s.match_id, s.round_number)
		      WHERE s.match_id = m.match_id
		        AND s.player_id IN (SELECT player_id FROM roster)
		        AND ((s.side = 'T' AND r2.t_team_id = $1) OR (s.side = 'CT' AND r2.ct_team_id = $1))
		  ) >= $3)`, teamID, since, rosterMin)
	if err != nil {
		return []string{}
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id uuid.UUID
		if rows.Scan(&id) == nil {
			out = append(out, id.String())
		}
	}
	return out
}

// GET /api/v1/report?team_id=&map=
func (s *server) report(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	teamID, err := uuid.Parse(q.Get("team_id"))
	if err != nil {
		writeErr(w, 400, fmt.Errorf("invalid team_id"))
		return
	}
	mapName := q.Get("map")
	if mapName == "" {
		writeErr(w, 400, fmt.Errorf("map is required"))
		return
	}
	since := q.Get("since") // ISO tarih; boşsa tüm arşiv
	rosterMin, _ := strconv.Atoi(q.Get("roster_min"))
	ctx := r.Context()

	var teamName string
	if err := s.pg.QueryRow(ctx,
		"SELECT name FROM teams WHERE team_id = $1", teamID).Scan(&teamName); err != nil {
		writeErr(w, 404, fmt.Errorf("team not found"))
		return
	}

	elig := s.eligibleMatches(ctx, teamID, since, rosterMin)

	out := map[string]any{"team_id": teamID, "team": teamName, "map": mapName}

	// ---- overview: maçlar, taraf bazlı raunt kazanma, pistol + dönüşüm ----
	type overview struct {
		Matches     int     `json:"matches"`
		Wins        int     `json:"wins"`
		TRounds     int     `json:"t_rounds"`
		TWins       int     `json:"t_wins"`
		CTRounds    int     `json:"ct_rounds"`
		CTWins      int     `json:"ct_wins"`
		PistolN     int     `json:"pistol_rounds"`
		PistolWins  int     `json:"pistol_wins"`
		ConvAfterWN int     `json:"conv_after_pistol_win_n"`
		ConvAfterW  float64 `json:"conv_after_pistol_win"`
	}
	var ov overview
	// taraf bazlı raunt istatistikleri
	err = s.pg.QueryRow(ctx, `
		WITH tr AS (
		    SELECT r.round_number, r.match_id,
		           CASE WHEN r.t_team_id = $1 THEN 'T' ELSE 'CT' END AS side,
		           (r.winner_side = 'T') = (r.t_team_id = $1) AS won
		    FROM rounds r JOIN matches m ON m.match_id = r.match_id AND m.status = 'ready'
		    WHERE m.map_name = $2 AND ($3::text[] IS NULL OR m.match_id::text = ANY($3::text[])) AND (r.t_team_id = $1 OR r.ct_team_id = $1)
		      AND r.winner_side IS NOT NULL
		)
		SELECT count(DISTINCT match_id),
		       count(*) FILTER (WHERE side='T'),
		       count(*) FILTER (WHERE side='T' AND won),
		       count(*) FILTER (WHERE side='CT'),
		       count(*) FILTER (WHERE side='CT' AND won),
		       count(*) FILTER (WHERE round_number IN (1,13)),
		       count(*) FILTER (WHERE round_number IN (1,13) AND won)
		FROM tr`, teamID, mapName, elig).Scan(
		&ov.Matches, &ov.TRounds, &ov.TWins, &ov.CTRounds, &ov.CTWins,
		&ov.PistolN, &ov.PistolWins)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	// pistol kazanıldığında 2./14. rauntu da alma oranı
	var convWon, convBase int
	_ = s.pg.QueryRow(ctx, `
		WITH tr AS (
		    SELECT r.match_id, r.round_number,
		           (r.winner_side = 'T') = (r.t_team_id = $1) AS won
		    FROM rounds r JOIN matches m ON m.match_id = r.match_id AND m.status = 'ready'
		    WHERE m.map_name = $2 AND ($3::text[] IS NULL OR m.match_id::text = ANY($3::text[])) AND (r.t_team_id = $1 OR r.ct_team_id = $1)
		      AND r.winner_side IS NOT NULL
		)
		SELECT count(*) FILTER (WHERE n.won),
		       count(*)
		FROM tr p JOIN tr n ON n.match_id = p.match_id AND n.round_number = p.round_number + 1
		WHERE p.round_number IN (1,13) AND p.won`, teamID, mapName, elig).Scan(&convWon, &convBase)
	ov.ConvAfterWN = convBase
	if convBase > 0 {
		ov.ConvAfterW = float64(convWon) / float64(convBase)
	}
	// maç galibiyetleri: raunt çoğunluğu
	_ = s.pg.QueryRow(ctx, `
		WITH per AS (
		    SELECT r.match_id,
		           count(*) FILTER (WHERE (r.winner_side='T') = (r.t_team_id=$1)) AS w,
		           count(*) FILTER (WHERE r.winner_side IS NOT NULL) AS n
		    FROM rounds r JOIN matches m ON m.match_id = r.match_id AND m.status='ready'
		    WHERE m.map_name = $2 AND ($3::text[] IS NULL OR m.match_id::text = ANY($3::text[])) AND (r.t_team_id = $1 OR r.ct_team_id = $1)
		    GROUP BY r.match_id
		)
		SELECT count(*) FILTER (WHERE w > n - w) FROM per`, teamID, mapName, elig).Scan(&ov.Wins)
	out["overview"] = ov
	if ov.TRounds+ov.CTRounds < 16 {
		out["insufficient"] = true
	}

	// ---- economy: buy dağılımı + pistol kaybı sonrası tepki ----
	type buyRow struct {
		Side string         `json:"side"`
		Dist map[string]int `json:"dist"`
	}
	econ := map[string]any{}
	for _, side := range []string{"T", "CT"} {
		col, team := "t_buy_type", "t_team_id"
		if side == "CT" {
			col, team = "ct_buy_type", "ct_team_id"
		}
		rows, err := s.pg.Query(ctx, `
			SELECT COALESCE(`+col+`, 'unknown'), count(*)
			FROM rounds r JOIN matches m ON m.match_id = r.match_id AND m.status='ready'
			WHERE m.map_name = $2 AND ($3::text[] IS NULL OR m.match_id::text = ANY($3::text[])) AND r.`+team+` = $1 AND r.round_number NOT IN (1,13)
			GROUP BY 1`, teamID, mapName, elig)
		if err != nil {
			writeErr(w, 500, err)
			return
		}
		br := buyRow{Side: side, Dist: map[string]int{}}
		for rows.Next() {
			var b string
			var n int
			if rows.Scan(&b, &n) == nil {
				br.Dist[b] = n
			}
		}
		rows.Close()
		econ["buy_"+side] = br.Dist
	}
	// pistol kaybı sonrası 2./14. raunt buy dağılımı
	lossBuy := map[string]int{}
	rows, err := s.pg.Query(ctx, `
		WITH tr AS (
		    SELECT r.match_id, r.round_number,
		           CASE WHEN r.t_team_id = $1 THEN r.t_buy_type ELSE r.ct_buy_type END AS buy,
		           (r.winner_side = 'T') = (r.t_team_id = $1) AS won
		    FROM rounds r JOIN matches m ON m.match_id = r.match_id AND m.status='ready'
		    WHERE m.map_name = $2 AND ($3::text[] IS NULL OR m.match_id::text = ANY($3::text[])) AND (r.t_team_id = $1 OR r.ct_team_id = $1)
		)
		SELECT COALESCE(n.buy,'unknown'), count(*)
		FROM tr p JOIN tr n ON n.match_id = p.match_id AND n.round_number = p.round_number + 1
		WHERE p.round_number IN (1,13) AND NOT p.won
		GROUP BY 1`, teamID, mapName, elig)
	if err == nil {
		for rows.Next() {
			var b string
			var n int
			if rows.Scan(&b, &n) == nil {
				lossBuy[b] = n
			}
		}
		rows.Close()
	}
	econ["after_pistol_loss"] = lossBuy
	out["economy"] = econ

	// ---- tendencies + buy-koşullu tahmin tablosu ----
	// Eğilimler pencere içinde CANLI hesaplanır (küme atamaları rounds'ta):
	// prob = (gözlem + k·lig_payı)/(n + k), k=20 — ml-jobs formülünün SQL eşleniği.
	out["tendencies"] = s.jsonQuery(ctx, `
		WITH mine AS (
		    SELECT CASE WHEN r.t_team_id = $1 THEN 'T' ELSE 'CT' END AS side,
		           CASE WHEN r.t_team_id = $1 THEN r.t_strategy_cluster
		                ELSE r.ct_strategy_cluster END AS cid
		    FROM rounds r JOIN matches m ON m.match_id = r.match_id AND m.status='ready'
		    WHERE m.map_name = $2 AND (r.t_team_id = $1 OR r.ct_team_id = $1)
		      AND ($3::text[] IS NULL OR m.match_id::text = ANY($3::text[]))
		),
		mine2 AS (SELECT side, cid FROM mine WHERE cid IS NOT NULL),
		tot AS (SELECT side, count(*) AS n FROM mine2 GROUP BY side),
		glob AS (
		    SELECT y.side, y.cid,
		           count(*)::float / sum(count(*)) OVER (PARTITION BY y.side) AS gshare
		    FROM (
		        SELECT 'T' AS side, r.t_strategy_cluster AS cid
		        FROM rounds r JOIN matches m ON m.match_id = r.match_id AND m.status='ready'
		        WHERE m.map_name = $2 AND r.t_strategy_cluster IS NOT NULL
		          AND ($4 = '' OR m.played_at >= $4::timestamptz)
		        UNION ALL
		        SELECT 'CT', r.ct_strategy_cluster
		        FROM rounds r JOIN matches m ON m.match_id = r.match_id AND m.status='ready'
		        WHERE m.map_name = $2 AND r.ct_strategy_cluster IS NOT NULL
		          AND ($4 = '' OR m.played_at >= $4::timestamptz)
		    ) y GROUP BY y.side, y.cid
		)
		SELECT COALESCE(json_agg(x), '[]'::json) FROM (
		    SELECT g.side, g.cid AS cluster_id, sc.label, sc.top_places,
		           COALESCE(c.cnt, 0) AS observed, t.n AS sample_size,
		           (COALESCE(c.cnt, 0) + 20*g.gshare) / (t.n + 20) AS prob
		    FROM glob g
		    JOIN tot t ON t.side = g.side
		    LEFT JOIN (SELECT side, cid, count(*) AS cnt FROM mine2 GROUP BY side, cid) c
		           ON (c.side, c.cid) = (g.side, g.cid)
		    LEFT JOIN strategy_clusters sc ON (sc.map_name, sc.side, sc.cluster_id)
		         = ($2, g.side, g.cid)
		    ORDER BY g.side, 7 DESC
		) x`, teamID, mapName, elig, since)
	out["conditional"] = s.jsonQuery(ctx, `
		WITH mine AS (
		    SELECT CASE WHEN r.t_team_id = $1 THEN 'T' ELSE 'CT' END AS side,
		           CASE WHEN r.t_team_id = $1 THEN r.t_strategy_cluster
		                ELSE r.ct_strategy_cluster END AS cid,
		           CASE WHEN r.t_team_id = $1 THEN r.t_buy_type
		                ELSE r.ct_buy_type END AS buy
		    FROM rounds r JOIN matches m ON m.match_id = r.match_id AND m.status='ready'
		    WHERE m.map_name = $2 AND (r.t_team_id = $1 OR r.ct_team_id = $1)
		      AND ($3::text[] IS NULL OR m.match_id::text = ANY($3::text[]))
		),
		mine2 AS (SELECT side, cid, buy FROM mine
		          WHERE cid IS NOT NULL AND buy IS NOT NULL),
		tot AS (SELECT side, buy, count(*) AS n FROM mine2 GROUP BY side, buy),
		glob AS (
		    SELECT y.side, y.cid,
		           count(*)::float / sum(count(*)) OVER (PARTITION BY y.side) AS gshare
		    FROM (
		        SELECT 'T' AS side, r.t_strategy_cluster AS cid
		        FROM rounds r JOIN matches m ON m.match_id = r.match_id AND m.status='ready'
		        WHERE m.map_name = $2 AND r.t_strategy_cluster IS NOT NULL
		          AND ($4 = '' OR m.played_at >= $4::timestamptz)
		        UNION ALL
		        SELECT 'CT', r.ct_strategy_cluster
		        FROM rounds r JOIN matches m ON m.match_id = r.match_id AND m.status='ready'
		        WHERE m.map_name = $2 AND r.ct_strategy_cluster IS NOT NULL
		          AND ($4 = '' OR m.played_at >= $4::timestamptz)
		    ) y GROUP BY y.side, y.cid
		)
		SELECT COALESCE(json_agg(x), '[]'::json) FROM (
		    SELECT DISTINCT ON (g.side, t.buy)
		           g.side, t.buy AS buy_type, g.cid AS cluster_id,
		           sc.label, sc.top_places,
		           (COALESCE(c.cnt, 0) + 10*g.gshare) / (t.n + 10) AS prob,
		           t.n AS sample_size
		    FROM glob g
		    JOIN tot t ON t.side = g.side
		    LEFT JOIN (SELECT side, buy, cid, count(*) AS cnt
		               FROM mine2 GROUP BY side, buy, cid) c
		           ON (c.side, c.buy, c.cid) = (g.side, t.buy, g.cid)
		    LEFT JOIN strategy_clusters sc ON (sc.map_name, sc.side, sc.cluster_id)
		         = ($2, g.side, g.cid)
		    ORDER BY g.side, t.buy, 6 DESC
		) x`, teamID, mapName, elig, since)

	// ---- setups / utility / players (ml-jobs tabloları) ----
	out["setups"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x), '[]'::json) FROM (
		    SELECT side, t_offset, pattern_id, pattern, observed, sample_size,
		           share, avg_hold_sec, representatives
		    FROM team_setups WHERE team_id = $1 AND map_name = $2
		    ORDER BY side, t_offset, share DESC
		) x`, teamID, mapName)
	// Flash→kill senkronu: kör kurbana atılan kill payı + flash-kill arası
	// medyan süre + "iyi flash dönüşümü" (düşman körleyen flash'ın 4 sn içinde
	// takım kill'ine dönüşme oranı)
	out["flash_sync"] = s.jsonQuery(ctx, `
		WITH tk AS (
		    SELECT k.match_id, k.round_number, k.tick, k.victim_blind, s.side
		    FROM kills k
		    JOIN rounds r USING (match_id, round_number)
		    JOIN matches m ON m.match_id = k.match_id AND m.status = 'ready'
		    JOIN player_round_states s ON (s.match_id, s.round_number, s.player_id)
		         = (k.match_id, k.round_number, k.attacker_id)
		    WHERE m.map_name = $2 AND ($3::text[] IS NULL OR m.match_id::text = ANY($3::text[]))
		      AND ((s.side = 'T' AND r.t_team_id = $1) OR (s.side = 'CT' AND r.ct_team_id = $1))
		),
		gaps AS (
		    SELECT tk.side, g.gap
		    FROM tk
		    CROSS JOIN LATERAL (
		        SELECT (tk.tick - g.detonate_tick) / 64.0 AS gap
		        FROM grenades g
		        WHERE g.match_id = tk.match_id AND g.round_number = tk.round_number
		          AND g.type = 'flash' AND g.side = tk.side
		          AND g.detonate_tick <= tk.tick AND tk.tick - g.detonate_tick <= 256
		        ORDER BY g.detonate_tick DESC LIMIT 1
		    ) g
		    WHERE tk.victim_blind
		),
		fl AS (
		    SELECT g.side,
		           count(*) FILTER (WHERE g.enemies_flashed > 0) AS good,
		           count(*) FILTER (WHERE g.enemies_flashed > 0 AND EXISTS (
		               SELECT 1 FROM tk WHERE tk.match_id = g.match_id
		                 AND tk.round_number = g.round_number AND tk.side = g.side
		                 AND tk.tick > g.detonate_tick
		                 AND tk.tick - g.detonate_tick <= 256)) AS converted
		    FROM grenades g
		    JOIN rounds r USING (match_id, round_number)
		    JOIN matches m ON m.match_id = g.match_id AND m.status = 'ready'
		    WHERE m.map_name = $2 AND ($3::text[] IS NULL OR m.match_id::text = ANY($3::text[])) AND g.type = 'flash'
		      AND ((g.side = 'T' AND r.t_team_id = $1) OR (g.side = 'CT' AND r.ct_team_id = $1))
		    GROUP BY g.side
		)
		SELECT COALESCE(json_agg(x), '[]'::json) FROM (
		    SELECT t.side,
		           count(*) AS kills,
		           count(*) FILTER (WHERE t.victim_blind) AS blind_kills,
		           (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)
		            FROM gaps WHERE gaps.side = t.side) AS med_gap,
		           (SELECT good FROM fl WHERE fl.side = t.side) AS good_flashes,
		           (SELECT converted FROM fl WHERE fl.side = t.side) AS converted
		    FROM tk t GROUP BY t.side ORDER BY t.side DESC
		) x`, teamID, mapName, elig)

	// Utility hasarı: HE ve ateş bombalarının bomba başına ortalama hasarı
	// (PRS toplamları ÷ atış sayıları; pencere/kadro filtresine uyar)
	out["util_dmg"] = s.jsonQuery(ctx, `
		WITH dmg AS (
		    SELECT s.side, sum(s.util_he_dmg) AS he_dmg, sum(s.util_fire_dmg) AS fire_dmg
		    FROM player_round_states s
		    JOIN rounds r USING (match_id, round_number)
		    JOIN matches m ON m.match_id = s.match_id AND m.status = 'ready'
		    WHERE m.map_name = $2 AND ($3::text[] IS NULL OR m.match_id::text = ANY($3::text[]))
		      AND ((s.side = 'T' AND r.t_team_id = $1) OR (s.side = 'CT' AND r.ct_team_id = $1))
		    GROUP BY s.side
		),
		nades AS (
		    SELECT g.side,
		           count(*) FILTER (WHERE g.type = 'he') AS he_n,
		           count(*) FILTER (WHERE g.type = 'molotov') AS fire_n
		    FROM grenades g
		    JOIN rounds r USING (match_id, round_number)
		    JOIN matches m ON m.match_id = g.match_id AND m.status = 'ready'
		    WHERE m.map_name = $2 AND ($3::text[] IS NULL OR m.match_id::text = ANY($3::text[]))
		      AND ((g.side = 'T' AND r.t_team_id = $1) OR (g.side = 'CT' AND r.ct_team_id = $1))
		    GROUP BY g.side
		)
		SELECT COALESCE(json_agg(x), '[]'::json) FROM (
		    SELECT d.side, d.he_dmg, d.fire_dmg, n.he_n, n.fire_n
		    FROM dmg d JOIN nades n USING (side) ORDER BY d.side DESC
		) x`, teamID, mapName, elig)

	// Execute şablonları (ml/templates.py; arşiv geneli)
	out["exec_templates"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY x.recency_score DESC), '[]'::json) FROM (
		    SELECT pattern, n, wins, site_mix, recency_score
		    FROM team_exec_templates
		    WHERE team_id = $1 AND map_name = $2
		    ORDER BY recency_score DESC LIMIT 8
		) x`, teamID, mapName)

	// Trade ikilileri: kim kimin ölümünü trade ediyor (5 sn penceresi)
	out["trade_pairs"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY x.n DESC), '[]'::json) FROM (
		    SELECT pt.nickname AS trader, pv.nickname AS avenged, count(*) AS n
		    FROM kills k2
		    JOIN matches m ON m.match_id = k2.match_id AND m.status = 'ready'
		    JOIN rounds r ON (r.match_id, r.round_number) = (k2.match_id, k2.round_number)
		    JOIN player_round_states s2 ON (s2.match_id, s2.round_number, s2.player_id)
		         = (k2.match_id, k2.round_number, k2.attacker_id)
		    CROSS JOIN LATERAL (
		        SELECT k1.victim_id FROM kills k1
		        WHERE k1.match_id = k2.match_id AND k1.round_number = k2.round_number
		          AND k1.attacker_id = k2.victim_id
		          AND k1.tick <= k2.tick AND k2.tick - k1.tick <= 320
		        ORDER BY k1.tick DESC LIMIT 1
		    ) prev
		    JOIN players pt ON pt.player_id = k2.attacker_id
		    JOIN players pv ON pv.player_id = prev.victim_id
		    WHERE k2.is_trade AND m.map_name = $2 AND ($3::text[] IS NULL OR m.match_id::text = ANY($3::text[]))
		      AND ((s2.side = 'T' AND r.t_team_id = $1) OR (s2.side = 'CT' AND r.ct_team_id = $1))
		    GROUP BY pt.nickname, pv.nickname
		    HAVING count(*) >= 2
		    LIMIT 10
		) x`, teamID, mapName, elig)

	out["rotations"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x), '[]'::json) FROM (
		    SELECT side, pattern_id, place, n_contacts, rotate_rate,
		           med_delay_sec, dest_mix
		    FROM setup_rotations WHERE team_id = $1 AND map_name = $2
		    ORDER BY side, pattern_id, rotate_rate DESC
		) x`, teamID, mapName)
	out["utility"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x), '[]'::json) FROM (
		    SELECT side, type, cluster_id, label, det_rx, det_ry, throw_rx, throw_ry,
		           count, share, t_avg, t_std, strat_mix, representatives
		    FROM utility_spots WHERE team_id = $1 AND map_name = $2
		    ORDER BY side, type, share DESC
		) x`, teamID, mapName)
	// Atılan rauntlar: takımın zirvede ≥%75 olasılığa ulaşıp kaybettiği
	// rauntlar (throw tespiti; her satır replay'e link olur)
	out["thrown"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY x.peak DESC), '[]'::json) FROM (
		    SELECT r.match_id, r.round_number,
		           CASE WHEN r.t_team_id = $1 THEN 'T' ELSE 'CT' END AS side,
		           CASE WHEN r.t_team_id = $1 THEN w.max_t_prob ELSE w.max_ct_prob END AS peak
		    FROM round_winprob w
		    JOIN rounds r USING (match_id, round_number)
		    JOIN matches m ON m.match_id = r.match_id AND m.status = 'ready'
		    WHERE m.map_name = $2 AND ($3::text[] IS NULL OR m.match_id::text = ANY($3::text[])) AND (r.t_team_id = $1 OR r.ct_team_id = $1)
		      AND ((r.winner_side = 'T') <> (r.t_team_id = $1))
		      AND (CASE WHEN r.t_team_id = $1 THEN w.max_t_prob ELSE w.max_ct_prob END) >= 0.75
		    LIMIT 15
		) x`, teamID, mapName, elig)

	out["players"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x), '[]'::json) FROM (
		    SELECT p.nickname, pr.player_id, pr.side, pr.rounds,
		           pr.entry_attempt_share, pr.entry_success,
		           pr.opening_kills, pr.opening_deaths, pr.lurk_dist_avg,
		           pr.anchor_place, pr.anchor_share, pr.awp_round_share,
		           pr.util_per_round, pr.flash_assists_pr, pr.adr, pr.tags
		    FROM player_roles pr JOIN players p ON p.player_id = pr.player_id
		    WHERE pr.team_id = $1
		    ORDER BY p.nickname, pr.side
		) x`, teamID)

	if since != "" || rosterMin > 0 {
		out["window_since"] = since
		out["roster_min"] = rosterMin
		out["archive_wide"] = []string{"setups", "utility", "rotations", "players", "exec_templates"}
	}
	writeJSON(w, 200, out)
}

// GET /api/v1/teams/{id}/summary — takım anasayfası verisi:
// tüm haritalar genel görünümü + harita bazlı karne.
func (s *server) teamSummary(w http.ResponseWriter, r *http.Request) {
	teamID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 400, fmt.Errorf("invalid team_id"))
		return
	}
	ctx := r.Context()
	since := r.URL.Query().Get("since")
	rosterMin, _ := strconv.Atoi(r.URL.Query().Get("roster_min"))
	elig := s.eligibleMatches(ctx, teamID, since, rosterMin)
	var teamName string
	if err := s.pg.QueryRow(ctx,
		"SELECT name FROM teams WHERE team_id = $1", teamID).Scan(&teamName); err != nil {
		writeErr(w, 404, fmt.Errorf("team not found"))
		return
	}

	out := map[string]any{"team_id": teamID, "team": teamName}
	var matches, wins, tR, tW, ctR, ctW, pisN, pisW int
	err = s.pg.QueryRow(ctx, `
		WITH tr AS (
		    SELECT r.match_id, r.round_number,
		           CASE WHEN r.t_team_id = $1 THEN 'T' ELSE 'CT' END AS side,
		           (r.winner_side = 'T') = (r.t_team_id = $1) AS won
		    FROM rounds r JOIN matches m ON m.match_id = r.match_id AND m.status = 'ready'
		    WHERE (r.t_team_id = $1 OR r.ct_team_id = $1) AND r.winner_side IS NOT NULL AND ($2::text[] IS NULL OR m.match_id::text = ANY($2::text[]))
		),
		per AS (
		    SELECT match_id, count(*) FILTER (WHERE won) AS w, count(*) AS n
		    FROM tr GROUP BY match_id
		)
		SELECT (SELECT count(*) FROM per),
		       (SELECT count(*) FILTER (WHERE w > n - w) FROM per),
		       count(*) FILTER (WHERE side='T'),
		       count(*) FILTER (WHERE side='T' AND won),
		       count(*) FILTER (WHERE side='CT'),
		       count(*) FILTER (WHERE side='CT' AND won),
		       count(*) FILTER (WHERE round_number IN (1,13)),
		       count(*) FILTER (WHERE round_number IN (1,13) AND won)
		FROM tr`, teamID, elig).Scan(&matches, &wins, &tR, &tW, &ctR, &ctW, &pisN, &pisW)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	out["overview"] = map[string]int{
		"matches": matches, "wins": wins,
		"t_rounds": tR, "t_wins": tW, "ct_rounds": ctR, "ct_wins": ctW,
		"pistol_rounds": pisN, "pistol_wins": pisW,
	}
	out["maps"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY x.matches DESC), '[]'::json) FROM (
		    SELECT m.map_name,
		           count(DISTINCT r.match_id) AS matches,
		           count(DISTINCT r.match_id) FILTER (WHERE mw.won) AS wins,
		           count(*) FILTER (WHERE (r.winner_side='T') = (r.t_team_id=$1)) AS round_wins,
		           count(*) AS rounds
		    FROM rounds r
		    JOIN matches m ON m.match_id = r.match_id AND m.status = 'ready'
		    LEFT JOIN LATERAL (
		        SELECT count(*) FILTER (WHERE (r2.winner_side='T') = (r2.t_team_id=$1))
		               > count(*) / 2.0 AS won
		        FROM rounds r2 WHERE r2.match_id = r.match_id AND r2.winner_side IS NOT NULL
		    ) mw ON TRUE
		    WHERE (r.t_team_id = $1 OR r.ct_team_id = $1) AND r.winner_side IS NOT NULL AND ($2::text[] IS NULL OR m.match_id::text = ANY($2::text[]))
		    GROUP BY m.map_name
		) x`, teamID, elig)
	writeJSON(w, 200, out)
}

// jsonQuery: PG'nin json_agg çıktısını olduğu gibi geçirir (çifte çözme yok).
func (s *server) jsonQuery(ctx context.Context, q string, args ...any) json.RawMessage {
	var raw []byte
	if err := s.pg.QueryRow(ctx, q, args...).Scan(&raw); err != nil {
		return json.RawMessage("[]")
	}
	return json.RawMessage(raw)
}
