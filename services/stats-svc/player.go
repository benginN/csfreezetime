// Oyuncu profili: roller + harita bazlı performans + bayraklar + maçlar.
// Isı haritası ayrı endpoint'ten (heatCells yardımcısıyla, arşiv geneli).
package main

import (
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// GET /api/v1/players/{id}/profile
func (s *server) playerProfile(w http.ResponseWriter, r *http.Request) {
	playerID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 400, fmt.Errorf("invalid player_id"))
		return
	}
	ctx := r.Context()

	var nick string
	var teamName *string
	if err := s.pg.QueryRow(ctx, `
		SELECT p.nickname, t.name FROM players p
		LEFT JOIN teams t ON t.team_id = p.current_team_id
		WHERE p.player_id = $1`, playerID).Scan(&nick, &teamName); err != nil {
		writeErr(w, 404, fmt.Errorf("player not found"))
		return
	}

	out := map[string]any{"player_id": playerID, "nickname": nick, "team": teamName}

	// roller: (taraf, harita) başına satır; map_name='' = genel profil.
	// İstemci harita seçiciyle süzer — "ANCHOR:B ama hangi harita?" bitti.
	out["roles"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY x.map_name, x.side DESC), '[]'::json) FROM (
		    SELECT side, map_name, rounds, entry_attempt_share, entry_success,
		           opening_kills, opening_deaths, lurk_dist_avg,
		           anchor_place, anchor_share, awp_round_share,
		           util_per_round, flash_assists_pr, adr, tags
		    FROM player_roles WHERE player_id = $1
		) x`, playerID)

	// harita bazlı performans (PRS + kills; taraftan bağımsız toplam)
	out["maps"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY x.rounds DESC), '[]'::json) FROM (
		    SELECT m.map_name,
		           count(*) AS rounds,
		           count(DISTINCT s.match_id) AS matches,
		           round(COALESCE(sum(s.damage_dealt), 0)::numeric / count(*), 1) AS adr,
		           COALESCE(sum(s.kills), 0) AS kills,
		           COALESCE(sum(s.deaths), 0) AS deaths,
		           COALESCE(sum(s.assists), 0) AS assists,
		           round(100.0 * count(*) FILTER (WHERE s.survived) / count(*), 0) AS survival_pct
		    FROM player_round_states s
		    JOIN matches m ON m.match_id = s.match_id AND m.status = 'ready'
		    WHERE s.player_id = $1
		    GROUP BY m.map_name
		) x`, playerID)

	// açılış düelloları harita bazında (kills.is_first_kill)
	out["openings"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x), '[]'::json) FROM (
		    SELECT m.map_name,
		           count(*) FILTER (WHERE k.attacker_id = $1) AS won,
		           count(*) FILTER (WHERE k.victim_id = $1) AS lost
		    FROM kills k JOIN matches m ON m.match_id = k.match_id AND m.status='ready'
		    WHERE k.is_first_kill AND (k.attacker_id = $1 OR k.victim_id = $1)
		    GROUP BY m.map_name
		) x`, playerID)

	// flash etkinliği (taraf başına; flash_remaining sıçramalarından türetilmiş)
	out["flash"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x), '[]'::json) FROM (
		    SELECT g.side, count(*) AS thrown,
		           COALESCE(sum(g.enemies_flashed), 0) AS enemies,
		           COALESCE(sum(g.teammates_flashed), 0) AS teammates,
		           round((sum(g.total_enemy_blind_time)
		                  / NULLIF(sum(g.enemies_flashed), 0))::numeric, 1) AS avg_blind
		    FROM grenades g JOIN matches m ON m.match_id = g.match_id AND m.status='ready'
		    WHERE g.thrower_id = $1 AND g.type = 'flash'
		    GROUP BY g.side ORDER BY g.side DESC
		) x`, playerID)

	// utility hasarı: HE / ateş — bomba başına ortalama (taraf bazlı)
	out["util_dmg"] = s.jsonQuery(ctx, `
		WITH dmg AS (
		    SELECT s.side, sum(s.util_he_dmg) AS he_dmg, sum(s.util_fire_dmg) AS fire_dmg
		    FROM player_round_states s
		    JOIN matches m ON m.match_id = s.match_id AND m.status = 'ready'
		    WHERE s.player_id = $1 GROUP BY s.side
		),
		nades AS (
		    SELECT g.side,
		           count(*) FILTER (WHERE g.type = 'he') AS he_n,
		           count(*) FILTER (WHERE g.type = 'molotov') AS fire_n
		    FROM grenades g
		    JOIN matches m ON m.match_id = g.match_id AND m.status = 'ready'
		    WHERE g.thrower_id = $1 GROUP BY g.side
		)
		SELECT COALESCE(json_agg(x), '[]'::json) FROM (
		    SELECT d.side, d.he_dmg, d.fire_dmg, n.he_n, n.fire_n
		    FROM dmg d JOIN nades n USING (side) ORDER BY d.side DESC
		) x`, playerID)

	// trade davranışı: yaptığı trade'ler + kendi ölümlerinin trade edilme oranı
	out["trades"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x), '[]'::json) FROM (
		    SELECT s.side,
		           count(*) FILTER (WHERE k.attacker_id = $1 AND k.is_trade) AS made
		    FROM kills k
		    JOIN matches m ON m.match_id = k.match_id AND m.status = 'ready'
		    JOIN player_round_states s ON (s.match_id, s.round_number, s.player_id)
		         = (k.match_id, k.round_number, $1::uuid)
		    WHERE k.attacker_id = $1
		    GROUP BY s.side
		) x`, playerID)
	out["deaths_traded"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x), '[]'::json) FROM (
		    SELECT sv.side,
		           count(*) AS deaths,
		           count(*) FILTER (WHERE EXISTS (
		               SELECT 1 FROM kills k2
		               WHERE k2.match_id = k1.match_id AND k2.round_number = k1.round_number
		                 AND k2.victim_id = k1.attacker_id AND k2.is_trade
		                 AND k2.tick >= k1.tick AND k2.tick - k1.tick <= 320)) AS traded
		    FROM kills k1
		    JOIN matches m ON m.match_id = k1.match_id AND m.status = 'ready'
		    JOIN player_round_states sv ON (sv.match_id, sv.round_number, sv.player_id)
		         = (k1.match_id, k1.round_number, k1.victim_id)
		    WHERE k1.victim_id = $1
		    GROUP BY sv.side
		) x`, playerID)

	// clutch istatistikleri (1vX): X başına deneme/kazanım + anlar
	out["clutches"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY x.versus), '[]'::json) FROM (
		    SELECT versus, count(*) AS attempts,
		           count(*) FILTER (WHERE won) AS wins
		    FROM clutches WHERE player_id = $1 GROUP BY versus
		) x`, playerID)
	// kazanılanlar önce (highlight sayfası karamsar olmasın), sonra zorluk
	out["clutch_moments"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY x.won DESC, x.versus DESC), '[]'::json) FROM (
		    SELECT c.match_id, c.round_number, c.versus, c.won, c.start_sec, m.map_name
		    FROM clutches c JOIN matches m ON m.match_id = c.match_id
		    WHERE c.player_id = $1
		    ORDER BY c.won DESC, c.versus DESC LIMIT 12
		) x`, playerID)

	// çok kill'li rauntlar (3k/4k/ace) — "notable moments"in parlak yüzü
	out["big_rounds"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY x.kills DESC, x.played_at DESC), '[]'::json) FROM (
		    SELECT s.match_id, s.round_number, s.kills, s.side,
		           m.map_name, m.played_at::date AS played_at
		    FROM player_round_states s
		    JOIN matches m ON m.match_id = s.match_id AND m.status = 'ready'
		    WHERE s.player_id = $1 AND s.kills >= 3
		    ORDER BY s.kills DESC, m.played_at DESC LIMIT 12
		) x`, playerID)

	// anomali bayrakları (kanıtlı)
	out["flags"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY abs(x.z) DESC), '[]'::json) FROM (
		    SELECT f.metric, f.value, f.baseline_mean, f.baseline_std, f.z,
		           m.event_name, m.map_name, f.match_id
		    FROM anomaly_flags f JOIN matches m ON m.match_id = f.match_id
		    WHERE f.player_id = $1
		) x`, playerID)

	writeJSON(w, 200, out)
}

// GET /api/v1/leaderboards — arşiv geneli oyuncu sıralamaları.
// Her metrik n taşır; MIN_ROUNDS altı listelenmez (§10).
func (s *server) leaderboards(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	const minRounds = 50
	out := map[string]any{"min_rounds": minRounds}
	out["adr"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY x.adr DESC), '[]'::json) FROM (
		    SELECT p.nickname, p.player_id, t.name AS team,
		           round(sum(s.damage_dealt)::numeric / count(*), 1) AS adr,
		           count(*) AS rounds
		    FROM player_round_states s
		    JOIN matches m ON m.match_id = s.match_id AND m.status = 'ready'
		    JOIN players p ON p.player_id = s.player_id
		    LEFT JOIN teams t ON t.team_id = p.current_team_id
		    GROUP BY p.nickname, p.player_id, t.name
		    HAVING count(*) >= `+fmt.Sprint(minRounds)+`
		    LIMIT 20
		) x`)
	out["openings"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY x.diff DESC), '[]'::json) FROM (
		    SELECT p.nickname, p.player_id, t.name AS team,
		           count(*) FILTER (WHERE k.attacker_id = p.player_id) AS won,
		           count(*) FILTER (WHERE k.victim_id = p.player_id) AS lost,
		           count(*) FILTER (WHERE k.attacker_id = p.player_id)
		             - count(*) FILTER (WHERE k.victim_id = p.player_id) AS diff
		    FROM kills k
		    JOIN matches m ON m.match_id = k.match_id AND m.status = 'ready'
		    JOIN players p ON p.player_id IN (k.attacker_id, k.victim_id)
		    LEFT JOIN teams t ON t.team_id = p.current_team_id
		    WHERE k.is_first_kill
		    GROUP BY p.nickname, p.player_id, t.name
		    HAVING count(*) >= 15
		    LIMIT 20
		) x`)
	out["clutch"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY x.wins DESC, x.rate DESC), '[]'::json) FROM (
		    SELECT p.nickname, p.player_id, t.name AS team,
		           count(*) FILTER (WHERE c.won) AS wins,
		           count(*) AS attempts,
		           round(100.0 * count(*) FILTER (WHERE c.won) / count(*)) AS rate
		    FROM clutches c
		    JOIN players p ON p.player_id = c.player_id
		    LEFT JOIN teams t ON t.team_id = p.current_team_id
		    GROUP BY p.nickname, p.player_id, t.name
		    HAVING count(*) >= 8
		    LIMIT 20
		) x`)
	out["flash"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY x.per_flash DESC), '[]'::json) FROM (
		    SELECT p.nickname, p.player_id, t.name AS team,
		           count(*) AS thrown,
		           round(sum(g.enemies_flashed)::numeric / count(*), 2) AS per_flash
		    FROM grenades g
		    JOIN matches m ON m.match_id = g.match_id AND m.status = 'ready'
		    JOIN players p ON p.player_id = g.thrower_id
		    LEFT JOIN teams t ON t.team_id = p.current_team_id
		    WHERE g.type = 'flash'
		    GROUP BY p.nickname, p.player_id, t.name
		    HAVING count(*) >= 30
		    LIMIT 20
		) x`)
	out["trades"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY x.trades DESC), '[]'::json) FROM (
		    SELECT p.nickname, p.player_id, t.name AS team,
		           count(*) AS trades
		    FROM kills k
		    JOIN matches m ON m.match_id = k.match_id AND m.status = 'ready'
		    JOIN players p ON p.player_id = k.attacker_id
		    LEFT JOIN teams t ON t.team_id = p.current_team_id
		    WHERE k.is_trade
		    GROUP BY p.nickname, p.player_id, t.name
		    HAVING count(*) >= 10
		    LIMIT 20
		) x`)
	writeJSON(w, 200, out)
}

// GET /api/v1/winprob — durum→olasılık tablosu (istemci canlı eğri çizer).
func (s *server) winprobTable(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"cells": s.jsonQuery(r.Context(), `
			SELECT COALESCE(json_agg(x), '[]'::json) FROM (
			    SELECT alive_t, alive_ct, bomb, tbucket, p, n FROM winprob_table
			) x`),
	})
}

// GET /api/v1/players/{id}/heatmap?map&side=T&t0&t1 — arşiv geneli.
func (s *server) playerHeatmap(w http.ResponseWriter, r *http.Request) {
	playerID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 400, fmt.Errorf("invalid player_id"))
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
	// oyuncunun o haritada o tarafta oynadığı rauntlar (PRS üzerinden)
	prows, err := s.pg.Query(ctx, `
		SELECT r.match_id, r.round_number, COALESCE(r.freeze_end_tick, r.start_tick), r.end_tick
		FROM player_round_states s
		JOIN rounds r ON (r.match_id, r.round_number) = (s.match_id, s.round_number)
		JOIN matches m ON m.match_id = s.match_id AND m.status = 'ready'
		WHERE s.player_id = $1 AND s.side = $2 AND m.map_name = $3`,
		playerID, side, mapName)
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
	// ?awp=1: yalnız AWP taşırken alınan pozisyonlar (sunucu-tanımlı koşul)
	extra := ""
	if q.Get("awp") == "1" {
		extra = "has(inventory, 'AWP')"
	}
	cells, cellsLower, err := s.heatCells(ctx, cal, mapName, windows, side, &playerID, extra)
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
