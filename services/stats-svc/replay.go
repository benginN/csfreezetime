// Replay ve Multi-View Stacking endpoint'leri (mimari.md §8.1, §8.3).
// Dünya→radar dönüşümü (§4.5) sunucuda yapılır; istemci saf çizim yapar.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

const tickRate = 64

type radarCal struct {
	PosX     float64  `json:"pos_x"`
	PosY     float64  `json:"pos_y"`
	Scale    float64  `json:"scale"`
	HasLower bool     `json:"has_lower"`
	SplitZ   *float64 `json:"split_z"`
}

func (s *server) radarFor(ctx context.Context, mapName string) (*radarCal, error) {
	var r radarCal
	err := s.pg.QueryRow(ctx, `
		SELECT radar_pos_x, radar_pos_y, radar_scale,
		       COALESCE(has_lower_level, FALSE), level_split_z
		FROM maps WHERE map_name = $1`, mapName).
		Scan(&r.PosX, &r.PosY, &r.Scale, &r.HasLower, &r.SplitZ)
	if err != nil {
		return nil, fmt.Errorf("harita kalibrasyonu yok: %s", mapName)
	}
	return &r, nil
}

// GET /api/v1/matches/{id} — raunt listesi + kill listesi (maç sayfası verisi)
func (s *server) matchDetail(w http.ResponseWriter, r *http.Request) {
	matchID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 400, fmt.Errorf("geçersiz match_id"))
		return
	}
	ctx := r.Context()

	var mapName *string
	var status string
	if err := s.pg.QueryRow(ctx,
		"SELECT map_name, status FROM matches WHERE match_id = $1", matchID).
		Scan(&mapName, &status); err != nil {
		writeErr(w, 404, fmt.Errorf("maç bulunamadı"))
		return
	}

	type roundRow struct {
		RoundNumber   int16   `json:"round_number"`
		StartTick     *int32  `json:"start_tick"`
		FreezeEndTick *int32  `json:"freeze_end_tick"`
		EndTick       *int32  `json:"end_tick"`
		WinnerSide    *string `json:"winner_side"`
		EndReason     *string `json:"end_reason"`
		BombSite      *string `json:"bomb_site"`
		BombPlantTick *int32  `json:"bomb_plant_tick"`
		TBuy          *string `json:"t_buy_type"`
		CTBuy         *string `json:"ct_buy_type"`
		TCluster      *int16  `json:"t_cluster"`
		CTCluster     *int16  `json:"ct_cluster"`
	}
	rows, err := s.pg.Query(ctx, `
		SELECT round_number, start_tick, freeze_end_tick, end_tick, winner_side,
		       end_reason, bomb_site, bomb_plant_tick, t_buy_type, ct_buy_type,
		       t_strategy_cluster, ct_strategy_cluster
		FROM rounds WHERE match_id = $1 ORDER BY round_number`, matchID)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	var rounds []roundRow
	for rows.Next() {
		var x roundRow
		if err := rows.Scan(&x.RoundNumber, &x.StartTick, &x.FreezeEndTick, &x.EndTick,
			&x.WinnerSide, &x.EndReason, &x.BombSite, &x.BombPlantTick, &x.TBuy, &x.CTBuy,
			&x.TCluster, &x.CTCluster); err != nil {
			rows.Close()
			writeErr(w, 500, err)
			return
		}
		rounds = append(rounds, x)
	}
	rows.Close()

	type killRow struct {
		RoundNumber int16   `json:"round_number"`
		Tick        int32   `json:"tick"`
		RoundTime   float32 `json:"round_time"`
		Attacker    *string `json:"attacker"`
		Victim      *string `json:"victim"`
		Weapon      *string `json:"weapon"`
		Headshot    *bool   `json:"headshot"`
	}
	krows, err := s.pg.Query(ctx, `
		SELECT k.round_number, k.tick, k.round_time,
		       pa.nickname, pv.nickname, k.weapon, k.headshot
		FROM kills k
		LEFT JOIN players pa ON pa.player_id = k.attacker_id
		LEFT JOIN players pv ON pv.player_id = k.victim_id
		WHERE k.match_id = $1 ORDER BY k.round_number, k.tick`, matchID)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer krows.Close()
	var kills []killRow
	for krows.Next() {
		var x killRow
		if err := krows.Scan(&x.RoundNumber, &x.Tick, &x.RoundTime,
			&x.Attacker, &x.Victim, &x.Weapon, &x.Headshot); err != nil {
			writeErr(w, 500, err)
			return
		}
		kills = append(kills, x)
	}
	writeJSON(w, 200, map[string]any{
		"match_id": matchID, "map_name": mapName, "status": status,
		"rounds": rounds, "kills": kills,
	})
}

type playerTrack struct {
	PlayerID uuid.UUID `json:"player_id"`
	Nickname string    `json:"nickname"`
	Side     string    `json:"side"`
	// tick eksenine paralel diziler; oyuncunun o tick'te verisi yoksa null
	RX     []*float64 `json:"rx"`
	RY     []*float64 `json:"ry"`
	Yaw    []*float64 `json:"yaw"`
	HP     []*int32   `json:"hp"`
	Alive  []*bool    `json:"alive"`
	Weapon []*string  `json:"weapon"`
	Flash  []*float64 `json:"flash"`           // kalan körlük süresi (sn)
	Lower  []*bool    `json:"lower,omitempty"` // çok katlı haritada alt kat mı
}

// GET /api/v1/rounds/{match_id}/{n}/ticks — rauntun tüm 16 Hz akışı, radar koordinatlı
func (s *server) roundTicks(w http.ResponseWriter, r *http.Request) {
	matchID, err := uuid.Parse(chi.URLParam(r, "match_id"))
	if err != nil {
		writeErr(w, 400, fmt.Errorf("geçersiz match_id"))
		return
	}
	roundNo, err := strconv.Atoi(chi.URLParam(r, "n"))
	if err != nil || roundNo < 1 || roundNo > 255 {
		writeErr(w, 400, fmt.Errorf("geçersiz raunt numarası"))
		return
	}
	ctx := r.Context()

	var mapName string
	var freezeEnd *int32
	if err := s.pg.QueryRow(ctx, `
		SELECT m.map_name, r.freeze_end_tick FROM rounds r
		JOIN matches m ON m.match_id = r.match_id
		WHERE r.match_id = $1 AND r.round_number = $2`, matchID, roundNo).
		Scan(&mapName, &freezeEnd); err != nil {
		writeErr(w, 404, fmt.Errorf("raunt bulunamadı"))
		return
	}
	cal, err := s.radarFor(ctx, mapName)
	if err != nil {
		writeErr(w, 500, err)
		return
	}

	// Nickname eşlemesi
	nicks := map[uuid.UUID]string{}
	prow, err := s.pg.Query(ctx, `
		SELECT DISTINCT p.player_id, p.nickname
		FROM player_round_states s JOIN players p ON p.player_id = s.player_id
		WHERE s.match_id = $1`, matchID)
	if err == nil {
		for prow.Next() {
			var id uuid.UUID
			var n string
			if prow.Scan(&id, &n) == nil {
				nicks[id] = n
			}
		}
		prow.Close()
	}

	chRows, err := s.ch.Query(ctx, `
		SELECT tick, player_id, side, x, y, z, yaw, health, is_alive,
		       active_weapon, flash_remaining
		FROM player_ticks
		WHERE match_id = ? AND round_number = ?
		ORDER BY tick, player_id`, matchID, uint8(roundNo))
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer chRows.Close()

	tickSet := map[uint32]bool{}
	type sample struct {
		rx, ry, yaw float64
		hp          int32
		alive       bool
		lower       bool
		weapon      string
		flash       float64
	}
	perPlayer := map[uuid.UUID]map[uint32]sample{}
	sides := map[uuid.UUID]string{}
	for chRows.Next() {
		var tick uint32
		var pid uuid.UUID
		var side, weapon string
		var x, y, z, yaw, flash float32
		var hp uint8
		var alive bool
		if err := chRows.Scan(&tick, &pid, &side, &x, &y, &z, &yaw, &hp, &alive, &weapon, &flash); err != nil {
			writeErr(w, 500, err)
			return
		}
		tickSet[tick] = true
		sides[pid] = side
		if perPlayer[pid] == nil {
			perPlayer[pid] = map[uint32]sample{}
		}
		lower := cal.HasLower && cal.SplitZ != nil && float64(z) < *cal.SplitZ
		perPlayer[pid][tick] = sample{
			rx: (float64(x) - cal.PosX) / cal.Scale, ry: (cal.PosY - float64(y)) / cal.Scale,
			yaw: float64(yaw), hp: int32(hp), alive: alive, lower: lower,
			weapon: weapon, flash: float64(flash),
		}
	}
	if len(tickSet) == 0 {
		writeErr(w, 404, fmt.Errorf("raunt için tick verisi yok"))
		return
	}

	ticks := make([]uint32, 0, len(tickSet))
	for t := range tickSet {
		ticks = append(ticks, t)
	}
	sort.Slice(ticks, func(i, j int) bool { return ticks[i] < ticks[j] })

	var players []playerTrack
	for pid, samples := range perPlayer {
		tr := playerTrack{
			PlayerID: pid, Nickname: nicks[pid], Side: sides[pid],
			RX: make([]*float64, len(ticks)), RY: make([]*float64, len(ticks)),
			Yaw: make([]*float64, len(ticks)), HP: make([]*int32, len(ticks)),
			Alive:  make([]*bool, len(ticks)),
			Weapon: make([]*string, len(ticks)), Flash: make([]*float64, len(ticks)),
		}
		if cal.HasLower {
			tr.Lower = make([]*bool, len(ticks))
		}
		for i, t := range ticks {
			if sm, ok := samples[t]; ok {
				rx, ry, yaw, hp, alive, lower := sm.rx, sm.ry, sm.yaw, sm.hp, sm.alive, sm.lower
				weapon, flash := sm.weapon, sm.flash
				tr.RX[i], tr.RY[i], tr.Yaw[i] = &rx, &ry, &yaw
				tr.HP[i], tr.Alive[i] = &hp, &alive
				tr.Weapon[i], tr.Flash[i] = &weapon, &flash
				if cal.HasLower {
					tr.Lower[i] = &lower
				}
			}
		}
		players = append(players, tr)
	}
	sort.Slice(players, func(i, j int) bool {
		if players[i].Side != players[j].Side {
			return players[i].Side < players[j].Side
		}
		return players[i].Nickname < players[j].Nickname
	})

	// Rauntun kill'leri (zaman çubuğu işaretleri + radar konumları)
	type killMark struct {
		Tick     int32    `json:"tick"`
		Attacker *string  `json:"attacker"`
		Victim   *string  `json:"victim"`
		Weapon   *string  `json:"weapon"`
		VictimRX *float64 `json:"victim_rx"`
		VictimRY *float64 `json:"victim_ry"`
	}
	var kills []killMark
	krows, err := s.pg.Query(ctx, `
		SELECT k.tick, pa.nickname, pv.nickname, k.weapon, k.victim_x, k.victim_y
		FROM kills k
		LEFT JOIN players pa ON pa.player_id = k.attacker_id
		LEFT JOIN players pv ON pv.player_id = k.victim_id
		WHERE k.match_id = $1 AND k.round_number = $2 ORDER BY k.tick`, matchID, roundNo)
	if err == nil {
		for krows.Next() {
			var km killMark
			var vx, vy *float64
			if krows.Scan(&km.Tick, &km.Attacker, &km.Victim, &km.Weapon, &vx, &vy) == nil {
				if vx != nil && vy != nil {
					rx := (*vx - cal.PosX) / cal.Scale
					ry := (cal.PosY - *vy) / cal.Scale
					km.VictimRX, km.VictimRY = &rx, &ry
				}
				kills = append(kills, km)
			}
		}
		krows.Close()
	}

	// Rauntun bombaları: patlama anı + radar konumu (görsel ömür istemcide:
	// smoke ~20 sn, molotof ~7 sn, flash/he anlık patlama)
	type grenadeMark struct {
		Type    string   `json:"type"`
		Tick    int32    `json:"tick"`
		Side    *string  `json:"side"`
		Thrower *string  `json:"thrower"`
		RX      *float64 `json:"rx"`
		RY      *float64 `json:"ry"`
	}
	var grenades []grenadeMark
	grows, err := s.pg.Query(ctx, `
		SELECT g.type, g.detonate_tick, g.side, p.nickname, g.det_x, g.det_y
		FROM grenades g LEFT JOIN players p ON p.player_id = g.thrower_id
		WHERE g.match_id = $1 AND g.round_number = $2 AND g.detonate_tick IS NOT NULL
		ORDER BY g.detonate_tick`, matchID, roundNo)
	if err == nil {
		for grows.Next() {
			var gm grenadeMark
			var dx, dy *float64
			if grows.Scan(&gm.Type, &gm.Tick, &gm.Side, &gm.Thrower, &dx, &dy) == nil {
				if dx != nil && dy != nil {
					rx := (*dx - cal.PosX) / cal.Scale
					ry := (cal.PosY - *dy) / cal.Scale
					gm.RX, gm.RY = &rx, &ry
				}
				grenades = append(grenades, gm)
			}
		}
		grows.Close()
	}

	writeJSON(w, 200, map[string]any{
		"match_id": matchID, "map_name": mapName, "round_number": roundNo,
		"freeze_end_tick": freezeEnd, "tick_rate": tickRate,
		"radar": cal, "ticks": ticks, "players": players, "kills": kills,
		"grenades": grenades,
	})
}

// POST /api/v1/stack — Multi-View Stacking (§8.3): N rauntu hizalanmış katmanlar olarak döndür
func (s *server) stack(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Rounds []struct {
			MatchID     uuid.UUID `json:"match_id"`
			RoundNumber int16     `json:"round_number"`
		} `json:"rounds"`
		Align string `json:"align"` // round_start | bomb_plant | first_kill
		Side  string `json:"side,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, fmt.Errorf("JSON çözülemedi: %w", err))
		return
	}
	if len(req.Rounds) == 0 || len(req.Rounds) > 10 {
		writeErr(w, 400, fmt.Errorf("1-10 arası raunt gerekli"))
		return
	}
	switch req.Align {
	case "", "round_start":
		req.Align = "round_start"
	case "bomb_plant", "first_kill":
	default:
		writeErr(w, 400, fmt.Errorf("align: round_start | bomb_plant | first_kill"))
		return
	}
	if req.Side != "" && req.Side != "T" && req.Side != "CT" {
		writeErr(w, 400, fmt.Errorf("side: T | CT"))
		return
	}
	ctx := r.Context()

	type layer struct {
		MatchID     uuid.UUID `json:"match_id"`
		RoundNumber int16     `json:"round_number"`
		AlignTick   int32     `json:"align_tick"`
		Skipped     string    `json:"skipped,omitempty"` // hizalama olayı yoksa neden
		Players     []struct {
			Side string    `json:"side"`
			T    []float64 `json:"t"` // hizalama anına göre saniye
			RX   []float64 `json:"rx"`
			RY   []float64 `json:"ry"`
		} `json:"players,omitempty"`
	}

	var mapName string
	var layers []layer
	for _, rr := range req.Rounds {
		var m string
		var freezeEnd, plantTick *int32
		if err := s.pg.QueryRow(ctx, `
			SELECT mt.map_name, r.freeze_end_tick, r.bomb_plant_tick
			FROM rounds r JOIN matches mt ON mt.match_id = r.match_id
			WHERE r.match_id = $1 AND r.round_number = $2`,
			rr.MatchID, rr.RoundNumber).Scan(&m, &freezeEnd, &plantTick); err != nil {
			writeErr(w, 404, fmt.Errorf("raunt yok: %s/%d", rr.MatchID, rr.RoundNumber))
			return
		}
		if mapName == "" {
			mapName = m
		} else if mapName != m {
			writeErr(w, 400, fmt.Errorf("tüm rauntlar aynı haritadan olmalı (%s ≠ %s)", mapName, m))
			return
		}

		ly := layer{MatchID: rr.MatchID, RoundNumber: rr.RoundNumber}
		switch req.Align {
		case "round_start":
			if freezeEnd == nil {
				ly.Skipped = "freeze_end yok"
			} else {
				ly.AlignTick = *freezeEnd
			}
		case "bomb_plant":
			if plantTick == nil {
				ly.Skipped = "bomba kurulmamış"
			} else {
				ly.AlignTick = *plantTick
			}
		case "first_kill":
			var fk *int32
			_ = s.pg.QueryRow(ctx, `
				SELECT min(tick) FROM kills WHERE match_id = $1 AND round_number = $2`,
				rr.MatchID, rr.RoundNumber).Scan(&fk)
			if fk == nil {
				ly.Skipped = "kill yok"
			} else {
				ly.AlignTick = *fk
			}
		}
		layers = append(layers, ly)
	}

	cal, err := s.radarFor(ctx, mapName)
	if err != nil {
		writeErr(w, 500, err)
		return
	}

	for i := range layers {
		ly := &layers[i]
		if ly.Skipped != "" {
			continue
		}
		q := `SELECT player_id, side, tick, x, y FROM player_ticks
		      WHERE match_id = ? AND round_number = ? AND is_alive`
		args := []any{ly.MatchID, uint8(ly.RoundNumber)}
		if req.Side != "" {
			q += " AND side = ?"
			args = append(args, req.Side)
		}
		q += " ORDER BY player_id, tick"
		rows, err := s.ch.Query(ctx, q, args...)
		if err != nil {
			writeErr(w, 500, err)
			return
		}
		type track struct {
			side      string
			t, rx, ry []float64
		}
		tracks := map[uuid.UUID]*track{}
		for rows.Next() {
			var pid uuid.UUID
			var side string
			var tick uint32
			var x, y float32
			if err := rows.Scan(&pid, &side, &tick, &x, &y); err != nil {
				rows.Close()
				writeErr(w, 500, err)
				return
			}
			tr := tracks[pid]
			if tr == nil {
				tr = &track{side: side}
				tracks[pid] = tr
			}
			tr.t = append(tr.t, float64(int32(tick)-ly.AlignTick)/tickRate)
			tr.rx = append(tr.rx, (float64(x)-cal.PosX)/cal.Scale)
			tr.ry = append(tr.ry, (cal.PosY-float64(y))/cal.Scale)
		}
		rows.Close()
		for _, tr := range tracks {
			ly.Players = append(ly.Players, struct {
				Side string    `json:"side"`
				T    []float64 `json:"t"`
				RX   []float64 `json:"rx"`
				RY   []float64 `json:"ry"`
			}{tr.side, tr.t, tr.rx, tr.ry})
		}
	}

	writeJSON(w, 200, map[string]any{
		"map_name": mapName, "radar": cal, "align": req.Align, "layers": layers,
	})
}
