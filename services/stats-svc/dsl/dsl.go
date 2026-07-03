// Package dsl: doğrulanmış DSL sorguları ve tipleri (schema.json ile birebir).
package dsl

import (
	"errors"
	"fmt"
	"slices"
)

type Query struct {
	Intent  string  `json:"intent"`
	Filters Filters `json:"filters"`
	Output  Output  `json:"output"`
}

type Filters struct {
	Map         string       `json:"map,omitempty"`
	Side        string       `json:"side,omitempty"`
	BuyType     []string     `json:"buy_type,omitempty"`
	RoundNumber *IntRange    `json:"round_number,omitempty"`
	Source      string       `json:"source,omitempty"`
	Player      *PlayerScope `json:"player,omitempty"`
	Event       *Event       `json:"event,omitempty"`
}

type IntRange struct {
	Min int `json:"min,omitempty"`
	Max int `json:"max,omitempty"`
}

type PlayerScope struct {
	Nickname  string `json:"nickname,omitempty"`
	SteamID64 int64  `json:"steam_id64,omitempty"`
}

type Event struct {
	Type string `json:"type"`

	// kill
	Weapon    string `json:"weapon,omitempty"`
	FirstKill *bool  `json:"first_kill,omitempty"`
	Trade     *bool  `json:"trade,omitempty"`
	Headshot  *bool  `json:"headshot,omitempty"`
	Area      string `json:"area,omitempty"`
	AreaOf    string `json:"area_of,omitempty"` // attacker|victim (default victim)

	// grenade
	GrenadeType string `json:"grenade_type,omitempty"`
	Order       string `json:"order,omitempty"`

	// bomb
	BombAction string `json:"bomb_action,omitempty"`
	Site       string `json:"site,omitempty"`

	// presence
	MinPlayers int `json:"min_players,omitempty"`

	// economy
	EquipMin *int `json:"equip_min,omitempty"`
	EquipMax *int `json:"equip_max,omitempty"`

	TimeWindow *TimeWindow `json:"time_window,omitempty"`
}

type TimeWindow struct {
	From float64 `json:"from"`
	To   float64 `json:"to"`
}

type Output struct {
	Format         string    `json:"format,omitempty"`
	ContextSeconds []float64 `json:"context_seconds,omitempty"`
	Metric         string    `json:"metric,omitempty"`
}

var (
	intents    = []string{"find_moments", "aggregate", "heatmap_filterset"}
	sides      = []string{"T", "CT"}
	buyTypes   = []string{"pistol", "eco", "semi", "force", "full"}
	sources    = []string{"scrim", "official", "faceit"}
	eventTypes = []string{"kill", "grenade", "bomb", "presence", "economy"}
	grenTypes  = []string{"flash", "smoke", "he", "molotov", "incendiary", "decoy"}
	bombActs   = []string{"plant", "defuse", "explode"}
	formats    = []string{"clips", "rounds", "aggregate"}
	metrics    = []string{"count", "per_round"}
)

// Validate, schema.json'un Go karşılığıdır; şemaya uymayan sorgu derlenmez.
func (q *Query) Validate() error {
	if !slices.Contains(intents, q.Intent) {
		return fmt.Errorf("geçersiz intent: %q", q.Intent)
	}
	f := &q.Filters
	if f.Side != "" && !slices.Contains(sides, f.Side) {
		return fmt.Errorf("geçersiz side: %q", f.Side)
	}
	for _, b := range f.BuyType {
		if !slices.Contains(buyTypes, b) {
			return fmt.Errorf("geçersiz buy_type: %q", b)
		}
	}
	if f.Source != "" && !slices.Contains(sources, f.Source) {
		return fmt.Errorf("geçersiz source: %q", f.Source)
	}
	e := f.Event
	if e != nil {
		if !slices.Contains(eventTypes, e.Type) {
			return fmt.Errorf("geçersiz event.type: %q", e.Type)
		}
		if e.GrenadeType != "" && !slices.Contains(grenTypes, e.GrenadeType) {
			return fmt.Errorf("geçersiz grenade_type: %q", e.GrenadeType)
		}
		if e.Order != "" && e.Order != "first_of_type_in_round" {
			return fmt.Errorf("geçersiz order: %q", e.Order)
		}
		if e.BombAction != "" && !slices.Contains(bombActs, e.BombAction) {
			return fmt.Errorf("geçersiz bomb_action: %q", e.BombAction)
		}
		if e.Site != "" && e.Site != "A" && e.Site != "B" {
			return fmt.Errorf("geçersiz site: %q", e.Site)
		}
		if e.AreaOf != "" && e.AreaOf != "attacker" && e.AreaOf != "victim" {
			return fmt.Errorf("geçersiz area_of: %q", e.AreaOf)
		}
		if e.Type == "presence" {
			if e.Area == "" {
				return errors.New("presence için area zorunlu")
			}
			if e.MinPlayers == 0 {
				e.MinPlayers = 1
			}
		}
		if e.Type == "economy" {
			if e.EquipMin == nil && e.EquipMax == nil {
				return errors.New("economy için equip_min veya equip_max zorunlu")
			}
			if f.Side == "" {
				return errors.New("economy için side zorunlu (eşik taraf ekipmanına uygulanır)")
			}
		}
	}
	if q.Intent == "find_moments" && e == nil {
		return errors.New("find_moments için filters.event zorunlu")
	}
	o := &q.Output
	if o.Format == "" {
		if q.Intent == "aggregate" {
			o.Format = "aggregate"
		} else {
			o.Format = "clips"
		}
	}
	if !slices.Contains(formats, o.Format) {
		return fmt.Errorf("geçersiz output.format: %q", o.Format)
	}
	if o.Metric == "" {
		o.Metric = "count"
	}
	if !slices.Contains(metrics, o.Metric) {
		return fmt.Errorf("geçersiz output.metric: %q", o.Metric)
	}
	if len(o.ContextSeconds) == 0 {
		o.ContextSeconds = []float64{5, 8}
	}
	if len(o.ContextSeconds) != 2 || o.ContextSeconds[0] < 0 || o.ContextSeconds[1] < 0 {
		return errors.New("context_seconds [önce, sonra] iki pozitif sayı olmalı")
	}
	return nil
}
