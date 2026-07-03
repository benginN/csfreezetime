// stats-svc: DSL→SQL sorgu motoru + ısı haritası agregat API'si (mimari.md §9).
package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	chdriver "github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"cs2-platform/stats-svc/dsl"
)

//go:embed static/index.html
var staticFS embed.FS

//go:embed dsl/schema.json
var schemaJSON []byte

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("env eksik: %s", key)
	}
	return v
}

func main() {
	ctx := context.Background()

	pg, err := pgxpool.New(ctx, mustEnv("POSTGRES_URL"))
	if err != nil {
		log.Fatalf("PostgreSQL: %v", err)
	}

	ch, err := clickhouse.Open(&clickhouse.Options{
		Addr: []string{envOr("CLICKHOUSE_NATIVE_ADDR", "localhost:9000")},
		Auth: clickhouse.Auth{
			Database: mustEnv("CLICKHOUSE_DB"),
			Username: mustEnv("CLICKHOUSE_USER"),
			Password: mustEnv("CLICKHOUSE_PASSWORD"),
		},
	})
	if err != nil {
		log.Fatalf("ClickHouse: %v", err)
	}
	if err := ch.Ping(ctx); err != nil {
		log.Fatalf("ClickHouse ping: %v", err)
	}

	engine := &dsl.Engine{PG: pg, CH: ch}
	srv := &server{pg: pg, ch: ch, engine: engine}

	r := chi.NewRouter()
	r.Use(middleware.Recoverer, middleware.Logger)
	r.Get("/debug", srv.index) // gömülü tek dosyalık test sayfası
	r.Get("/api/v1/schema", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write(schemaJSON)
	})
	r.Get("/api/v1/teams", srv.teams)
	r.Get("/api/v1/teams/{id}/tendencies", srv.teamTendencies)
	r.Get("/api/v1/players/{id}/flags", srv.playerFlags)
	r.Get("/api/v1/predict", srv.predictHandler)
	r.Get("/api/v1/clusters", srv.clusters)
	r.Patch("/api/v1/clusters/{map}/{side}/{id}", srv.renameCluster)
	r.Get("/api/v1/matches", srv.matches)
	r.Get("/api/v1/matches/{id}", srv.matchDetail)
	r.Get("/api/v1/rounds/{match_id}/{n}/ticks", srv.roundTicks)
	r.Get("/api/v1/heatmap", srv.heatmap)
	r.Get("/api/v1/maplayout", srv.mapLayoutHandler)
	// Kullanıcının kendi oyun dosyalarından çıkardığı radar görselleri
	// (opsiyonel; yoksa istemci veri silüetine düşer)
	radarDir := envOr("STATS_RADAR_DIR", "services/stats-svc/static/radars")
	r.Handle("/radars/*", http.StripPrefix("/radars/", http.FileServer(http.Dir(radarDir))))
	r.Post("/api/v1/query", srv.query)
	r.Post("/api/v1/stack", srv.stack)

	// SPA (apps/web/dist): dosya varsa onu, yoksa index.html'i döndür
	// (client-side routing); dist yoksa kök, test sayfasına düşer.
	webDist := envOr("STATS_WEB_DIST", "apps/web/dist")
	if st, err := os.Stat(webDist); err == nil && st.IsDir() {
		fileServer := http.FileServer(http.Dir(webDist))
		r.Get("/*", func(w http.ResponseWriter, req *http.Request) {
			p := filepath.Join(webDist, filepath.Clean(req.URL.Path))
			if info, err := os.Stat(p); err == nil && !info.IsDir() {
				fileServer.ServeHTTP(w, req)
				return
			}
			http.ServeFile(w, req, filepath.Join(webDist, "index.html"))
		})
		log.Printf("SPA servis ediliyor: %s", webDist)
	} else {
		r.Get("/", srv.index)
		log.Printf("SPA dist yok (%s); kökte test sayfası", webDist)
	}

	addr := envOr("STATS_ADDR", ":8090")
	log.Printf("stats-svc hazır: http://localhost%s", addr)
	log.Fatal(http.ListenAndServe(addr, r))
}

type server struct {
	pg     *pgxpool.Pool
	ch     chdriver.Conn
	engine *dsl.Engine
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func (s *server) index(w http.ResponseWriter, r *http.Request) {
	data, _ := staticFS.ReadFile("static/index.html")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(data)
}

func (s *server) matches(w http.ResponseWriter, r *http.Request) {
	// Opsiyonel takım filtresi (?team_id=)
	cond, args := "TRUE", []any{}
	if t := r.URL.Query().Get("team_id"); t != "" {
		tid, err := uuid.Parse(t)
		if err != nil {
			writeErr(w, 400, fmt.Errorf("geçersiz team_id"))
			return
		}
		cond, args = "(m.team_a_id = $1 OR m.team_b_id = $1)", []any{tid}
	}
	rows, err := s.pg.Query(r.Context(), `
		SELECT m.match_id, m.map_name, m.status, m.event_name,
		       m.team_a_id, ta.name, m.team_b_id, tb.name,
		       count(r.*) AS rounds,
		       count(*) FILTER (WHERE (r.winner_side = 'T'  AND r.t_team_id  = m.team_a_id)
		                            OR (r.winner_side = 'CT' AND r.ct_team_id = m.team_a_id)) AS score_a,
		       count(*) FILTER (WHERE (r.winner_side = 'T'  AND r.t_team_id  = m.team_b_id)
		                            OR (r.winner_side = 'CT' AND r.ct_team_id = m.team_b_id)) AS score_b
		FROM matches m
		LEFT JOIN rounds r ON r.match_id = m.match_id
		LEFT JOIN teams ta ON ta.team_id = m.team_a_id
		LEFT JOIN teams tb ON tb.team_id = m.team_b_id
		WHERE `+cond+`
		GROUP BY m.match_id, m.map_name, m.status, m.event_name,
		         m.team_a_id, ta.name, m.team_b_id, tb.name
		ORDER BY m.event_name NULLS LAST, m.map_name`, args...)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer rows.Close()
	type match struct {
		MatchID uuid.UUID  `json:"match_id"`
		MapName *string    `json:"map_name"`
		Status  string     `json:"status"`
		Name    *string    `json:"name"`
		TeamAID *uuid.UUID `json:"team_a_id"`
		TeamA   *string    `json:"team_a"`
		TeamBID *uuid.UUID `json:"team_b_id"`
		TeamB   *string    `json:"team_b"`
		Rounds  int        `json:"rounds"`
		ScoreA  int        `json:"score_a"`
		ScoreB  int        `json:"score_b"`
	}
	var out []match
	for rows.Next() {
		var m match
		if err := rows.Scan(&m.MatchID, &m.MapName, &m.Status, &m.Name,
			&m.TeamAID, &m.TeamA, &m.TeamBID, &m.TeamB,
			&m.Rounds, &m.ScoreA, &m.ScoreB); err != nil {
			writeErr(w, 500, err)
			return
		}
		out = append(out, m)
	}
	writeJSON(w, 200, out)
}

// GET /api/v1/teams — takım listesi + maç sayısı (frontend takım filtresi)
func (s *server) teams(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pg.Query(r.Context(), `
		SELECT t.team_id, t.name, count(DISTINCT m.match_id) AS matches
		FROM teams t
		LEFT JOIN matches m ON m.team_a_id = t.team_id OR m.team_b_id = t.team_id
		GROUP BY t.team_id, t.name
		HAVING count(DISTINCT m.match_id) > 0
		ORDER BY matches DESC, t.name`)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer rows.Close()
	type team struct {
		TeamID  uuid.UUID `json:"team_id"`
		Name    string    `json:"name"`
		Matches int       `json:"matches"`
	}
	var out []team
	for rows.Next() {
		var t team
		if err := rows.Scan(&t.TeamID, &t.Name, &t.Matches); err != nil {
			writeErr(w, 500, err)
			return
		}
		out = append(out, t)
	}
	writeJSON(w, 200, out)
}

func (s *server) query(w http.ResponseWriter, r *http.Request) {
	var q dsl.Query
	if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
		writeErr(w, 400, fmt.Errorf("JSON çözülemedi: %w", err))
		return
	}
	if err := q.Validate(); err != nil {
		writeErr(w, 400, err)
		return
	}
	res, err := s.engine.Execute(r.Context(), &q)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, res)
}

// heatmap: §8.2 — seçili filtre setinin TÜM 1 sn kovalarını tek seferde döndürür;
// zaman kaydırıcı istemcide kovaları toplar, sunucuya tekrar gelmez.
func (s *server) heatmap(w http.ResponseWriter, r *http.Request) {
	qp := r.URL.Query()
	mapName := qp.Get("map")
	side := qp.Get("side")
	if mapName == "" || (side != "T" && side != "CT") {
		writeErr(w, 400, fmt.Errorf("map ve side (T|CT) zorunlu"))
		return
	}

	// Filtre setini PG'de raunt listesine indir (buy/round aralığı/source)
	f := dsl.Filters{Map: mapName, Side: side, Source: qp.Get("source")}
	if bt := qp.Get("buy_type"); bt != "" {
		f.BuyType = strings.Split(bt, ",")
	}
	q := dsl.Query{Intent: "heatmap_filterset", Filters: f}
	if err := q.Validate(); err != nil {
		writeErr(w, 400, err)
		return
	}

	start := time.Now()
	roundsSQL, roundArgs := dsl.RoundFilterSQL(&f)
	rows, err := s.pg.Query(r.Context(), roundsSQL, roundArgs...)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	type rref struct {
		id uuid.UUID
		rn int16
	}
	var refs []rref
	for rows.Next() {
		var x rref
		var freeze *int32
		var mn string
		if err := rows.Scan(&x.id, &x.rn, &freeze, &mn); err != nil {
			rows.Close()
			writeErr(w, 500, err)
			return
		}
		refs = append(refs, x)
	}
	rows.Close()

	filtered := qp.Get("buy_type") != "" || qp.Get("source") != ""
	conds := []string{"map_name = ?", "side = ?"}
	args := []any{mapName, side}
	if filtered {
		groups := make([]clickhouse.GroupSet, len(refs))
		for i, x := range refs {
			groups[i] = clickhouse.GroupSet{Value: []any{x.id, uint8(x.rn)}}
		}
		conds = append(conds, "(match_id, round_number) IN (?)")
		args = append(args, groups)
	}

	chSQL := `SELECT time_bucket, grid_x, grid_y, sum(presence)
	          FROM heatmap_grid WHERE ` + strings.Join(conds, " AND ") + `
	          GROUP BY time_bucket, grid_x, grid_y
	          ORDER BY time_bucket`
	chRows, err := s.ch.Query(r.Context(), chSQL, args...)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer chRows.Close()

	type bucket struct {
		T     uint16     `json:"t"`
		Cells [][3]int64 `json:"cells"` // [grid_x, grid_y, presence]
	}
	var buckets []bucket
	var cur *bucket
	for chRows.Next() {
		var t uint16
		var gx, gy int16
		var p uint64
		if err := chRows.Scan(&t, &gx, &gy, &p); err != nil {
			writeErr(w, 500, err)
			return
		}
		if cur == nil || cur.T != t {
			buckets = append(buckets, bucket{T: t})
			cur = &buckets[len(buckets)-1]
		}
		cur.Cells = append(cur.Cells, [3]int64{int64(gx), int64(gy), int64(p)})
	}
	// radar kalibrasyonu: istemci ısı haritasını replay ile aynı uzayda çizsin
	cal, _ := s.radarFor(r.Context(), mapName)
	writeJSON(w, 200, map[string]any{
		"map":         mapName,
		"side":        side,
		"round_count": len(refs),
		"buckets":     buckets,
		"radar":       cal,
		"duration_ms": time.Since(start).Milliseconds(),
	})
}
