package dsl

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const tickRate = 64

// Engine, doğrulanmış DSL sorgularını parametrik SQL'e çevirip çalıştırır.
// LLM katmanı (Faz 3) yalnızca DSL üretir; SQL'e giden tek yol burasıdır (§6.1).
type Engine struct {
	PG *pgxpool.Pool
	CH driver.Conn
}

type Clip struct {
	MatchID     uuid.UUID `json:"match_id"`
	MapName     string    `json:"map_name"`
	RoundNumber int16     `json:"round_number"`
	Tick        int32     `json:"tick"`
	RoundTime   float32   `json:"round_time"`
	TickStart   int32     `json:"tick_start"`
	TickEnd     int32     `json:"tick_end"`
}

type RoundRef struct {
	MatchID     uuid.UUID `json:"match_id"`
	MapName     string    `json:"map_name"`
	RoundNumber int16     `json:"round_number"`
}

type Result struct {
	Intent     string     `json:"intent"`
	Clips      []Clip     `json:"clips,omitempty"`
	Rounds     []RoundRef `json:"rounds,omitempty"`
	Count      *int       `json:"count,omitempty"`
	RoundCount *int       `json:"round_count,omitempty"`
	PerRound   *float64   `json:"per_round,omitempty"`
	DurationMS int64      `json:"duration_ms"`
}

// sqlBuilder: $n parametreli WHERE koşulları biriktirir.
type sqlBuilder struct {
	conds []string
	args  []any
}

func (b *sqlBuilder) add(cond string, args ...any) {
	for _, a := range args {
		b.args = append(b.args, a)
		cond = strings.Replace(cond, "?", fmt.Sprintf("$%d", len(b.args)), 1)
	}
	b.conds = append(b.conds, cond)
}

func (b *sqlBuilder) where() string {
	if len(b.conds) == 0 {
		return "TRUE"
	}
	return strings.Join(b.conds, " AND ")
}

// RoundFilterSQL, heatmap endpoint'inin raunt kümesini aynı filtre
// mekanizmasından türetebilmesi için dışa açılır.
func RoundFilterSQL(f *Filters) (string, []any) { return roundFilter(f) }

// roundFilter: filtre boyutlarını rounds+matches üzerinde (match_id, round_number)
// kümesine indirger. Tüm intent'ler bu kümeden geçer.
func roundFilter(f *Filters) (string, []any) {
	b := &sqlBuilder{}
	if f.Map != "" {
		b.add("m.map_name = ?", f.Map)
	}
	if f.Source != "" {
		b.add("m.source = ?", f.Source)
	}
	if f.RoundNumber != nil {
		if f.RoundNumber.Min > 0 {
			b.add("r.round_number >= ?", f.RoundNumber.Min)
		}
		if f.RoundNumber.Max > 0 {
			b.add("r.round_number <= ?", f.RoundNumber.Max)
		}
	}
	if len(f.BuyType) > 0 {
		switch f.Side {
		case "T":
			b.add("r.t_buy_type = ANY(?)", f.BuyType)
		case "CT":
			b.add("r.ct_buy_type = ANY(?)", f.BuyType)
		default:
			b.args = append(b.args, f.BuyType, f.BuyType)
			b.conds = append(b.conds, fmt.Sprintf("(r.t_buy_type = ANY($%d) OR r.ct_buy_type = ANY($%d))", len(b.args)-1, len(b.args)))
		}
	}
	sql := `SELECT r.match_id, r.round_number, r.freeze_end_tick, m.map_name
	        FROM rounds r JOIN matches m ON m.match_id = r.match_id
	        WHERE m.status = 'ready' AND ` + b.where()
	return sql, b.args
}

func (e *Engine) resolvePlayer(ctx context.Context, p *PlayerScope) (uuid.UUID, error) {
	var id uuid.UUID
	var err error
	switch {
	case p.SteamID64 != 0:
		err = e.PG.QueryRow(ctx, "SELECT player_id FROM players WHERE steam_id64 = $1", p.SteamID64).Scan(&id)
	case p.Nickname != "":
		err = e.PG.QueryRow(ctx, "SELECT player_id FROM players WHERE nickname ILIKE $1 ORDER BY nickname LIMIT 1", p.Nickname).Scan(&id)
	default:
		return id, errors.New("player için nickname veya steam_id64 gerekli")
	}
	if err != nil {
		return id, fmt.Errorf("oyuncu bulunamadı: %w", err)
	}
	return id, nil
}

type moment struct {
	MatchID     uuid.UUID
	MapName     string
	RoundNumber int16
	Tick        int32
	RoundTime   float32
}

// Execute: DSL sorgusunu çalıştırır. Önce Validate çağrılmış olmalıdır.
func (e *Engine) Execute(ctx context.Context, q *Query) (*Result, error) {
	start := time.Now()
	res := &Result{Intent: q.Intent}

	roundsSQL, roundArgs := roundFilter(&q.Filters)

	if q.Intent == "heatmap_filterset" || q.Filters.Event == nil {
		// Yalnızca raunt kümesi: heatmap_filterset ve olay filtresiz aggregate
		refs, err := e.queryRounds(ctx, roundsSQL, roundArgs)
		if err != nil {
			return nil, err
		}
		n := len(refs)
		res.RoundCount = &n
		if q.Intent != "heatmap_filterset" && q.Output.Format == "rounds" {
			res.Rounds = refs
		}
		if q.Intent == "aggregate" {
			res.Count = &n
		}
		res.DurationMS = time.Since(start).Milliseconds()
		return res, nil
	}

	var moments []moment
	var roundCount int
	var err error
	ev := q.Filters.Event

	switch ev.Type {
	case "kill", "grenade", "bomb", "economy":
		moments, roundCount, err = e.pgMoments(ctx, q, roundsSQL, roundArgs)
	case "presence":
		moments, roundCount, err = e.presenceMoments(ctx, q, roundsSQL, roundArgs)
	default:
		return nil, fmt.Errorf("desteklenmeyen event.type: %s", ev.Type)
	}
	if err != nil {
		return nil, err
	}

	res.RoundCount = &roundCount
	switch q.Output.Format {
	case "clips":
		pre := int32(q.Output.ContextSeconds[0] * tickRate)
		post := int32(q.Output.ContextSeconds[1] * tickRate)
		for _, m := range moments {
			res.Clips = append(res.Clips, Clip{
				MatchID: m.MatchID, MapName: m.MapName, RoundNumber: m.RoundNumber,
				Tick: m.Tick, RoundTime: m.RoundTime,
				TickStart: max(0, m.Tick-pre), TickEnd: m.Tick + post,
			})
		}
	case "rounds":
		seen := map[string]bool{}
		for _, m := range moments {
			k := m.MatchID.String() + ":" + fmt.Sprint(m.RoundNumber)
			if !seen[k] {
				seen[k] = true
				res.Rounds = append(res.Rounds, RoundRef{MatchID: m.MatchID, MapName: m.MapName, RoundNumber: m.RoundNumber})
			}
		}
	case "aggregate":
		n := len(moments)
		res.Count = &n
		if q.Output.Metric == "per_round" && roundCount > 0 {
			pr := float64(n) / float64(roundCount)
			res.PerRound = &pr
		}
	}
	res.DurationMS = time.Since(start).Milliseconds()
	return res, nil
}

func (e *Engine) queryRounds(ctx context.Context, roundsSQL string, args []any) ([]RoundRef, error) {
	rows, err := e.PG.Query(ctx, roundsSQL, args...)
	if err != nil {
		return nil, fmt.Errorf("raunt filtresi: %w", err)
	}
	defer rows.Close()
	var out []RoundRef
	for rows.Next() {
		var r RoundRef
		var freeze *int32
		if err := rows.Scan(&r.MatchID, &r.RoundNumber, &freeze, &r.MapName); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// pgMoments: kill/grenade/bomb/economy olaylarını PG'de raunt kümesiyle kesiştirir.
func (e *Engine) pgMoments(ctx context.Context, q *Query, roundsSQL string, roundArgs []any) ([]moment, int, error) {
	ev := q.Filters.Event
	b := &sqlBuilder{args: append([]any{}, roundArgs...)}

	var eventSQL string
	switch ev.Type {
	case "kill":
		if q.Filters.Side != "" {
			// saldırganın tarafı raunt bazında PRS'ten çözülür (side-swap güvenli)
			b.add(`EXISTS (SELECT 1 FROM player_round_states s
			        WHERE s.match_id = k.match_id AND s.round_number = k.round_number
			          AND s.player_id = k.attacker_id AND s.side = ?)`, q.Filters.Side)
		}
		if ev.Weapon != "" {
			b.add("k.weapon = ?", ev.Weapon)
		}
		if ev.FirstKill != nil {
			b.add("k.is_first_kill = ?", *ev.FirstKill)
		}
		if ev.Trade != nil {
			b.add("k.is_trade = ?", *ev.Trade)
		}
		if ev.Headshot != nil {
			b.add("k.headshot = ?", *ev.Headshot)
		}
		if ev.Area != "" {
			col := "k.victim_place"
			if ev.AreaOf == "attacker" {
				col = "k.attacker_place"
			}
			b.add(col+" = ?", ev.Area)
		}
		if ev.TimeWindow != nil {
			b.add("k.round_time BETWEEN ? AND ?", ev.TimeWindow.From, ev.TimeWindow.To)
		}
		if q.Filters.Player != nil {
			pid, err := e.resolvePlayer(ctx, q.Filters.Player)
			if err != nil {
				return nil, 0, err
			}
			b.add("k.attacker_id = ?", pid)
		}
		eventSQL = `SELECT k.match_id, rs.map_name, k.round_number, k.tick, k.round_time
		            FROM kills k JOIN roundset rs
		              ON rs.match_id = k.match_id AND rs.round_number = k.round_number
		            WHERE ` + b.where() + ` ORDER BY k.match_id, k.round_number, k.tick`

	case "grenade":
		if q.Filters.Side != "" {
			b.add("g.side = ?", q.Filters.Side)
		}
		if ev.GrenadeType != "" {
			b.add("g.type = ?", ev.GrenadeType)
		}
		if ev.Order == "first_of_type_in_round" {
			b.add("g.is_first_of_type_in_round = TRUE")
		}
		if ev.TimeWindow != nil {
			b.add("(g.detonate_tick - rs.freeze_end_tick)::real / 64 BETWEEN ? AND ?", ev.TimeWindow.From, ev.TimeWindow.To)
		}
		if q.Filters.Player != nil {
			pid, err := e.resolvePlayer(ctx, q.Filters.Player)
			if err != nil {
				return nil, 0, err
			}
			b.add("g.thrower_id = ?", pid)
		}
		eventSQL = `SELECT g.match_id, rs.map_name, g.round_number, g.detonate_tick,
		                   GREATEST((g.detonate_tick - rs.freeze_end_tick)::real / 64, 0)
		            FROM grenades g JOIN roundset rs
		              ON rs.match_id = g.match_id AND rs.round_number = g.round_number
		            WHERE ` + b.where() + ` ORDER BY g.match_id, g.round_number, g.detonate_tick`

	case "bomb":
		if ev.Site != "" {
			b.add("r.bomb_site = ?", ev.Site)
		}
		var tickExpr string
		switch ev.BombAction {
		case "plant", "":
			b.add("r.bomb_plant_tick IS NOT NULL")
			tickExpr = "r.bomb_plant_tick"
		case "defuse":
			b.add("r.end_reason = 'bomb_defused'")
			tickExpr = "r.end_tick"
		case "explode":
			b.add("r.end_reason = 'bomb_exploded'")
			tickExpr = "r.end_tick"
		}
		if ev.TimeWindow != nil {
			b.add("("+tickExpr+" - rs.freeze_end_tick)::real / 64 BETWEEN ? AND ?", ev.TimeWindow.From, ev.TimeWindow.To)
		}
		eventSQL = `SELECT r.match_id, rs.map_name, r.round_number, ` + tickExpr + `,
		                   GREATEST((` + tickExpr + ` - rs.freeze_end_tick)::real / 64, 0)
		            FROM rounds r JOIN roundset rs
		              ON rs.match_id = r.match_id AND rs.round_number = r.round_number
		            WHERE ` + b.where() + ` ORDER BY r.match_id, r.round_number`

	case "economy":
		col := "r.t_equip_value"
		if q.Filters.Side == "CT" {
			col = "r.ct_equip_value"
		}
		if ev.EquipMin != nil {
			b.add(col+" >= ?", *ev.EquipMin)
		}
		if ev.EquipMax != nil {
			b.add(col+" <= ?", *ev.EquipMax)
		}
		eventSQL = `SELECT r.match_id, rs.map_name, r.round_number, rs.freeze_end_tick, 0::real
		            FROM rounds r JOIN roundset rs
		              ON rs.match_id = r.match_id AND rs.round_number = r.round_number
		            WHERE ` + b.where() + ` ORDER BY r.match_id, r.round_number`
	}

	// b, roundArgs ile başlatıldığından olay koşullarının $n'leri zaten
	// roundset parametrelerinin devamından numaralanır; ek kaydırma gerekmez.
	full := "WITH roundset AS (" + roundsSQL + ") " + eventSQL

	rows, err := e.PG.Query(ctx, full, b.args...)
	if err != nil {
		return nil, 0, fmt.Errorf("olay sorgusu: %w", err)
	}
	defer rows.Close()
	var out []moment
	for rows.Next() {
		var m moment
		if err := rows.Scan(&m.MatchID, &m.MapName, &m.RoundNumber, &m.Tick, &m.RoundTime); err != nil {
			return nil, 0, err
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	rc, err := e.countRounds(ctx, roundsSQL, roundArgs)
	return out, rc, err
}

func (e *Engine) countRounds(ctx context.Context, roundsSQL string, args []any) (int, error) {
	var n int
	err := e.PG.QueryRow(ctx, "SELECT count(*) FROM ("+roundsSQL+") x", args...).Scan(&n)
	return n, err
}

// presenceMoments: "bölgede ≥N oyuncu" — ClickHouse player_ticks.place üzerinden.
func (e *Engine) presenceMoments(ctx context.Context, q *Query, roundsSQL string, roundArgs []any) ([]moment, int, error) {
	ev := q.Filters.Event
	if q.Filters.Map == "" {
		return nil, 0, errors.New("presence sorgusu için map zorunlu (place adları haritaya özgü)")
	}
	refs, err := e.queryRounds(ctx, roundsSQL, roundArgs)
	if err != nil {
		return nil, 0, err
	}
	allowed := make(map[string]bool, len(refs))
	for _, r := range refs {
		allowed[r.MatchID.String()+":"+fmt.Sprint(r.RoundNumber)] = true
	}

	conds := []string{"map_name = ?", "place = ?", "is_alive"}
	args := []any{q.Filters.Map, ev.Area}
	if q.Filters.Side != "" {
		conds = append(conds, "side = ?")
		args = append(args, q.Filters.Side)
	}
	if ev.TimeWindow != nil {
		conds = append(conds, "round_time BETWEEN ? AND ?")
		args = append(args, ev.TimeWindow.From, ev.TimeWindow.To)
	}
	args = append(args, ev.MinPlayers)

	chSQL := `
	SELECT match_id, round_number, min(tick) AS t, min(round_time) AS rt
	FROM (
	    SELECT match_id, round_number, tick, round_time,
	           uniqExact(player_id) AS n
	    FROM player_ticks
	    WHERE ` + strings.Join(conds, " AND ") + `
	    GROUP BY match_id, round_number, tick, round_time
	    HAVING n >= ?
	)
	GROUP BY match_id, round_number
	ORDER BY match_id, round_number`

	rows, err := e.CH.Query(ctx, chSQL, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("presence (CH): %w", err)
	}
	defer rows.Close()
	var out []moment
	for rows.Next() {
		var m moment
		var rn uint8
		var tick uint32
		if err := rows.Scan(&m.MatchID, &rn, &tick, &m.RoundTime); err != nil {
			return nil, 0, err
		}
		m.RoundNumber = int16(rn)
		m.Tick = int32(tick)
		m.MapName = q.Filters.Map
		if allowed[m.MatchID.String()+":"+fmt.Sprint(m.RoundNumber)] {
			out = append(out, m)
		}
	}
	return out, len(refs), rows.Err()
}
