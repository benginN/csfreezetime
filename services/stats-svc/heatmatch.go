// Maç-bazlı detaylı ısı haritası: heatmap_grid özeti yerine ham player_ticks
// üzerinden hesaplanır — oyuncu ve raunt filtreleri ancak böyle mümkün.
// Tek maç ≈ 500K satır; ClickHouse için önemsiz yük.
package main

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/ClickHouse/clickhouse-go/v2"
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
		SELECT p.player_id, p.nickname,
		       COALESCE(array_agg(s.round_number) FILTER (WHERE s.side = 'T'),  '{}') AS t_rounds,
		       COALESCE(array_agg(s.round_number) FILTER (WHERE s.side = 'CT'), '{}') AS ct_rounds,
		       -- koç: maç boyu tek kill/death'i olmayan katılımcı (GOTV'de
		       -- takım slotunda görünür ama oynamaz)
		       (COALESCE(sum(s.kills),0) + COALESCE(sum(s.deaths),0) = 0
		        AND count(*) >= 6) AS is_coach,
		       -- HUD kümülatif istatistikleri: raunt-bazlı paralel diziler
		       COALESCE(array_agg(s.round_number ORDER BY s.round_number), '{}') AS stat_rounds,
		       COALESCE(array_agg(COALESCE(s.damage_dealt,0)::int ORDER BY s.round_number), '{}') AS stat_dmg,
		       COALESCE(array_agg((s.util_he_dmg + s.util_fire_dmg)::int ORDER BY s.round_number), '{}') AS stat_util,
		       COALESCE(array_agg(COALESCE(g.ef,0) ORDER BY s.round_number), '{}') AS stat_flashed
		FROM player_round_states s JOIN players p ON p.player_id = s.player_id
		LEFT JOIN LATERAL (
		    SELECT sum(gr.enemies_flashed)::int AS ef FROM grenades gr
		    WHERE gr.match_id = s.match_id AND gr.round_number = s.round_number
		      AND gr.thrower_id = s.player_id AND gr.type = 'flash'
		) g ON true
		WHERE s.match_id = $1
		GROUP BY p.player_id, p.nickname ORDER BY p.nickname`, matchID)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer rows.Close()
	type hit struct {
		ID       uuid.UUID `json:"player_id"`
		Nick     string    `json:"nickname"`
		TRounds  []int16   `json:"t_rounds"`
		CTRounds []int16   `json:"ct_rounds"`
		IsCoach  bool      `json:"is_coach"`
		SRounds  []int16   `json:"stat_rounds"`
		SDmg     []int32   `json:"stat_dmg"`
		SUtil    []int32   `json:"stat_util"`
		SFlash   []int32   `json:"stat_flashed"`
	}
	out := []hit{}
	for rows.Next() {
		var h hit
		if rows.Scan(&h.ID, &h.Nick, &h.TRounds, &h.CTRounds, &h.IsCoach,
			&h.SRounds, &h.SDmg, &h.SUtil, &h.SFlash) == nil {
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
	var windows []heatWindow
	for prows.Next() {
		var rn int16
		var fe, end *int32
		if prows.Scan(&rn, &fe, &end) != nil || fe == nil {
			continue
		}
		if hw, ok := makeWindow(matchID, rn, *fe, end, t0, t1); ok {
			windows = append(windows, hw)
		}
	}
	prows.Close()

	var playerID *uuid.UUID
	if pid := q.Get("player_id"); pid != "" {
		pu, err := uuid.Parse(pid)
		if err != nil {
			writeErr(w, 400, fmt.Errorf("invalid player_id"))
			return
		}
		playerID = &pu
	}
	cells, cellsLower, err := s.heatCells(ctx, cal, mapName, windows, side, playerID, "")
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

const heatCellRadar = 8.0 // radar birimi; 1024/8 = 128×128 ızgara

type heatWindow struct {
	matchID uuid.UUID
	round   int16
	lo, hi  int32
}

func makeWindow(matchID uuid.UUID, rn int16, freezeEnd int32, end *int32, t0, t1 int) (heatWindow, bool) {
	lo := freezeEnd + int32(t0)*tickRate
	hi := freezeEnd + int32(t1)*tickRate
	if end != nil && hi > *end {
		hi = *end
	}
	if hi <= lo {
		return heatWindow{}, false
	}
	return heatWindow{matchID: matchID, round: rn, lo: lo, hi: hi}, true
}

// heatCells: pencere listesinden radar-hücre yoğunlukları (kat ayrımlı).
// Maç-bazlı ve takım-arşivi ısı haritaları bu tek sorguyu paylaşır.
func (s *server) heatCells(
	ctx context.Context, cal *radarCal, mapName string,
	windows []heatWindow, side string, playerID *uuid.UUID,
	extraCond string, // sunucu-tanımlı ek CH koşulu (ör. envanter filtresi)
) (cells, cellsLower [][3]int32, err error) {
	cells, cellsLower = [][3]int32{}, [][3]int32{}
	if len(windows) == 0 {
		return cells, cellsLower, nil
	}
	parts := make([]string, 0, len(windows))
	for _, hw := range windows {
		parts = append(parts, fmt.Sprintf(
			"(match_id = '%s' AND round_number = %d AND tick BETWEEN %d AND %d)",
			hw.matchID, hw.round, hw.lo, hw.hi))
	}
	cond := "map_name = ? AND is_alive AND (" + strings.Join(parts, " OR ") + ")"
	args := []any{mapName}
	if side != "" {
		cond += " AND side = ?"
		args = append(args, side)
	}
	if playerID != nil {
		cond += " AND player_id = ?"
		args = append(args, *playerID)
	}
	if extraCond != "" {
		cond += " AND " + extraCond
	}
	lvlExpr := "0"
	if cal.HasLower && cal.SplitZ != nil {
		lvlExpr = fmt.Sprintf("toUInt8(z < %f)", *cal.SplitZ)
	}
	chq := fmt.Sprintf(`
		SELECT toInt32(floor(((x - (%f)) / %f) / %f)) AS cx,
		       toInt32(floor((((%f) - y) / %f) / %f)) AS cy,
		       %s AS lvl,
		       toInt32(count()) AS w
		FROM player_ticks WHERE %s GROUP BY cx, cy, lvl`,
		cal.PosX, cal.Scale, heatCellRadar, cal.PosY, cal.Scale, heatCellRadar, lvlExpr, cond)
	// per-round windows are inlined; raise max_query_size so big archives
	// (many rounds for one team/player) don't hit the 256 KB parse limit
	chCtx := clickhouse.Context(ctx, clickhouse.WithSettings(clickhouse.Settings{
		"max_query_size": 500_000_000,
	}))
	rows, err := s.ch.Query(chCtx, chq, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var cx, cy, wt int32
		var lvl uint8
		if rows.Scan(&cx, &cy, &lvl, &wt) == nil {
			if lvl == 1 {
				cellsLower = append(cellsLower, [3]int32{cx, cy, wt})
			} else {
				cells = append(cells, [3]int32{cx, cy, wt})
			}
		}
	}
	return cells, cellsLower, rows.Err()
}

// GET /api/v1/teams/{id}/heatmap?map&side=T&t0&t1 — takımın arşiv geneli
// ısı haritası (taraf-farkındalıklı raunt seçimi: t/ct_team_id).
func (s *server) teamHeatmap(w http.ResponseWriter, r *http.Request) {
	teamID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 400, fmt.Errorf("invalid team_id"))
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
	teamCol := "t_team_id"
	if side == "CT" {
		teamCol = "ct_team_id"
	}
	rosterMin, _ := strconv.Atoi(q.Get("roster_min"))
	elig := s.eligibleMatches(ctx, teamID, q.Get("since"), rosterMin)
	// anchor=plant: pencere bomba kurulumuna göre (t0/t1 plant'a görecelidir;
	// kurulumsuz rauntlar doğal olarak dışarıda kalır)
	baseCol := "COALESCE(r.freeze_end_tick, r.start_tick)"
	if q.Get("anchor") == "plant" {
		baseCol = "r.bomb_plant_tick"
	}
	prows, err := s.pg.Query(ctx, `
		SELECT r.match_id, r.round_number, `+baseCol+`, r.end_tick
		FROM rounds r JOIN matches m ON m.match_id = r.match_id AND m.status = 'ready'
		WHERE m.map_name = $1 AND r.`+teamCol+` = $2
		  AND `+baseCol+` IS NOT NULL
		  AND ($3::text[] IS NULL OR m.match_id::text = ANY($3::text[]))`, mapName, teamID, elig)
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
	cells, cellsLower, err := s.heatCells(ctx, cal, mapName, windows, side, nil, "")
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
