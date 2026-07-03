// Rakip Hazırlık Raporu (Faz 5): tek JSON'da takım+harita istihbaratı.
// overview/economy canlı SQL; tendencies/setups/utility/players ml-jobs
// tablolarından. Her bölüm sample_size taşır; azsa insufficient=true (§10).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/google/uuid"
)

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
	ctx := r.Context()

	var teamName string
	if err := s.pg.QueryRow(ctx,
		"SELECT name FROM teams WHERE team_id = $1", teamID).Scan(&teamName); err != nil {
		writeErr(w, 404, fmt.Errorf("team not found"))
		return
	}

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
		    WHERE m.map_name = $2 AND (r.t_team_id = $1 OR r.ct_team_id = $1)
		      AND r.winner_side IS NOT NULL
		)
		SELECT count(DISTINCT match_id),
		       count(*) FILTER (WHERE side='T'),
		       count(*) FILTER (WHERE side='T' AND won),
		       count(*) FILTER (WHERE side='CT'),
		       count(*) FILTER (WHERE side='CT' AND won),
		       count(*) FILTER (WHERE round_number IN (1,13)),
		       count(*) FILTER (WHERE round_number IN (1,13) AND won)
		FROM tr`, teamID, mapName).Scan(
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
		    WHERE m.map_name = $2 AND (r.t_team_id = $1 OR r.ct_team_id = $1)
		      AND r.winner_side IS NOT NULL
		)
		SELECT count(*) FILTER (WHERE n.won),
		       count(*)
		FROM tr p JOIN tr n ON n.match_id = p.match_id AND n.round_number = p.round_number + 1
		WHERE p.round_number IN (1,13) AND p.won`, teamID, mapName).Scan(&convWon, &convBase)
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
		    WHERE m.map_name = $2 AND (r.t_team_id = $1 OR r.ct_team_id = $1)
		    GROUP BY r.match_id
		)
		SELECT count(*) FILTER (WHERE w > n - w) FROM per`, teamID, mapName).Scan(&ov.Wins)
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
			WHERE m.map_name = $2 AND r.`+team+` = $1 AND r.round_number NOT IN (1,13)
			GROUP BY 1`, teamID, mapName)
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
		    WHERE m.map_name = $2 AND (r.t_team_id = $1 OR r.ct_team_id = $1)
		)
		SELECT COALESCE(n.buy,'unknown'), count(*)
		FROM tr p JOIN tr n ON n.match_id = p.match_id AND n.round_number = p.round_number + 1
		WHERE p.round_number IN (1,13) AND NOT p.won
		GROUP BY 1`, teamID, mapName)
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
	out["tendencies"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x), '[]'::json) FROM (
		    SELECT tt.side, tt.cluster_id, sc.label, sc.top_places,
		           tt.observed, tt.sample_size, tt.shrunk_prob AS prob
		    FROM team_tendencies tt
		    LEFT JOIN strategy_clusters sc ON (sc.map_name, sc.side, sc.cluster_id)
		         = (tt.map_name, tt.side, tt.cluster_id)
		    WHERE tt.team_id = $1 AND tt.map_name = $2
		    ORDER BY tt.side, tt.shrunk_prob DESC
		) x`, teamID, mapName)
	out["conditional"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x), '[]'::json) FROM (
		    SELECT DISTINCT ON (tc.side, tc.buy_type)
		           tc.side, tc.buy_type, tc.cluster_id, sc.label, sc.top_places,
		           tc.prob, tc.sample_size
		    FROM team_tendencies_cond tc
		    LEFT JOIN strategy_clusters sc ON (sc.map_name, sc.side, sc.cluster_id)
		         = (tc.map_name, tc.side, tc.cluster_id)
		    WHERE tc.team_id = $1 AND tc.map_name = $2
		    ORDER BY tc.side, tc.buy_type, tc.prob DESC
		) x`, teamID, mapName)

	// ---- setups / utility / players (ml-jobs tabloları) ----
	out["setups"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x), '[]'::json) FROM (
		    SELECT side, t_offset, pattern_id, pattern, observed, sample_size,
		           share, avg_hold_sec, representatives
		    FROM team_setups WHERE team_id = $1 AND map_name = $2
		    ORDER BY side, t_offset, share DESC
		) x`, teamID, mapName)
	out["utility"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x), '[]'::json) FROM (
		    SELECT side, type, cluster_id, label, det_rx, det_ry, throw_rx, throw_ry,
		           count, share, t_avg, t_std, strat_mix, representatives
		    FROM utility_spots WHERE team_id = $1 AND map_name = $2
		    ORDER BY side, type, count DESC
		) x`, teamID, mapName)
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
