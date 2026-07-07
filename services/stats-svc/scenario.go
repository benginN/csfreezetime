// Senaryo Laboratuvarı: "full buy'da, A'da kaybettikleri raundun ERTESİNDE
// ne oynuyorlar?" tarzı koşullu sorgular (kullanıcı isteği — Moments'ın
// takım-analizi kardeşi). Filtrelere uyan tarihi rauntların strateji
// dağılımı, takımın kendi taban çizgisine göre kaldıraçla (lift) döner;
// örnek rauntlar replay'e link olur. Ham sayım + kıyas — her satır n taşır.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/google/uuid"
)

// GET /api/v1/scenario?team_id=&map=&side=&buy=&prev=won|lost&prev_site=A|B|none&rclass=
func (s *server) scenario(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	teamID, err := uuid.Parse(q.Get("team_id"))
	if err != nil {
		writeErr(w, 400, fmt.Errorf("invalid team_id"))
		return
	}
	mapName, side := q.Get("map"), q.Get("side")
	if mapName == "" || (side != "T" && side != "CT") {
		writeErr(w, 400, fmt.Errorf("map and side (T|CT) are required"))
		return
	}
	ctx := r.Context()

	// tr: takımın bu haritadaki her raundu, takım perspektifinden — LAG ile
	// önceki raundun sonucu/site'ı (yarı değişiminden bağımsız: takım her
	// raunt oynar, maç içi sıralama yeter)
	base := `
	WITH tr AS (
	    SELECT r.match_id, r.round_number, m.played_at,
	           x.side, x.cluster_id, x.buy,
	           (r.winner_side = x.side) AS won,
	           lag(r.winner_side = x.side) OVER w AS prev_won,
	           lag(r.bomb_site) OVER w AS prev_site,
	           CASE WHEN r.round_number IN (1,13) THEN 'pistol'
	                WHEN r.round_number IN (2,14) THEN 'after pistol'
	                WHEN r.round_number IN (3,15) THEN '3rd round'
	                WHEN r.round_number >= 25 THEN 'overtime'
	                ELSE 'mid-game' END AS rclass
	    FROM rounds r
	    JOIN matches m ON m.match_id = r.match_id AND m.status = 'ready'
	    CROSS JOIN LATERAL (VALUES
	        ('T',  r.t_team_id,  r.t_strategy_cluster,  r.t_buy_type),
	        ('CT', r.ct_team_id, r.ct_strategy_cluster, r.ct_buy_type)
	    ) AS x(side, team_id, cluster_id, buy)
	    WHERE m.map_name = $2 AND x.team_id = $1
	      AND r.winner_side IS NOT NULL AND x.cluster_id IS NOT NULL
	    WINDOW w AS (PARTITION BY r.match_id ORDER BY r.round_number)
	)`
	args := []any{teamID, mapName, side}
	cond := "side = $3"
	if b := q.Get("buy"); b != "" {
		args = append(args, b)
		cond += fmt.Sprintf(" AND buy = $%d", len(args))
	}
	switch q.Get("prev") {
	case "won":
		cond += " AND prev_won = true"
	case "lost":
		cond += " AND prev_won = false"
	}
	switch ps := q.Get("prev_site"); ps {
	case "A", "B":
		args = append(args, ps)
		cond += fmt.Sprintf(" AND prev_site = $%d", len(args))
	case "none":
		cond += " AND prev_site IS NULL AND prev_won IS NOT NULL"
	}
	if rc := q.Get("rclass"); rc != "" {
		args = append(args, rc)
		cond += fmt.Sprintf(" AND rclass = $%d", len(args))
	}

	// dağılım + taban çizgi (aynı taraf, koşulsuz) tek sorguda
	type row struct {
		ClusterID int16           `json:"cluster_id"`
		Label     *string         `json:"label"`
		TopPlaces json.RawMessage `json:"top_places"`
		N         int             `json:"n"`
		Share     float64         `json:"share"`
		BaseShare float64         `json:"base_share"`
		Lift      float64         `json:"lift"`
	}
	rows, err := s.pg.Query(ctx, base+`
	, sel AS (SELECT cluster_id FROM tr WHERE `+cond+`),
	  allr AS (SELECT cluster_id FROM tr WHERE side = $3)
	SELECT a.cluster_id, sc.label, sc.top_places,
	       COALESCE(s2.n, 0) AS n,
	       COALESCE(s2.n, 0)::real / GREATEST((SELECT count(*) FROM sel), 1) AS share,
	       a.n::real / GREATEST((SELECT count(*) FROM allr), 1) AS base_share
	FROM (SELECT cluster_id, count(*) AS n FROM allr GROUP BY cluster_id) a
	LEFT JOIN (SELECT cluster_id, count(*) AS n FROM sel GROUP BY cluster_id) s2 USING (cluster_id)
	JOIN strategy_clusters sc ON (sc.map_name, sc.side, sc.cluster_id) = ($2, $3, a.cluster_id)
	ORDER BY COALESCE(s2.n, 0) DESC, a.n DESC`, args...)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer rows.Close()
	out := []row{}
	for rows.Next() {
		var x row
		var tp []byte
		if rows.Scan(&x.ClusterID, &x.Label, &tp, &x.N, &x.Share, &x.BaseShare) != nil {
			continue
		}
		x.TopPlaces = json.RawMessage(tp)
		if x.BaseShare > 0.01 {
			x.Lift = x.Share / x.BaseShare
		}
		out = append(out, x)
	}

	// eşleşen raunt sayısı + en yeni örnekler
	var n int
	_ = s.pg.QueryRow(ctx, base+` SELECT count(*) FROM tr WHERE `+cond, args...).Scan(&n)
	type rep struct {
		MatchID string `json:"match_id"`
		Round   int16  `json:"round_number"`
	}
	reps := []rep{}
	if rrows, err := s.pg.Query(ctx, base+`
		SELECT match_id::text, round_number FROM tr WHERE `+cond+`
		ORDER BY played_at DESC NULLS LAST, round_number DESC LIMIT 8`, args...); err == nil {
		for rrows.Next() {
			var x rep
			if rrows.Scan(&x.MatchID, &x.Round) == nil {
				reps = append(reps, x)
			}
		}
		rrows.Close()
	}

	writeJSON(w, 200, map[string]any{"n": n, "rows": out, "reps": reps})
}
