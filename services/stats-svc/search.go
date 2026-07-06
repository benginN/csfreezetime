// Global arama: takım/oyuncu adı token'larıyla maç bulma.
// "spirit g2" → iki takımın karşılaşmaları; "donk" → oyuncunun maçları.
package main

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

type searchMatch struct {
	MatchID    uuid.UUID `json:"match_id"`
	MapName    *string   `json:"map_name"`
	Name       *string   `json:"name"`
	Tournament *string   `json:"tournament"`
	TeamA      *string   `json:"team_a"`
	TeamB      *string   `json:"team_b"`
	ScoreA     int       `json:"score_a"`
	ScoreB     int       `json:"score_b"`
	PlayedAt   *string   `json:"played_at"`
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
	// boş dilimler JSON'da null değil [] olmalı — istemci .length okuyor
	teams, players := []hit{}, []hit{}
	type tourHit struct {
		Name    string `json:"name"`
		Matches int    `json:"matches"`
	}
	tours := []tourHit{}
	if q == "" {
		// boş sorgu = ana sayfa: turnuva şeridi için tüm etiketler,
		// en güncel etkinlik önde
		xrows, err := s.pg.Query(ctx,
			`SELECT tournament, count(*) FROM matches
			 WHERE status = 'ready' AND tournament IS NOT NULL
			 GROUP BY tournament ORDER BY max(played_at) DESC NULLS LAST`)
		if err == nil {
			for xrows.Next() {
				var t tourHit
				if xrows.Scan(&t.Name, &t.Matches) == nil {
					tours = append(tours, t)
				}
			}
			xrows.Close()
		}
	}
	if q != "" {
		// turnuva önerileri: kullanıcı boşlukla yazar ("iem cologne"),
		// etiket tireli — iki taraf da boşluk-normalize edilerek eşlenir
		xrows, err := s.pg.Query(ctx,
			`SELECT tournament, count(*) FROM matches
			 WHERE status = 'ready' AND tournament IS NOT NULL
			   AND replace(lower(tournament),'-',' ') LIKE '%'||replace(lower($1),'-',' ')||'%'
			 GROUP BY tournament ORDER BY count(*) DESC LIMIT 6`, q)
		if err == nil {
			for xrows.Next() {
				var t tourHit
				if xrows.Scan(&t.Name, &t.Matches) == nil {
					tours = append(tours, t)
				}
			}
			xrows.Close()
		}
		trows, err := s.pg.Query(ctx,
			`SELECT t.team_id, t.name FROM teams t
			 WHERE lower(t.name) LIKE '%'||$1||'%'
			   AND EXISTS (SELECT 1 FROM matches m
			               WHERE (m.team_a_id = t.team_id OR m.team_b_id = t.team_id)
			                 AND m.status = 'ready') LIMIT 8`,
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
			`SELECT p.player_id, p.nickname FROM players p
			 WHERE lower(p.nickname) LIKE '%'||$1||'%'
			   AND EXISTS (SELECT 1 FROM player_round_states s2
			               JOIN matches m ON m.match_id = s2.match_id AND m.status = 'ready'
			               WHERE s2.player_id = p.player_id) LIMIT 8`,
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
	WITH q AS (
	SELECT m.match_id, m.map_name, m.event_name, m.tournament,
	       ta.name AS name_a, tb.name AS name_b,
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
		// 1-2 harflik token alt-dize aramasında her şeyle eşleşir ve yazdıkça
		// sonuç "donmuş" görünürdü. Kısa token: TÜM alanlarda KELİME BAŞI
		// eşleşir (regex \m; tire kelime ayıracıdır) — "g2" → G2 Esports,
		// "stage 1"deki "1" → turnuva adındaki "stage-1". Girdi regex-
		// metakarakterlerine karşı QuoteMeta'lanır.
		if len([]rune(tok)) <= 2 {
			// salt sayısal token TAM kelime eşleşir (arg regex parçasıdır:
			// "2\M" → \m2\M) — "2", stage-2'deki "2"yi bulur, "2026"ya takılmaz
			if _, err := strconv.Atoi(tok); err == nil {
				args = append(args, regexp.QuoteMeta(tok)+`\M`)
			} else {
				args = append(args, regexp.QuoteMeta(tok))
			}
			n := itoa(len(args))
			sql += ` AND (
			    coalesce(ta.name,'') ~* ('\m'||$` + n + `)
			 OR coalesce(tb.name,'') ~* ('\m'||$` + n + `)
			 OR coalesce(m.map_name,'') ~* ('\m'||$` + n + `)
			 OR coalesce(m.event_name,'') ~* ('\m'||$` + n + `)
			 OR coalesce(m.tournament,'') ~* ('\m'||$` + n + `)
			 OR EXISTS (SELECT 1 FROM player_round_states s
			            JOIN players p ON p.player_id = s.player_id
			            WHERE s.match_id = m.match_id
			              AND p.nickname ~* ('\m'||$` + n + `)))`
			continue
		}
		args = append(args, tok)
		n := len(args)
		sql += ` AND (
		    lower(coalesce(ta.name,'')) LIKE '%'||$` + itoa(n) + `||'%'
		 OR lower(coalesce(tb.name,'')) LIKE '%'||$` + itoa(n) + `||'%'
		 OR lower(coalesce(m.map_name,'')) LIKE '%'||$` + itoa(n) + `||'%'
		 OR lower(coalesce(m.event_name,'')) LIKE '%'||$` + itoa(n) + `||'%'
	 OR lower(coalesce(m.tournament,'')) LIKE '%'||$` + itoa(n) + `||'%'
		 OR EXISTS (SELECT 1 FROM player_round_states s
		            JOIN players p ON p.player_id = s.player_id
		            WHERE s.match_id = m.match_id
		              AND lower(p.nickname) LIKE '%'||$` + itoa(n) + `||'%'))`
	}
	// Sınır harita satırına değil KARŞILAŞMAYA (seri) uygulanır — aynı
	// gruplamayı Home.tsx groupSeries yapar: taban ad ("a-vs-b", -mN
	// öncesi) + turnuva + gün. Desene uymayan satır kendi başına bir
	// karşılaşmadır. Böylece son seri listenin dibinde ortadan kesilmez.
	sql += `
	GROUP BY m.match_id, m.map_name, m.event_name, m.tournament, ta.name, tb.name, m.played_at
	),
	k AS (
	    SELECT q.*, COALESCE(
	        substring(q.event_name from '^(.+-vs-.+)-m[0-9]+-')
	          || '|' || coalesce(q.tournament, '') || '|' || coalesce(q.played, ''),
	        q.match_id::text) AS skey
	    FROM q
	),
	w AS (
	    SELECT k.*, max(k.played) OVER (PARTITION BY k.skey) AS skey_played FROM k
	),
	r AS (
	    SELECT w.*, dense_rank() OVER (ORDER BY w.skey_played DESC NULLS LAST, w.skey) AS rnk FROM w
	)
	SELECT match_id, map_name, event_name, tournament, name_a, name_b,
	       score_a, score_b, played
	FROM r WHERE rnk <= 100
	ORDER BY played DESC NULLS LAST, event_name`

	rows, err := s.pg.Query(ctx, sql, args...)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer rows.Close()
	matches := []searchMatch{}
	for rows.Next() {
		var m searchMatch
		if err := rows.Scan(&m.MatchID, &m.MapName, &m.Name, &m.Tournament, &m.TeamA, &m.TeamB,
			&m.ScoreA, &m.ScoreB, &m.PlayedAt); err != nil {
			writeErr(w, 500, err)
			return
		}
		matches = append(matches, m)
	}
	// p1/p2 demo parçaları ayrı satırdır; toplamda tek maç sayılır
	// (parça birleştirme yol haritasında — o gelince FILTER'lar sadeleşir)
	var total int
	_ = s.pg.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE event_name !~ '-p[0-9]+$')
		     + count(DISTINCT (tournament, regexp_replace(event_name, '-p[0-9]+$', '')))
		         FILTER (WHERE event_name ~ '-p[0-9]+$')
		FROM matches WHERE status = 'ready'`).Scan(&total)
	writeJSON(w, 200, map[string]any{
		"teams": teams, "players": players, "tournaments": tours,
		"matches": matches, "total": total,
	})
}

func itoa(n int) string { return strconv.Itoa(n) }
