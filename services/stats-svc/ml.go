// Faz 4 çıktılarının servisi: takım eğilimleri ve anomali bayrakları.
// Hesaplar ml-jobs'ta (services/ml) yapılır; burada yalnızca okunur.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// GET /api/v1/teams/{id}/tendencies — harita+taraf başına küme olasılıkları
func (s *server) teamTendencies(w http.ResponseWriter, r *http.Request) {
	teamID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 400, fmt.Errorf("geçersiz team_id"))
		return
	}
	rows, err := s.pg.Query(r.Context(), `
		SELECT tt.map_name, tt.side, tt.cluster_id, sc.label,
		       sc.top_places, tt.observed, tt.sample_size, tt.shrunk_prob
		FROM team_tendencies tt
		LEFT JOIN strategy_clusters sc
		       ON sc.map_name = tt.map_name AND sc.side = tt.side
		      AND sc.cluster_id = tt.cluster_id
		WHERE tt.team_id = $1
		ORDER BY tt.map_name, tt.side, tt.shrunk_prob DESC`, teamID)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer rows.Close()
	type row struct {
		MapName    string          `json:"map_name"`
		Side       string          `json:"side"`
		ClusterID  int16           `json:"cluster_id"`
		Label      *string         `json:"label"`
		TopPlaces  json.RawMessage `json:"top_places"`
		Observed   int             `json:"observed"`
		SampleSize int             `json:"sample_size"`
		Prob       float32         `json:"prob"`
	}
	var out []row
	for rows.Next() {
		var x row
		var tp *[]byte
		if err := rows.Scan(&x.MapName, &x.Side, &x.ClusterID, &x.Label,
			&tp, &x.Observed, &x.SampleSize, &x.Prob); err != nil {
			writeErr(w, 500, err)
			return
		}
		if tp != nil {
			x.TopPlaces = json.RawMessage(*tp)
		} else {
			x.TopPlaces = json.RawMessage("[]")
		}
		out = append(out, x)
	}
	writeJSON(w, 200, out)
}

// GET /api/v1/players/{id}/flags — anomali bayrakları (kanıt: maç + metrik + z)
func (s *server) playerFlags(w http.ResponseWriter, r *http.Request) {
	playerID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 400, fmt.Errorf("geçersiz player_id"))
		return
	}
	rows, err := s.pg.Query(r.Context(), `
		SELECT a.match_id, m.event_name, a.metric, a.value,
		       a.baseline_mean, a.baseline_std, a.z
		FROM anomaly_flags a
		JOIN matches m ON m.match_id = a.match_id
		WHERE a.player_id = $1
		ORDER BY abs(a.z) DESC`, playerID)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer rows.Close()
	type flag struct {
		MatchID      uuid.UUID `json:"match_id"`
		MatchName    *string   `json:"match_name"`
		Metric       string    `json:"metric"`
		Value        float32   `json:"value"`
		BaselineMean float32   `json:"baseline_mean"`
		BaselineStd  float32   `json:"baseline_std"`
		Z            float32   `json:"z"`
	}
	var out []flag
	for rows.Next() {
		var f flag
		if err := rows.Scan(&f.MatchID, &f.MatchName, &f.Metric, &f.Value,
			&f.BaselineMean, &f.BaselineStd, &f.Z); err != nil {
			writeErr(w, 500, err)
			return
		}
		out = append(out, f)
	}
	writeJSON(w, 200, out)
}
