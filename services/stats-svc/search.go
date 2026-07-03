// Global arama: takım/oyuncu adı token'larıyla maç bulma.
// "spirit g2" → iki takımın karşılaşmaları; "donk" → oyuncunun maçları.
package main

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

type searchMatch struct {
	MatchID  uuid.UUID `json:"match_id"`
	MapName  *string   `json:"map_name"`
	Name     *string   `json:"name"`
	TeamA    *string   `json:"team_a"`
	TeamB    *string   `json:"team_b"`
	ScoreA   int       `json:"score_a"`
	ScoreB   int       `json:"score_b"`
	PlayedAt *string   `json:"played_at"`
}

// GET /api/v1/search?q=... → {teams, players, matches}
// Her token; takım adı, oyuncu adı, harita ya da dosya adında aranır —
// maç, TÜM token'ları karşılıyorsa listelenir (iki takım yazınca kesişim).
func (s *server) search(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	ctx := r.Context()

	tokens := strings.Fields(strings.ToLower(q))
	if len(tokens) > 6 {
		tokens = tokens[:6]
	}

	// Eşleşen takım/oyuncu listeleri (arama önerileri için)
	type hit struct {
		ID   uuid.UUID `json:"id"`
		Name string    `json:"name"`
	}
	var teams, players []hit
	if q != "" {
		trows, err := s.pg.Query(ctx,
			"SELECT team_id, name FROM teams WHERE lower(name) LIKE '%'||$1||'%' LIMIT 8",
			strings.ToLower(q))
		if err == nil {
			for trows.Next() {
				var h hit
				if trows.Scan(&h.ID, &h.Name) == nil {
					teams = append(teams, h)
				}
			}
			trows.Close()
		}
		prows, err := s.pg.Query(ctx,
			"SELECT player_id, nickname FROM players WHERE lower(nickname) LIKE '%'||$1||'%' LIMIT 8",
			strings.ToLower(q))
		if err == nil {
			for prows.Next() {
				var h hit
				if prows.Scan(&h.ID, &h.Name) == nil {
					players = append(players, h)
				}
			}
			prows.Close()
		}
	}

	// Maçlar: her token en az bir alanda geçmeli (takım adları, oyuncular,
	// harita, dosya adı). Oyuncu eşleşmesi PRS üzerinden maça bağlanır.
	sql := `
	SELECT m.match_id, m.map_name, m.event_name, ta.name, tb.name,
	       count(*) FILTER (WHERE (r.winner_side='T'  AND r.t_team_id  = m.team_a_id)
	                            OR (r.winner_side='CT' AND r.ct_team_id = m.team_a_id)) AS score_a,
	       count(*) FILTER (WHERE (r.winner_side='T'  AND r.t_team_id  = m.team_b_id)
	                            OR (r.winner_side='CT' AND r.ct_team_id = m.team_b_id)) AS score_b,
	       to_char(m.played_at, 'YYYY-MM-DD') AS played
	FROM matches m
	LEFT JOIN rounds r ON r.match_id = m.match_id
	LEFT JOIN teams ta ON ta.team_id = m.team_a_id
	LEFT JOIN teams tb ON tb.team_id = m.team_b_id
	WHERE m.status = 'ready'`
	args := []any{}
	for _, tok := range tokens {
		args = append(args, tok)
		n := len(args)
		sql += ` AND (
		    lower(coalesce(ta.name,'')) LIKE '%'||$` + itoa(n) + `||'%'
		 OR lower(coalesce(tb.name,'')) LIKE '%'||$` + itoa(n) + `||'%'
		 OR lower(coalesce(m.map_name,'')) LIKE '%'||$` + itoa(n) + `||'%'
		 OR lower(coalesce(m.event_name,'')) LIKE '%'||$` + itoa(n) + `||'%'
		 OR EXISTS (SELECT 1 FROM player_round_states s
		            JOIN players p ON p.player_id = s.player_id
		            WHERE s.match_id = m.match_id
		              AND lower(p.nickname) LIKE '%'||$` + itoa(n) + `||'%'))`
	}
	sql += `
	GROUP BY m.match_id, m.map_name, m.event_name, ta.name, tb.name, m.played_at
	ORDER BY m.played_at DESC NULLS LAST, m.event_name
	LIMIT 60`

	rows, err := s.pg.Query(ctx, sql, args...)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer rows.Close()
	var matches []searchMatch
	for rows.Next() {
		var m searchMatch
		if err := rows.Scan(&m.MatchID, &m.MapName, &m.Name, &m.TeamA, &m.TeamB,
			&m.ScoreA, &m.ScoreB, &m.PlayedAt); err != nil {
			writeErr(w, 500, err)
			return
		}
		matches = append(matches, m)
	}
	writeJSON(w, 200, map[string]any{"teams": teams, "players": players, "matches": matches})
}

func itoa(n int) string { return strconv.Itoa(n) }
