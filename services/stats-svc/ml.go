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
		writeErr(w, 400, fmt.Errorf("invalid team_id"))
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

// GET /api/v1/clusters?map=&side= — isimlendirme sayfası verisi
func (s *server) clusters(w http.ResponseWriter, r *http.Request) {
	mapName, side := r.URL.Query().Get("map"), r.URL.Query().Get("side")
	if mapName == "" || (side != "T" && side != "CT") {
		writeErr(w, 400, fmt.Errorf("map and side (T|CT) are required"))
		return
	}
	rows, err := s.pg.Query(r.Context(), `
		SELECT cluster_id, label, size, top_places, representatives
		FROM strategy_clusters WHERE map_name = $1 AND side = $2
		ORDER BY size DESC`, mapName, side)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer rows.Close()
	type cluster struct {
		ClusterID       int16           `json:"cluster_id"`
		Label           *string         `json:"label"`
		Size            int             `json:"size"`
		TopPlaces       json.RawMessage `json:"top_places"`
		Representatives json.RawMessage `json:"representatives"`
	}
	var out []cluster
	for rows.Next() {
		var c cluster
		var tp, rp []byte
		if err := rows.Scan(&c.ClusterID, &c.Label, &c.Size, &tp, &rp); err != nil {
			writeErr(w, 500, err)
			return
		}
		c.TopPlaces, c.Representatives = tp, rp
		out = append(out, c)
	}
	writeJSON(w, 200, out)
}

// PATCH /api/v1/clusters/{map}/{side}/{id} — koç isimlendirmesi (insan döngüde)
func (s *server) renameCluster(w http.ResponseWriter, r *http.Request) {
	mapName, side := chi.URLParam(r, "map"), chi.URLParam(r, "side")
	id := chi.URLParam(r, "id")
	var body struct {
		Label string `json:"label"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, 400, fmt.Errorf("could not parse JSON: %w", err))
		return
	}
	var label *string
	if body.Label != "" {
		label = &body.Label
	}
	tag, err := s.pg.Exec(r.Context(), `
		UPDATE strategy_clusters SET label = $4
		WHERE map_name = $1 AND side = $2 AND cluster_id = $3`,
		mapName, side, id, label)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, fmt.Errorf("cluster not found"))
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "label": label})
}

// GET /api/v1/predict?team_id&map&side&buy_type&round_number — sonraki raunt
// dağılımı. Yöntem prediction_meta'dan: zamansal testte taban çizgiyi geçemeyen
// model sunulmaz (§6.2); kanıt gücü her yanıtta (§10).
func (s *server) predictHandler(w http.ResponseWriter, r *http.Request) {
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
	buy := q.Get("buy_type")
	if rn := q.Get("round_number"); rn == "1" || rn == "13" {
		buy = "pistol" // pistol rauntları deterministik özel durum
	}
	ctx := r.Context()

	var best string
	if err := s.pg.QueryRow(ctx,
		"SELECT best_method FROM prediction_meta WHERE map_name = $1 AND side = $2",
		mapName, side).Scan(&best); err != nil {
		best = "league" // değerlendirme yoksa en temkinli yöntem
	}
	method := best
	if (method == "team_buy" || method == "lgbm") && buy == "" {
		method = "team" // buy bilinmiyorsa bir seviye genele düş
	}
	// rakip-kalibre yöntemler (B1): opp_id verilmişse ve satır varsa;
	// yoksa dürüstçe takım katmanına düşülür (aşağıdaki zincir devralır)
	var oppID uuid.UUID
	hasOpp := false
	if o, e := uuid.Parse(q.Get("opp_id")); e == nil {
		oppID, hasOpp = o, true
	}
	if (method == "team_vs" || method == "team_style") && !hasOpp {
		method = "team"
	}

	type cl struct {
		ClusterID int16           `json:"cluster_id"`
		Label     *string         `json:"label"`
		TopPlaces json.RawMessage `json:"top_places"`
		Prob      float32         `json:"prob"`
	}
	var (
		clusters   []cl
		sampleSize int
	)
	scan := func(rowsQ string, args ...any) error {
		rows, err := s.pg.Query(ctx, rowsQ, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var c cl
			var tp *[]byte
			var n *int
			if err := rows.Scan(&c.ClusterID, &c.Label, &tp, &c.Prob, &n); err != nil {
				return err
			}
			if tp != nil {
				c.TopPlaces = json.RawMessage(*tp)
			} else {
				c.TopPlaces = json.RawMessage("[]")
			}
			if n != nil {
				sampleSize = *n
			}
			clusters = append(clusters, c)
		}
		return rows.Err()
	}

	switch method {
	case "team_vs", "team_style":
		kind := "vs"
		if method == "team_style" {
			kind = "style"
		}
		err = scan(`
			SELECT tv.cluster_id, sc.label, sc.top_places, tv.prob, tv.h2h_rounds
			FROM team_tendencies_vs tv
			LEFT JOIN strategy_clusters sc ON sc.map_name = tv.map_name
			     AND sc.side = tv.side AND sc.cluster_id = tv.cluster_id
			WHERE tv.team_id = $1 AND tv.opp_team_id = $2 AND tv.map_name = $3
			  AND tv.side = $4 AND tv.kind = $5
			ORDER BY tv.prob DESC`, teamID, oppID, mapName, side, kind)
		if err == nil && len(clusters) == 0 {
			method = "team" // bu rakip için kalibre satır yok
		}
	}
	// lgbm yalnız zamansal sınavı kazandığı çiftlerde tablo doldurur;
	// satır yoksa dürüstçe team_buy'a düşülür
	if method == "lgbm" {
		err = scan(`
			SELECT lp.cluster_id, sc.label, sc.top_places, lp.prob, round(lp.n_eff)::int
			FROM lgbm_predictions lp
			LEFT JOIN strategy_clusters sc ON sc.map_name = lp.map_name
			     AND sc.side = lp.side AND sc.cluster_id = lp.cluster_id
			WHERE lp.team_id = $1 AND lp.map_name = $2 AND lp.side = $3 AND lp.buy_type = $4
			ORDER BY lp.prob DESC`, teamID, mapName, side, buy)
		if err == nil && len(clusters) == 0 {
			method = "team_buy"
		}
	}
	switch method {
	case "team_buy":
		err = scan(`
			SELECT tc.cluster_id, sc.label, sc.top_places, tc.prob, tc.sample_size
			FROM team_tendencies_cond tc
			LEFT JOIN strategy_clusters sc ON sc.map_name = tc.map_name
			     AND sc.side = tc.side AND sc.cluster_id = tc.cluster_id
			WHERE tc.team_id = $1 AND tc.map_name = $2 AND tc.side = $3 AND tc.buy_type = $4
			ORDER BY tc.prob DESC`, teamID, mapName, side, buy)
		if err == nil && len(clusters) == 0 {
			method = "team" // bu buy için gözlem yok
		}
	}
	if method == "team" || (method == "team_buy" && len(clusters) == 0) {
		clusters = nil
		err = scan(`
			SELECT tt.cluster_id, sc.label, sc.top_places, tt.shrunk_prob, tt.sample_size
			FROM team_tendencies tt
			LEFT JOIN strategy_clusters sc ON sc.map_name = tt.map_name
			     AND sc.side = tt.side AND sc.cluster_id = tt.cluster_id
			WHERE tt.team_id = $1 AND tt.map_name = $2 AND tt.side = $3
			ORDER BY tt.shrunk_prob DESC`, teamID, mapName, side)
	}
	if method == "league" || len(clusters) == 0 {
		method = "league"
		clusters = nil
		err = scan(`
			SELECT sc.cluster_id, sc.label, sc.top_places,
			       (sc.size::real / NULLIF(sum(sc.size) OVER (), 0)) AS prob,
			       NULL::int
			FROM strategy_clusters sc
			WHERE sc.map_name = $1 AND sc.side = $2
			ORDER BY prob DESC`, mapName, side)
	}
	if err != nil {
		writeErr(w, 500, err)
		return
	}

	note := "league-wide distribution (team data didn't beat the baseline)"
	switch method {
	case "lgbm":
		note = fmt.Sprintf("gradient-boosted model (LightGBM), trained on ~%d weighted rounds — won the temporal test for this map/side", sampleSize)
	case "team_vs":
		note = fmt.Sprintf("%d head-to-head rounds vs this opponent — opponent-calibrated", sampleSize)
	case "team_style":
		note = "calibrated to opponents with a similar style profile"
	case "team", "team_buy":
		switch {
		case sampleSize < 15:
			note = fmt.Sprintf("%d rounds observed — low confidence", sampleSize)
		case sampleSize < 40:
			note = fmt.Sprintf("%d rounds observed — medium confidence", sampleSize)
		default:
			note = fmt.Sprintf("%d rounds observed — high confidence", sampleSize)
		}
	}
	writeJSON(w, 200, map[string]any{
		"method":   method,
		"clusters": clusters,
		"evidence": map[string]any{"sample_size": sampleSize, "note": note},
	})
}

// GET /api/v1/players/{id}/flags — anomali bayrakları (kanıt: maç + metrik + z)
func (s *server) playerFlags(w http.ResponseWriter, r *http.Request) {
	playerID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 400, fmt.Errorf("invalid player_id"))
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

// GET /api/v1/mlstatus — ML sayfası: yöntem yarışı sonuçları + model envanteri.
// prediction_meta'nın tamamı + tablo sayımları tek yanıtta; sayfa tek istekle dolar.
func (s *server) mlStatus(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	type metaRow struct {
		Map        string          `json:"map_name"`
		Side       string          `json:"side"`
		Best       string          `json:"best_method"`
		League     *float32        `json:"logloss_league"`
		Team       *float32        `json:"logloss_team"`
		TeamBuy    *float32        `json:"logloss_team_buy"`
		TeamVs     *float32        `json:"logloss_team_vs"`
		TeamStyle  *float32        `json:"logloss_team_style"`
		Lgbm       *float32        `json:"logloss_lgbm"`
		Importance json.RawMessage `json:"lgbm_importance,omitempty"`
		TestRounds *int            `json:"test_rounds"`
	}
	meta := []metaRow{}
	rows, err := s.pg.Query(ctx, `
		SELECT map_name, side, best_method, logloss_league, logloss_team,
		       logloss_team_buy, logloss_team_vs, logloss_team_style,
		       logloss_lgbm, lgbm_importance, test_rounds
		FROM prediction_meta ORDER BY map_name, side`)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var m metaRow
		var imp *[]byte
		if rows.Scan(&m.Map, &m.Side, &m.Best, &m.League, &m.Team,
			&m.TeamBuy, &m.TeamVs, &m.TeamStyle, &m.Lgbm, &imp, &m.TestRounds) == nil {
			if imp != nil {
				m.Importance = json.RawMessage(*imp)
			}
			meta = append(meta, m)
		}
	}
	var inv struct {
		Matches   int `json:"matches"`
		Rounds    int `json:"rounds"`
		Clusters  int `json:"clusters"`
		Tendency  int `json:"tendency_rows"`
		CondRows  int `json:"cond_rows"`
		VsRows    int `json:"vs_rows"`
		Anomalies int `json:"anomaly_flags"`
		WinCells  int `json:"winprob_cells"`
		ExecTpl   int `json:"exec_templates"`
		Clutches  int `json:"clutches"`
	}
	if err := s.pg.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM matches WHERE status='ready'),
		(SELECT count(*) FROM rounds),
		(SELECT count(*) FROM strategy_clusters),
		(SELECT count(*) FROM team_tendencies),
		(SELECT count(*) FROM team_tendencies_cond),
		(SELECT count(*) FROM team_tendencies_vs),
		(SELECT count(*) FROM anomaly_flags),
		(SELECT count(*) FROM winprob_table),
		(SELECT count(*) FROM team_exec_templates),
		(SELECT count(*) FROM clutches)`).Scan(
		&inv.Matches, &inv.Rounds, &inv.Clusters, &inv.Tendency, &inv.CondRows,
		&inv.VsRows, &inv.Anomalies, &inv.WinCells, &inv.ExecTpl, &inv.Clutches); err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"evaluation": meta, "inventory": inv})
}
