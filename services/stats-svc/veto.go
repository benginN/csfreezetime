// Veto simülasyonu: iki takımın arşiv harita güçlerinden rasyonel ban/pick.
// Güç = büzülmüş raunt kazanma oranı (k=20 → az veri 0.5'e çekilir).
// Ajan kuralı: ban = göreli en kötü haritan (rakip avantajını kes),
// pick = göreli en iyin. Harita kazanma olasılığı dürüst bir sezgiseldir
// (raunt-oranı farkının doğrusal ölçeği) ve öyle etiketlenir.
package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"

	"github.com/google/uuid"
)

const vetoShrinkK = 20.0

func (s *server) mapStrengths(teamID uuid.UUID) (map[string]float64, map[string]int, error) {
	rows, err := s.pg.Query(context.Background(), `
		SELECT m.map_name,
		       count(*) FILTER (WHERE (r.winner_side = 'T') = (r.t_team_id = $1)) AS wins,
		       count(*) AS rounds
		FROM rounds r
		JOIN matches m ON m.match_id = r.match_id AND m.status = 'ready'
		WHERE (r.t_team_id = $1 OR r.ct_team_id = $1) AND r.winner_side IS NOT NULL
		GROUP BY m.map_name`, teamID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	st := map[string]float64{}
	n := map[string]int{}
	for rows.Next() {
		var mapName string
		var wins, rounds int
		if rows.Scan(&mapName, &wins, &rounds) == nil {
			st[mapName] = (float64(wins) + vetoShrinkK*0.5) / (float64(rounds) + vetoShrinkK)
			n[mapName] = rounds
		}
	}
	return st, n, nil
}

// GET /api/v1/veto?a=&b=&format=bo3
func (s *server) vetoSim(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	a, errA := uuid.Parse(q.Get("a"))
	b, errB := uuid.Parse(q.Get("b"))
	if errA != nil || errB != nil {
		writeErr(w, 400, fmt.Errorf("a and b team ids are required"))
		return
	}
	format := q.Get("format")
	if format == "" {
		format = "bo3"
	}

	sa, na, err := s.mapStrengths(a)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	sb, nb, err := s.mapStrengths(b)
	if err != nil {
		writeErr(w, 500, err)
		return
	}

	// havuz: iki takımdan en az birinin oynadığı haritalar (en aktif 7)
	type poolMap struct {
		name   string
		total  int
		sA, sB float64
	}
	seen := map[string]bool{}
	var pool []poolMap
	for m := range sa {
		seen[m] = true
	}
	for m := range sb {
		seen[m] = true
	}
	str := func(st map[string]float64, m string) float64 {
		if v, ok := st[m]; ok {
			return v
		}
		return 0.5 // veri yok → nötr
	}
	for m := range seen {
		pool = append(pool, poolMap{m, na[m] + nb[m], str(sa, m), str(sb, m)})
	}
	sort.Slice(pool, func(i, j int) bool { return pool[i].total > pool[j].total })
	if len(pool) > 7 {
		pool = pool[:7]
	}
	if len(pool) < 3 {
		writeErr(w, 422, fmt.Errorf("not enough shared map data for a veto simulation"))
		return
	}

	// veto sırası
	var order []string // "banA","banB","pickA","pickB","decider"
	switch format {
	case "bo1":
		order = []string{"banA", "banB", "banA", "banB", "banA", "banB", "decider"}
	case "bo5":
		order = []string{"banA", "banB", "pickA", "pickB", "pickA", "pickB", "decider"}
	default: // bo3
		order = []string{"banA", "banB", "pickA", "pickB", "banA", "banB", "decider"}
	}

	remaining := append([]poolMap{}, pool...)
	take := func(best func(p poolMap) float64) poolMap {
		bi := 0
		for i, p := range remaining {
			if best(p) > best(remaining[bi]) {
				bi = i
			}
		}
		p := remaining[bi]
		remaining = append(remaining[:bi], remaining[bi+1:]...)
		return p
	}
	edge := func(p poolMap) float64 { return p.sA - p.sB } // A lehine fark

	type step struct {
		Action string  `json:"action"`
		Map    string  `json:"map"`
		Edge   float64 `json:"edge"` // A lehine raunt-oranı farkı
		N      int     `json:"n"`
	}
	var steps []step
	var picks []step
	for _, o := range order {
		if len(remaining) == 0 {
			break
		}
		var p poolMap
		switch o {
		case "banA":
			p = take(func(x poolMap) float64 { return -edge(x) }) // A: en kötüsünü at
		case "banB":
			p = take(func(x poolMap) float64 { return edge(x) }) // B: A'nın en iyisini at
		case "pickA":
			p = take(edge)
		case "pickB":
			p = take(func(x poolMap) float64 { return -edge(x) })
		case "decider":
			p = remaining[0]
			remaining = remaining[:0]
		}
		st := step{Action: o, Map: p.name, Edge: edge(p), N: na[p.name] + nb[p.name]}
		steps = append(steps, st)
		if o == "pickA" || o == "pickB" || o == "decider" {
			picks = append(picks, st)
		}
	}

	// harita kazanma sezgiseli: 0.5 + fark×3, [0.15, 0.85] kelepçeli
	type finalMap struct {
		Map   string  `json:"map"`
		ProbA float64 `json:"prob_a"`
		Edge  float64 `json:"edge"`
		N     int     `json:"n"`
	}
	finals := []finalMap{}
	for _, p := range picks {
		prob := 0.5 + p.Edge*3
		if prob > 0.85 {
			prob = 0.85
		}
		if prob < 0.15 {
			prob = 0.15
		}
		finals = append(finals, finalMap{p.Map, prob, p.Edge, p.N})
	}

	writeJSON(w, 200, map[string]any{
		"format": format,
		"pool":   len(pool),
		"steps":  steps,
		"finals": finals,
		"note":   "strengths are shrunk round-win rates (k=20); map win prob is a linear heuristic on the edge, clamped to 15-85%",
	})
}
