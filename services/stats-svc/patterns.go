// Pattern Finder: arşivdeki granatların atış→düşüş yörüngeleri, radar
// koordinatlarıyla. İstemci haritada kutu çizerek bölge filtreler, zamanlama
// histogramını okur ve rauntlara atlar. (Skybox Pattern Finder karşılığı;
// veri kaynağı PG grenades + maps kalibrasyonu — ek hesap yok.)
package main

import (
	"fmt"
	"net/http"

	"github.com/google/uuid"
)

// GET /api/v1/patterns?map=&side=&team_id=&player_id=&since=
// type filtresi istemcide (tümü tek yanıtta gelir; aç/kapat anlıktır).
func (s *server) patterns(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	mapName := q.Get("map")
	if mapName == "" {
		writeErr(w, 400, fmt.Errorf("map is required"))
		return
	}
	args := []any{mapName}
	sql := `
	SELECT g.type, g.side, COALESCE(p.nickname, ''), COALESCE(g.thrower_id::text, ''),
	       round(((g.throw_x - mp.radar_pos_x) / mp.radar_scale)::numeric, 1),
	       round(((mp.radar_pos_y - g.throw_y) / mp.radar_scale)::numeric, 1),
	       round(((g.det_x - mp.radar_pos_x) / mp.radar_scale)::numeric, 1),
	       round(((mp.radar_pos_y - g.det_y) / mp.radar_scale)::numeric, 1),
	       round(((g.throw_tick - r.freeze_end_tick) / 64.0)::numeric, 1),
	       g.match_id::text, g.round_number
	FROM grenades g
	JOIN rounds  r ON (r.match_id, r.round_number) = (g.match_id, g.round_number)
	JOIN matches m ON m.match_id = g.match_id AND m.status = 'ready'
	JOIN maps   mp ON mp.map_name = m.map_name
	LEFT JOIN players p ON p.player_id = g.thrower_id
	WHERE m.map_name = $1 AND g.det_x IS NOT NULL AND g.throw_x IS NOT NULL
	  AND r.freeze_end_tick IS NOT NULL AND g.side IN ('T','CT')`
	if side := q.Get("side"); side == "T" || side == "CT" {
		args = append(args, side)
		sql += fmt.Sprintf(" AND g.side = $%d", len(args))
	}
	if tid, err := uuid.Parse(q.Get("team_id")); err == nil {
		args = append(args, tid)
		sql += fmt.Sprintf(` AND (CASE WHEN g.side = 'T' THEN r.t_team_id
		                        ELSE r.ct_team_id END) = $%d`, len(args))
	}
	if pid, err := uuid.Parse(q.Get("player_id")); err == nil {
		args = append(args, pid)
		sql += fmt.Sprintf(" AND g.thrower_id = $%d", len(args))
	}
	if since := q.Get("since"); since != "" {
		args = append(args, since)
		sql += fmt.Sprintf(" AND m.played_at >= $%d::date", len(args))
	}
	sql += " ORDER BY m.played_at DESC, g.match_id, g.round_number LIMIT 8000"

	rows, err := s.pg.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer rows.Close()
	type nade struct {
		Type    string  `json:"type"`
		Side    string  `json:"side"`
		Thrower string  `json:"thrower"`
		PID     string  `json:"player_id"`
		TRX     float32 `json:"trx"`
		TRY     float32 `json:"try"`
		DRX     float32 `json:"drx"`
		DRY     float32 `json:"dry"`
		TSec    float32 `json:"t"`
		MatchID string  `json:"match_id"`
		Round   int16   `json:"round_number"`
	}
	out := []nade{}
	for rows.Next() {
		var n nade
		if rows.Scan(&n.Type, &n.Side, &n.Thrower, &n.PID, &n.TRX, &n.TRY,
			&n.DRX, &n.DRY, &n.TSec, &n.MatchID, &n.Round) == nil {
			out = append(out, n)
		}
	}
	writeJSON(w, 200, map[string]any{"nades": out, "truncated": len(out) == 8000})
}
