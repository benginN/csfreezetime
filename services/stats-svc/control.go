// Harita kontrolü → raunt sonucu korelasyonu (Skybox'ın "Cheetah'a girince
// raunt 3× daha sık B'de bitiyor" içgörüsünün karşılığı). T tarafının
// 12-35 sn penceresinde ≥2 oyuncuyla girdiği bölgeler, raundun bittiği
// site ile eşlenir; takımın genel site karışımına göre kaldıraç (lift)
// hesaplanır. Ham sayım — model yok; her satır n taşır.
package main

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// GET /api/v1/teams/{id}/control?map=&since=&roster_min=
func (s *server) teamControl(w http.ResponseWriter, r *http.Request) {
	teamID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 400, fmt.Errorf("invalid team_id"))
		return
	}
	mapName := r.URL.Query().Get("map")
	if mapName == "" {
		writeErr(w, 400, fmt.Errorf("map is required"))
		return
	}
	ctx := r.Context()
	since := r.URL.Query().Get("since")
	rosterMin, _ := strconv.Atoi(r.URL.Query().Get("roster_min"))
	elig := s.eligibleMatches(ctx, teamID, since, rosterMin)

	// 1) PG: takımın T rauntları + bitiş site'ı ('' = plant yok)
	rows, err := s.pg.Query(ctx, `
		SELECT r.match_id::text, r.round_number, COALESCE(r.bomb_site, '')
		FROM rounds r JOIN matches m ON m.match_id = r.match_id AND m.status = 'ready'
		WHERE m.map_name = $2 AND r.t_team_id = $1 AND r.winner_side IS NOT NULL
		  AND ($3::text[] IS NULL OR m.match_id::text = ANY($3::text[]))`,
		teamID, mapName, elig)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	site := map[string]string{} // "mid:rn" → site
	for rows.Next() {
		var mid string
		var rn int16
		var st string
		if rows.Scan(&mid, &rn, &st) == nil {
			site[fmt.Sprintf("%s:%d", mid, rn)] = st
		}
	}
	rows.Close()
	if len(site) == 0 {
		writeJSON(w, 200, map[string]any{"rows": []any{}, "rounds": 0})
		return
	}

	// takımın genel site karışımı (taban çizgi)
	base := map[string]int{}
	for _, st := range site {
		base[st]++
	}
	total := len(site)

	// 2) CH: harita kontrol penceresinde (12-35 sn) bölge başına ≥2 oyuncu
	chRows, err := s.ch.Query(ctx, `
		SELECT toString(match_id), round_number, place
		FROM player_ticks
		WHERE map_name = $1 AND side = 'T' AND is_alive AND place != ''
		  AND round_time >= 12 AND round_time <= 35
		GROUP BY match_id, round_number, place
		HAVING uniqExact(player_id) >= 2`, mapName)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer chRows.Close()
	type acc struct{ n, a, b, none int }
	byPlace := map[string]*acc{}
	for chRows.Next() {
		var mid, place string
		var rn uint8
		if chRows.Scan(&mid, &rn, &place) != nil {
			continue
		}
		if strings.Contains(strings.ToLower(place), "spawn") {
			continue // spawn bilgi taşımaz
		}
		st, ok := site[fmt.Sprintf("%s:%d", mid, rn)]
		if !ok {
			continue // başka takımın/başka pencerenin raundu
		}
		p := byPlace[place]
		if p == nil {
			p = &acc{}
			byPlace[place] = p
		}
		p.n++
		switch st {
		case "A":
			p.a++
		case "B":
			p.b++
		default:
			p.none++
		}
	}

	type outRow struct {
		Place  string  `json:"place"`
		N      int     `json:"n"`
		AShare float64 `json:"a_share"`
		BShare float64 `json:"b_share"`
		NoneSh float64 `json:"none_share"`
		LiftA  float64 `json:"lift_a"` // takım ortalamasına göre kat
		LiftB  float64 `json:"lift_b"`
	}
	baseA := float64(base["A"]) / float64(total)
	baseB := float64(base["B"]) / float64(total)
	out := []outRow{}
	for place, p := range byPlace {
		if p.n < 8 {
			continue // ince veri gizlenir (§10)
		}
		a := float64(p.a) / float64(p.n)
		b := float64(p.b) / float64(p.n)
		row := outRow{Place: place, N: p.n,
			AShare: a, BShare: b, NoneSh: float64(p.none) / float64(p.n)}
		if baseA > 0.02 {
			row.LiftA = a / baseA
		}
		if baseB > 0.02 {
			row.LiftB = b / baseB
		}
		out = append(out, row)
	}
	// en bilgilendirici (kaldıracı 1'den en uzak) üstte
	sort.Slice(out, func(i, j int) bool {
		di := maxf(absf(out[i].LiftA-1), absf(out[i].LiftB-1))
		dj := maxf(absf(out[j].LiftA-1), absf(out[j].LiftB-1))
		return di > dj
	})
	if len(out) > 14 {
		out = out[:14]
	}
	writeJSON(w, 200, map[string]any{
		"rows": out, "rounds": total,
		"base_a": baseA, "base_b": baseB,
	})
}

func absf(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}
func maxf(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}
