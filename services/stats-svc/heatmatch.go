// Maç-bazlı detaylı ısı haritası: heatmap_grid özeti yerine ham player_ticks
// üzerinden hesaplanır — oyuncu ve raunt filtreleri ancak böyle mümkün.
// Tek maç ≈ 500K satır; ClickHouse için önemsiz yük.
package main

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// GET /api/v1/matches/{id}/players — maçta oynayan herkes (filtre listesi)
func (s *server) matchPlayers(w http.ResponseWriter, r *http.Request) {
	matchID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 400, fmt.Errorf("invalid match_id"))
		return
	}
	rows, err := s.pg.Query(r.Context(), `
		SELECT p.player_id, p.nickname
		FROM player_round_states s JOIN players p ON p.player_id = s.player_id
		WHERE s.match_id = $1
		GROUP BY p.player_id, p.nickname ORDER BY p.nickname`, matchID)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer rows.Close()
	type hit struct {
		ID   uuid.UUID `json:"player_id"`
		Nick string    `json:"nickname"`
	}
	out := []hit{}
	for rows.Next() {
		var h hit
		if rows.Scan(&h.ID, &h.Nick) == nil {
			out = append(out, h)
		}
	}
	writeJSON(w, 200, out)
}

// GET /api/v1/matches/{id}/heatmap?side=T&player_id=&rounds=1,2,3&t0=0&t1=115
// Hücreler radar uzayında (cell=8 radar birimi); ağırlık = tick sayısı.
// Zaman penceresi raunt freeze-end'ine göredir (raunt başına ayrı tick aralığı).
func (s *server) matchHeatmap(w http.ResponseWriter, r *http.Request) {
	matchID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 400, fmt.Errorf("invalid match_id"))
		return
	}
	q := r.URL.Query()
	side := q.Get("side")
	if side != "T" && side != "CT" && side != "" {
		writeErr(w, 400, fmt.Errorf("invalid side"))
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

	var mapName string
	if err := s.pg.QueryRow(ctx,
		"SELECT map_name FROM matches WHERE match_id = $1", matchID).
		Scan(&mapName); err != nil {
		writeErr(w, 404, fmt.Errorf("match not found"))
		return
	}
	cal, err := s.radarFor(ctx, mapName)
	if err != nil {
		writeErr(w, 500, err)
		return
	}

	// Seçili rauntların zaman pencereleri (freeze-end + t0..t1 saniye)
	roundFilter := "TRUE"
	var roundArgs []int16
	if rs := strings.TrimSpace(q.Get("rounds")); rs != "" {
		for _, part := range strings.Split(rs, ",") {
			if n, err := strconv.Atoi(strings.TrimSpace(part)); err == nil && n > 0 && n < 256 {
				roundArgs = append(roundArgs, int16(n))
			}
		}
		if len(roundArgs) == 0 {
			writeJSON(w, 200, map[string]any{"cells": [][3]int32{}, "round_count": 0, "radar": cal})
			return
		}
		roundFilter = "round_number = ANY($2)"
	}
	prows, err := s.pg.Query(ctx, `
		SELECT round_number, COALESCE(freeze_end_tick, start_tick), end_tick
		FROM rounds WHERE match_id = $1 AND `+roundFilter,
		func() []any {
			if roundArgs != nil {
				return []any{matchID, roundArgs}
			}
			return []any{matchID}
		}()...)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	var windows []string
	nRounds := 0
	for prows.Next() {
		var rn int16
		var fe, end *int32
		if prows.Scan(&rn, &fe, &end) != nil || fe == nil {
			continue
		}
		lo := *fe + int32(t0)*tickRate
		hi := *fe + int32(t1)*tickRate
		if end != nil && hi > *end {
			hi = *end
		}
		if hi <= lo {
			continue
		}
		windows = append(windows,
			fmt.Sprintf("(round_number = %d AND tick BETWEEN %d AND %d)", rn, lo, hi))
		nRounds++
	}
	prows.Close()
	if len(windows) == 0 {
		writeJSON(w, 200, map[string]any{"cells": [][3]int32{}, "round_count": 0, "radar": cal})
		return
	}

	const cellRadar = 8.0 // radar birimi; 1024/8 = 128×128 ızgara
	cond := "match_id = ? AND is_alive AND (" + strings.Join(windows, " OR ") + ")"
	args := []any{matchID}
	if side != "" {
		cond += " AND side = ?"
		args = append(args, side)
	}
	if pid := q.Get("player_id"); pid != "" {
		pu, err := uuid.Parse(pid)
		if err != nil {
			writeErr(w, 400, fmt.Errorf("invalid player_id"))
			return
		}
		cond += " AND player_id = ?"
		args = append(args, pu)
	}
	chq := fmt.Sprintf(`
		SELECT toInt32(floor(((x - (%f)) / %f) / %f)) AS cx,
		       toInt32(floor((((%f) - y) / %f) / %f)) AS cy,
		       toInt32(count()) AS w
		FROM player_ticks WHERE %s GROUP BY cx, cy`,
		cal.PosX, cal.Scale, cellRadar, cal.PosY, cal.Scale, cellRadar, cond)
	rows, err := s.ch.Query(ctx, chq, args...)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer rows.Close()
	cells := [][3]int32{}
	for rows.Next() {
		var cx, cy, wt int32
		if rows.Scan(&cx, &cy, &wt) == nil {
			cells = append(cells, [3]int32{cx, cy, wt})
		}
	}
	writeJSON(w, 200, map[string]any{
		"cells": cells, "cell_radar": cellRadar,
		"round_count": nRounds, "radar": cal,
	})
}
