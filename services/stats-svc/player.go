// Oyuncu profili: roller + harita bazlı performans + bayraklar + maçlar.
// Isı haritası ayrı endpoint'ten (heatCells yardımcısıyla, arşiv geneli).
package main

import (
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// GET /api/v1/players/{id}/profile
func (s *server) playerProfile(w http.ResponseWriter, r *http.Request) {
	playerID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 400, fmt.Errorf("invalid player_id"))
		return
	}
	ctx := r.Context()

	var nick string
	var teamName *string
	if err := s.pg.QueryRow(ctx, `
		SELECT p.nickname, t.name FROM players p
		LEFT JOIN teams t ON t.team_id = p.current_team_id
		WHERE p.player_id = $1`, playerID).Scan(&nick, &teamName); err != nil {
		writeErr(w, 404, fmt.Errorf("player not found"))
		return
	}

	out := map[string]any{"player_id": playerID, "nickname": nick, "team": teamName}

	// roller (Faz 5 player_roles; taraf başına bir satır)
	out["roles"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x), '[]'::json) FROM (
		    SELECT side, rounds, entry_attempt_share, entry_success,
		           opening_kills, opening_deaths, lurk_dist_avg,
		           anchor_place, anchor_share, awp_round_share,
		           util_per_round, flash_assists_pr, adr, tags
		    FROM player_roles WHERE player_id = $1 ORDER BY side DESC
		) x`, playerID)

	// harita bazlı performans (PRS + kills; taraftan bağımsız toplam)
	out["maps"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY x.rounds DESC), '[]'::json) FROM (
		    SELECT m.map_name,
		           count(*) AS rounds,
		           count(DISTINCT s.match_id) AS matches,
		           round(COALESCE(sum(s.damage_dealt), 0)::numeric / count(*), 1) AS adr,
		           COALESCE(sum(s.kills), 0) AS kills,
		           COALESCE(sum(s.deaths), 0) AS deaths,
		           COALESCE(sum(s.assists), 0) AS assists,
		           round(100.0 * count(*) FILTER (WHERE s.survived) / count(*), 0) AS survival_pct
		    FROM player_round_states s
		    JOIN matches m ON m.match_id = s.match_id AND m.status = 'ready'
		    WHERE s.player_id = $1
		    GROUP BY m.map_name
		) x`, playerID)

	// açılış düelloları harita bazında (kills.is_first_kill)
	out["openings"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x), '[]'::json) FROM (
		    SELECT m.map_name,
		           count(*) FILTER (WHERE k.attacker_id = $1) AS won,
		           count(*) FILTER (WHERE k.victim_id = $1) AS lost
		    FROM kills k JOIN matches m ON m.match_id = k.match_id AND m.status='ready'
		    WHERE k.is_first_kill AND (k.attacker_id = $1 OR k.victim_id = $1)
		    GROUP BY m.map_name
		) x`, playerID)

	// anomali bayrakları (kanıtlı)
	out["flags"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY abs(x.z) DESC), '[]'::json) FROM (
		    SELECT f.metric, f.value, f.baseline_mean, f.baseline_std, f.z,
		           m.event_name, m.map_name, f.match_id
		    FROM anomaly_flags f JOIN matches m ON m.match_id = f.match_id
		    WHERE f.player_id = $1
		) x`, playerID)

	writeJSON(w, 200, out)
}

// GET /api/v1/players/{id}/heatmap?map&side=T&t0&t1 — arşiv geneli.
func (s *server) playerHeatmap(w http.ResponseWriter, r *http.Request) {
	playerID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 400, fmt.Errorf("invalid player_id"))
		return
	}
	q := r.URL.Query()
	mapName, side := q.Get("map"), q.Get("side")
	if mapName == "" || (side != "T" && side != "CT") {
		writeErr(w, 400, fmt.Errorf("map and side (T|CT) are required"))
		return
	}
	t0, _ := strconv.Atoi(q.Get("t0"))
	t1 := 115
	if v, err := strconv.Atoi(q.Get("t1")); err == nil {
		t1 = v
	}
	if t1 < t0 {
		t0, t1 = t1, t0
	}
	ctx := r.Context()
	cal, err := s.radarFor(ctx, mapName)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	// oyuncunun o haritada o tarafta oynadığı rauntlar (PRS üzerinden)
	prows, err := s.pg.Query(ctx, `
		SELECT r.match_id, r.round_number, COALESCE(r.freeze_end_tick, r.start_tick), r.end_tick
		FROM player_round_states s
		JOIN rounds r ON (r.match_id, r.round_number) = (s.match_id, s.round_number)
		JOIN matches m ON m.match_id = s.match_id AND m.status = 'ready'
		WHERE s.player_id = $1 AND s.side = $2 AND m.map_name = $3`,
		playerID, side, mapName)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	var windows []heatWindow
	for prows.Next() {
		var mid uuid.UUID
		var rn int16
		var fe, end *int32
		if prows.Scan(&mid, &rn, &fe, &end) != nil || fe == nil {
			continue
		}
		if hw, ok := makeWindow(mid, rn, *fe, end, t0, t1); ok {
			windows = append(windows, hw)
		}
	}
	prows.Close()
	cells, cellsLower, err := s.heatCells(ctx, cal, mapName, windows, side, &playerID)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	resp := map[string]any{
		"cells": cells, "cell_radar": heatCellRadar,
		"round_count": len(windows), "radar": cal,
	}
	if cal.HasLower {
		resp["cells_lower"] = cellsLower
	}
	writeJSON(w, 200, resp)
}
