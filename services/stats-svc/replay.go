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
	"strings"

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
		writeErr(w, 400, fmt.Errorf("invalid match_id"))
		return
	}
	ctx := r.Context()

	var mapName *string
	var status string
	var teamAID, teamBID *uuid.UUID
	var teamA, teamB, tournament *string
	if err := s.pg.QueryRow(ctx, `
		SELECT m.map_name, m.status, m.team_a_id, ta.name, m.team_b_id, tb.name, m.tournament
		FROM matches m
		LEFT JOIN teams ta ON ta.team_id = m.team_a_id
		LEFT JOIN teams tb ON tb.team_id = m.team_b_id
		WHERE m.match_id = $1`, matchID).
		Scan(&mapName, &status, &teamAID, &teamA, &teamBID, &teamB, &tournament); err != nil {
		writeErr(w, 404, fmt.Errorf("match not found"))
		return
	}

	type roundRow struct {
		RoundNumber   int16      `json:"round_number"`
		StartTick     *int32     `json:"start_tick"`
		FreezeEndTick *int32     `json:"freeze_end_tick"`
		EndTick       *int32     `json:"end_tick"`
		WinnerSide    *string    `json:"winner_side"`
		EndReason     *string    `json:"end_reason"`
		BombSite      *string    `json:"bomb_site"`
		BombPlantTick *int32     `json:"bomb_plant_tick"`
		TBuy          *string    `json:"t_buy_type"`
		CTBuy         *string    `json:"ct_buy_type"`
		TCluster      *int16     `json:"t_cluster"`
		CTCluster     *int16     `json:"ct_cluster"`
		TTeamID       *uuid.UUID `json:"t_team_id"`
		CTTeamID      *uuid.UUID `json:"ct_team_id"`
	}
	rows, err := s.pg.Query(ctx, `
		SELECT round_number, start_tick, freeze_end_tick, end_tick, winner_side,
		       end_reason, bomb_site, bomb_plant_tick, t_buy_type, ct_buy_type,
		       t_strategy_cluster, ct_strategy_cluster, t_team_id, ct_team_id
		FROM rounds WHERE match_id = $1 ORDER BY round_number`, matchID)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	rounds := []roundRow{}
	for rows.Next() {
		var x roundRow
		if err := rows.Scan(&x.RoundNumber, &x.StartTick, &x.FreezeEndTick, &x.EndTick,
			&x.WinnerSide, &x.EndReason, &x.BombSite, &x.BombPlantTick, &x.TBuy, &x.CTBuy,
			&x.TCluster, &x.CTCluster, &x.TTeamID, &x.CTTeamID); err != nil {
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
		Assister    *string `json:"assister"`
		Weapon      *string `json:"weapon"`
		Headshot    *bool   `json:"headshot"`
	}
	krows, err := s.pg.Query(ctx, `
		SELECT k.round_number, k.tick, k.round_time,
		       pa.nickname, pv.nickname, ps.nickname, k.weapon, k.headshot
		FROM kills k
		LEFT JOIN players pa ON pa.player_id = k.attacker_id
		LEFT JOIN players pv ON pv.player_id = k.victim_id
		LEFT JOIN players ps ON ps.player_id = k.assister_id
		WHERE k.match_id = $1 ORDER BY k.round_number, k.tick`, matchID)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer krows.Close()
	kills := []killRow{}
	for krows.Next() {
		var x killRow
		if err := krows.Scan(&x.RoundNumber, &x.Tick, &x.RoundTime,
			&x.Attacker, &x.Victim, &x.Assister, &x.Weapon, &x.Headshot); err != nil {
			writeErr(w, 500, err)
			return
		}
		kills = append(kills, x)
	}
	writeJSON(w, 200, map[string]any{
		"match_id": matchID, "map_name": mapName, "status": status,
		"team_a_id": teamAID, "team_a": teamA,
		"team_b_id": teamBID, "team_b": teamB, "tournament": tournament,
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
	Armor  []*int32   `json:"armor"`
	Alive  []*bool    `json:"alive"`
	Weapon []*string  `json:"weapon"`
	Inv    [][]string `json:"inv"`             // eldeki tüm silahlar
	Flash  []*float64 `json:"flash"`           // kalan körlük süresi (sn)
	Lower  []*bool    `json:"lower,omitempty"` // çok katlı haritada alt kat mı
	Shots  []int32    `json:"shots"`           // atış tick'leri (ateş animasyonu)
	Money  []*int32   `json:"money"`           // tick bazlı canlı para
	WZ     []*float64 `json:"wz"`              // dünya z (setpos için)
	Pitch  []*float64 `json:"pitch"`           // bakış dikeyi (setang için)
	// raunt başı ekonomi (PRS'ten; canlı para takibi tick verisinde yok)
	MoneyStart *int32 `json:"money_start"`
	EquipValue *int32 `json:"equip_value"`
}

// GET /api/v1/rounds/{match_id}/{n}/ticks — rauntun tüm 16 Hz akışı, radar koordinatlı
func (s *server) roundTicks(w http.ResponseWriter, r *http.Request) {
	matchID, err := uuid.Parse(chi.URLParam(r, "match_id"))
	if err != nil {
		writeErr(w, 400, fmt.Errorf("invalid match_id"))
		return
	}
	roundNo, err := strconv.Atoi(chi.URLParam(r, "n"))
	if err != nil || roundNo < 1 || roundNo > 255 {
		writeErr(w, 400, fmt.Errorf("invalid round number"))
		return
	}
	ctx := r.Context()

	// saklama: 24 ay üstü maçların tick verisi silinmiştir (meta durur)
	var purged bool
	_ = s.pg.QueryRow(ctx,
		"SELECT tick_purged FROM matches WHERE match_id = $1", matchID).Scan(&purged)
	if purged {
		writeErr(w, 410, fmt.Errorf("this match is archived: replay data older than the retention window was removed; stats remain available"))
		return
	}

	var mapName string
	var freezeEnd *int32
	if err := s.pg.QueryRow(ctx, `
		SELECT m.map_name, r.freeze_end_tick FROM rounds r
		JOIN matches m ON m.match_id = r.match_id
		WHERE r.match_id = $1 AND r.round_number = $2`, matchID, roundNo).
		Scan(&mapName, &freezeEnd); err != nil {
		writeErr(w, 404, fmt.Errorf("round not found"))
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
		SELECT tick, player_id, side, x, y, z, yaw, pitch, health, armor, is_alive,
		       active_weapon, flash_remaining, inventory, money
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
		wz, pitch   float64
		hp, armor   int32
		money       int32
		alive       bool
		lower       bool
		weapon      string
		flash       float64
		inv         []string
	}
	perPlayer := map[uuid.UUID]map[uint32]sample{}
	sides := map[uuid.UUID]string{}
	for chRows.Next() {
		var tick uint32
		var pid uuid.UUID
		var side, weapon string
		var x, y, z, yaw, pitch, flash float32
		var hp, armor uint8
		var alive bool
		var inv []string
		var money int32
		if err := chRows.Scan(&tick, &pid, &side, &x, &y, &z, &yaw, &pitch, &hp, &armor, &alive, &weapon, &flash, &inv, &money); err != nil {
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
			yaw: float64(yaw), wz: float64(z), pitch: float64(pitch),
			hp: int32(hp), armor: int32(armor), money: money,
			alive: alive, lower: lower,
			weapon: weapon, flash: float64(flash), inv: inv,
		}
	}
	if len(tickSet) == 0 {
		writeErr(w, 404, fmt.Errorf("no tick data for this round"))
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
			Armor: make([]*int32, len(ticks)), Money: make([]*int32, len(ticks)),
			WZ: make([]*float64, len(ticks)), Pitch: make([]*float64, len(ticks)),
			Alive:  make([]*bool, len(ticks)),
			Weapon: make([]*string, len(ticks)), Inv: make([][]string, len(ticks)),
			Flash: make([]*float64, len(ticks)),
		}
		if cal.HasLower {
			tr.Lower = make([]*bool, len(ticks))
		}
		for i, t := range ticks {
			if sm, ok := samples[t]; ok {
				rx, ry, yaw, hp, armor, alive, lower := sm.rx, sm.ry, sm.yaw, sm.hp, sm.armor, sm.alive, sm.lower
				weapon, flash := sm.weapon, sm.flash
				tr.RX[i], tr.RY[i], tr.Yaw[i] = &rx, &ry, &yaw
				money := sm.money
				wz, pitch := sm.wz, sm.pitch
				tr.HP[i], tr.Armor[i], tr.Alive[i] = &hp, &armor, &alive
				tr.Money[i] = &money
				tr.WZ[i], tr.Pitch[i] = &wz, &pitch
				tr.Weapon[i], tr.Flash[i] = &weapon, &flash
				tr.Inv[i] = sm.inv
				if cal.HasLower {
					tr.Lower[i] = &lower
				}
			}
		}
		players = append(players, tr)
	}
	// Silah atış tick'leri (ateş animasyonu)
	shotsBy := map[uuid.UUID][]int32{}
	if srows, err := s.ch.Query(ctx, `
		SELECT player_id, tick FROM shots
		WHERE match_id = ? AND round_number = ? ORDER BY tick`,
		matchID, uint8(roundNo)); err == nil {
		for srows.Next() {
			var pid uuid.UUID
			var tk uint32
			if srows.Scan(&pid, &tk) == nil {
				shotsBy[pid] = append(shotsBy[pid], int32(tk))
			}
		}
		srows.Close()
	}
	for i := range players {
		if s := shotsBy[players[i].PlayerID]; s != nil {
			players[i].Shots = s
		} else {
			players[i].Shots = []int32{}
		}
	}

	// Raunt başı ekonomi (PRS)
	econRows, err := s.pg.Query(ctx, `
		SELECT player_id, money_start, equip_value FROM player_round_states
		WHERE match_id = $1 AND round_number = $2`, matchID, roundNo)
	econ := map[uuid.UUID][2]*int32{}
	if err == nil {
		for econRows.Next() {
			var pid uuid.UUID
			var ms, ev *int32
			if econRows.Scan(&pid, &ms, &ev) == nil {
				econ[pid] = [2]*int32{ms, ev}
			}
		}
		econRows.Close()
	}
	for i := range players {
		if e, ok := econ[players[i].PlayerID]; ok {
			players[i].MoneyStart, players[i].EquipValue = e[0], e[1]
		}
	}

	sort.Slice(players, func(i, j int) bool {
		if players[i].Side != players[j].Side {
			return players[i].Side < players[j].Side
		}
		return players[i].Nickname < players[j].Nickname
	})

	// Rauntun kill'leri (zaman çubuğu işaretleri + radar konumları)
	lowerFlag := func(z *float64) *bool {
		if z == nil || !cal.HasLower || cal.SplitZ == nil {
			return nil
		}
		l := *z < *cal.SplitZ
		return &l
	}

	type killMark struct {
		Tick     int32    `json:"tick"`
		Attacker *string  `json:"attacker"`
		Victim   *string  `json:"victim"`
		Weapon   *string  `json:"weapon"`
		VictimRX *float64 `json:"victim_rx"`
		VictimRY *float64 `json:"victim_ry"`
		Lower    *bool    `json:"lower,omitempty"`
	}
	kills := []killMark{}
	krows, err := s.pg.Query(ctx, `
		SELECT k.tick, pa.nickname, pv.nickname, k.weapon, k.victim_x, k.victim_y, k.victim_z
		FROM kills k
		LEFT JOIN players pa ON pa.player_id = k.attacker_id
		LEFT JOIN players pv ON pv.player_id = k.victim_id
		WHERE k.match_id = $1 AND k.round_number = $2 ORDER BY k.tick`, matchID, roundNo)
	if err == nil {
		for krows.Next() {
			var km killMark
			var vx, vy, vz *float64
			if krows.Scan(&km.Tick, &km.Attacker, &km.Victim, &km.Weapon, &vx, &vy, &vz) == nil {
				if vx != nil && vy != nil {
					rx := (*vx - cal.PosX) / cal.Scale
					ry := (cal.PosY - *vy) / cal.Scale
					km.VictimRX, km.VictimRY = &rx, &ry
					km.Lower = lowerFlag(vz)
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
		Lower   *bool    `json:"lower,omitempty"`
		// atış animasyonu için: fırlatma anı + radar konumu
		ThrowTick  *int32   `json:"throw_tick"`
		ThrowRX    *float64 `json:"throw_rx"`
		ThrowRY    *float64 `json:"throw_ry"`
		ThrowLower *bool    `json:"throw_lower,omitempty"`
	}
	grenades := []grenadeMark{}
	grows, err := s.pg.Query(ctx, `
		SELECT g.type, g.detonate_tick, g.side, p.nickname, g.det_x, g.det_y, g.det_z,
		       g.throw_tick, g.throw_x, g.throw_y, g.throw_z
		FROM grenades g LEFT JOIN players p ON p.player_id = g.thrower_id
		WHERE g.match_id = $1 AND g.round_number = $2 AND g.detonate_tick IS NOT NULL
		ORDER BY g.detonate_tick`, matchID, roundNo)
	if err == nil {
		for grows.Next() {
			var gm grenadeMark
			var dx, dy, dz, tx, ty, tz *float64
			if grows.Scan(&gm.Type, &gm.Tick, &gm.Side, &gm.Thrower, &dx, &dy, &dz,
				&gm.ThrowTick, &tx, &ty, &tz) == nil {
				if dx != nil && dy != nil {
					rx := (*dx - cal.PosX) / cal.Scale
					ry := (cal.PosY - *dy) / cal.Scale
					gm.RX, gm.RY = &rx, &ry
					gm.Lower = lowerFlag(dz)
				}
				if tx != nil && ty != nil {
					trx := (*tx - cal.PosX) / cal.Scale
					try := (cal.PosY - *ty) / cal.Scale
					gm.ThrowRX, gm.ThrowRY = &trx, &try
					gm.ThrowLower = lowerFlag(tz)
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
// stackPlayer: hayalet iz + hover bilgileri. Envanter, değişim anları
// olarak kodlanır (inv_t: saniye, inv_v: o andan itibaren geçerli liste) —
// tam örnekleme payload'ı şişirirdi.
type stackPlayer struct {
	Side  string    `json:"side"`
	Nick  string    `json:"nick"`
	T     []float64 `json:"t"` // hizalama anına göre saniye
	RX    []float64 `json:"rx"`
	RY    []float64 `json:"ry"`
	Lower []bool    `json:"lower,omitempty"` // çok katlı haritada örnek başına kat
	HP    []int32   `json:"hp"`
	Armor []int32   `json:"armor"`
	Money []int32   `json:"money"`
	InvT  []float64 `json:"inv_t"`
	InvV  []string  `json:"inv_v"`
}

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
		writeErr(w, 400, fmt.Errorf("could not parse JSON: %w", err))
		return
	}
	if len(req.Rounds) == 0 || len(req.Rounds) > 30 {
		writeErr(w, 400, fmt.Errorf("between 1 and 30 rounds required"))
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
		MatchID     uuid.UUID     `json:"match_id"`
		RoundNumber int16         `json:"round_number"`
		AlignTick   int32         `json:"align_tick"`
		Skipped     string        `json:"skipped,omitempty"` // hizalama olayı yoksa neden
		Players     []stackPlayer `json:"players,omitempty"`
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
			writeErr(w, 400, fmt.Errorf("all rounds must be from the same map (%s ≠ %s)", mapName, m))
			return
		}

		ly := layer{MatchID: rr.MatchID, RoundNumber: rr.RoundNumber}
		switch req.Align {
		case "round_start":
			if freezeEnd == nil {
				ly.Skipped = "no freeze end"
			} else {
				ly.AlignTick = *freezeEnd
			}
		case "bomb_plant":
			if plantTick == nil {
				ly.Skipped = "no bomb plant"
			} else {
				ly.AlignTick = *plantTick
			}
		case "first_kill":
			var fk *int32
			_ = s.pg.QueryRow(ctx, `
				SELECT min(tick) FROM kills WHERE match_id = $1 AND round_number = $2`,
				rr.MatchID, rr.RoundNumber).Scan(&fk)
			if fk == nil {
				ly.Skipped = "no kills"
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

	// Oyuncu kimlikleri (oyuncu filtresi için nick)
	nicks := map[uuid.UUID]string{}
	{
		ids := make([]uuid.UUID, 0, len(req.Rounds))
		seen := map[uuid.UUID]bool{}
		for _, rr := range req.Rounds {
			if !seen[rr.MatchID] {
				seen[rr.MatchID] = true
				ids = append(ids, rr.MatchID)
			}
		}
		nrows, err := s.pg.Query(ctx, `
			SELECT DISTINCT p.player_id, p.nickname
			FROM player_round_states s JOIN players p ON p.player_id = s.player_id
			WHERE s.match_id = ANY($1)`, ids)
		if err == nil {
			for nrows.Next() {
				var id uuid.UUID
				var n string
				if nrows.Scan(&id, &n) == nil {
					nicks[id] = n
				}
			}
			nrows.Close()
		}
	}

	for i := range layers {
		ly := &layers[i]
		if ly.Skipped != "" {
			continue
		}
		q := `SELECT player_id, side, tick, x, y, z,
		             health, armor, money, inventory
		      FROM player_ticks
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
			side, nick string
			t, rx, ry  []float64
			lower      []bool
			hp, armor  []int32
			money      []int32
			invT       []float64
			invV       []string
		}
		tracks := map[uuid.UUID]*track{}
		for rows.Next() {
			var pid uuid.UUID
			var side string
			var tick uint32
			var x, y, z float32
			var hp, armor uint8
			var money int32
			var inv []string
			if err := rows.Scan(&pid, &side, &tick, &x, &y, &z, &hp, &armor, &money, &inv); err != nil {
				rows.Close()
				writeErr(w, 500, err)
				return
			}
			tr := tracks[pid]
			if tr == nil {
				tr = &track{side: side, nick: nicks[pid]}
				tracks[pid] = tr
			}
			ts := float64(int32(tick)-ly.AlignTick) / tickRate
			tr.t = append(tr.t, ts)
			tr.hp = append(tr.hp, int32(hp))
			tr.armor = append(tr.armor, int32(armor))
			tr.money = append(tr.money, money)
			joined := strings.Join(inv, ", ")
			if len(tr.invV) == 0 || tr.invV[len(tr.invV)-1] != joined {
				tr.invT = append(tr.invT, ts)
				tr.invV = append(tr.invV, joined)
			}
			tr.rx = append(tr.rx, (float64(x)-cal.PosX)/cal.Scale)
			tr.ry = append(tr.ry, (cal.PosY-float64(y))/cal.Scale)
			if cal.HasLower && cal.SplitZ != nil {
				tr.lower = append(tr.lower, float64(z) < *cal.SplitZ)
			}
		}
		rows.Close()
		for _, tr := range tracks {
			ly.Players = append(ly.Players, stackPlayer{
				Side: tr.side, Nick: tr.nick, T: tr.t, RX: tr.rx, RY: tr.ry,
				Lower: tr.lower, HP: tr.hp, Armor: tr.armor, Money: tr.money,
				InvT: tr.invT, InvV: tr.invV,
			})
		}
	}

	writeJSON(w, 200, map[string]any{
		"map_name": mapName, "radar": cal, "align": req.Align, "layers": layers,
	})
}
