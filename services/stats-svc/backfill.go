// Toplu backfill: BACKFILL_DIR klasörüne atılan arşivler (.rar/.zip) ve
// tekil demolar (.dem/.dem.gz/.dem.zst) taranır, içlerindeki .dem'ler
// mevcut ingest hattına (sha dedup → MinIO → demo.ingested) verilir.
// HLTV iş akışı: turnuva rar'larını indir → klasöre yığ → "Scan" → sabah hazır.
// İşlenen dosyalar done/ altına taşınır; iş arka planda, ilerleme /status'tan.
package main

import (
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/klauspost/compress/zstd"
	"github.com/minio/minio-go/v7"
	"github.com/nwaples/rardecode/v2"
)

type backfillState struct {
	mu      sync.Mutex
	Running bool             `json:"running"`
	Total   int              `json:"total"`
	Done    int              `json:"done"`
	Current string           `json:"current"`
	Results []map[string]any `json:"results"`
	Errors  []string         `json:"errors"`
}

var bfState backfillState

// ml-jobs otomasyonu: son ingest'ten sonra parse kuyruğu boşalıp ortalık
// durulunca (settle) istatistik işleri kendiliğinden koşar — "her akşam
// klasöre at" akışında insan halkası kalmaz. ML_AUTO=0 ile kapatılır.
var (
	mlMu       sync.Mutex
	lastIngest time.Time
	lastMLRun  time.Time
)

func markIngest() {
	mlMu.Lock()
	lastIngest = time.Now()
	mlMu.Unlock()
}

func (s *server) mlAutoRun() {
	if os.Getenv("ML_AUTO") == "0" {
		return
	}
	dir := envOr("ML_JOBS_DIR", "services/ml")
	for {
		time.Sleep(60 * time.Second)
		mlMu.Lock()
		due := !lastIngest.IsZero() && lastIngest.After(lastMLRun) &&
			time.Since(lastIngest) > 2*time.Minute
		mlMu.Unlock()
		if !due {
			continue
		}
		// parse kuyruğu hâlâ çalışıyorsa bekle
		var pending int
		if err := s.pg.QueryRow(context.Background(),
			"SELECT count(*) FROM matches WHERE status NOT IN ('ready','failed')").
			Scan(&pending); err != nil || pending > 0 {
			continue
		}
		log.Printf("ml-auto: istatistik işleri başlıyor (son ingest %.0f sn önce)",
			time.Since(lastIngest).Seconds())
		cmd := exec.Command("uv", "run", "--no-editable", "ml-jobs")
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			log.Printf("ml-auto HATA: %v\n%s", err, tailStr(string(out), 800))
		} else {
			log.Printf("ml-auto tamam:\n%s", tailStr(string(out), 400))
		}
		mlMu.Lock()
		lastMLRun = time.Now()
		mlMu.Unlock()
	}
}

func tailStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return "…" + s[len(s)-n:]
}

func backfillDir() string { return envOr("BACKFILL_DIR", "backfill") }

// POST /api/v1/backfill/scan — klasörü tara, arka planda işle
func (s *server) backfillScan(w http.ResponseWriter, r *http.Request) {
	if s.up == nil {
		writeErr(w, 503, fmt.Errorf("upload infrastructure unavailable"))
		return
	}
	bfState.mu.Lock()
	if bfState.Running {
		bfState.mu.Unlock()
		writeErr(w, 409, fmt.Errorf("a backfill run is already in progress"))
		return
	}
	dir := backfillDir()
	os.MkdirAll(filepath.Join(dir, "done"), 0o755)
	entries, err := os.ReadDir(dir)
	if err != nil {
		bfState.mu.Unlock()
		writeErr(w, 500, err)
		return
	}
	var files []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		n := strings.ToLower(e.Name())
		if strings.HasSuffix(n, ".rar") || strings.HasSuffix(n, ".zip") ||
			strings.HasSuffix(n, ".dem") || strings.HasSuffix(n, ".dem.gz") ||
			strings.HasSuffix(n, ".dem.zst") {
			files = append(files, filepath.Join(dir, e.Name()))
		}
	}
	bfState.Running = true
	bfState.Total = len(files)
	bfState.Done = 0
	bfState.Current = ""
	bfState.Results = nil
	bfState.Errors = nil
	bfState.mu.Unlock()

	go s.backfillRun(files, dir)
	writeJSON(w, 200, map[string]any{"queued_files": len(files)})
}

// backfillWatch: klasör izleyici — kullanıcı dosya atınca kimse düğmeye
// basmadan işlenir ("her akşam klasöre at" sürdürülebilirliği). Dosyanın
// hâlâ kopyalanıyor olma ihtimaline karşı boyut iki tarama arasında
// sabitlenene dek beklenir.
func (s *server) backfillWatch() {
	if s.up == nil {
		return
	}
	dir := backfillDir()
	os.MkdirAll(filepath.Join(dir, "done"), 0o755)
	lastSize := map[string]int64{}
	for {
		time.Sleep(20 * time.Second)
		bfState.mu.Lock()
		busy := bfState.Running
		bfState.mu.Unlock()
		if busy {
			continue
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		var ready []string
		stable := map[string]int64{}
		for _, e := range entries {
			if e.IsDir() || !eligibleBackfillName(e.Name()) {
				continue
			}
			p := filepath.Join(dir, e.Name())
			st, err := os.Stat(p)
			if err != nil {
				continue
			}
			stable[p] = st.Size()
			if lastSize[p] == st.Size() { // iki taramadır aynı boyut → kopya bitti
				ready = append(ready, p)
			}
		}
		lastSize = stable
		if len(ready) == 0 {
			continue
		}
		bfState.mu.Lock()
		if bfState.Running {
			bfState.mu.Unlock()
			continue
		}
		bfState.Running = true
		bfState.Total = len(ready)
		bfState.Done = 0
		bfState.Results = nil
		bfState.Errors = nil
		bfState.mu.Unlock()
		log.Printf("backfill izleyici: %d dosya bulundu, işleniyor", len(ready))
		s.backfillRun(ready, dir)
	}
}

func eligibleBackfillName(name string) bool {
	n := strings.ToLower(name)
	return strings.HasSuffix(n, ".rar") || strings.HasSuffix(n, ".zip") ||
		strings.HasSuffix(n, ".dem") || strings.HasSuffix(n, ".dem.gz") ||
		strings.HasSuffix(n, ".dem.zst")
}

// GET /api/v1/backfill/status
func (s *server) backfillStatus(w http.ResponseWriter, r *http.Request) {
	bfState.mu.Lock()
	defer bfState.mu.Unlock()
	writeJSON(w, 200, map[string]any{
		"running": bfState.Running, "total": bfState.Total, "done": bfState.Done,
		"current": bfState.Current, "results": bfState.Results, "errors": bfState.Errors,
		"dir": backfillDir(),
	})
}

func (s *server) backfillRun(files []string, dir string) {
	defer func() {
		bfState.mu.Lock()
		bfState.Running = false
		bfState.Current = ""
		bfState.mu.Unlock()
	}()
	for _, f := range files {
		bfState.mu.Lock()
		bfState.Current = filepath.Base(f)
		bfState.mu.Unlock()

		results, err := s.backfillFile(f)
		bfState.mu.Lock()
		if err != nil {
			bfState.Errors = append(bfState.Errors,
				fmt.Sprintf("%s: %v", filepath.Base(f), err))
		} else {
			bfState.Results = append(bfState.Results, results...)
			if os.Getenv("BACKFILL_DELETE_DONE") == "1" {
				os.Remove(f) // disk baskısı: işlenen arşivi bekletme
			} else {
				// başarılı dosya done/ altına (yeniden taramada atlanır)
				os.Rename(f, filepath.Join(dir, "done", filepath.Base(f)))
			}
		}
		bfState.Done++
		bfState.mu.Unlock()
	}
}

// tournamentSlug: arşiv adından turnuva ham etiketi — uzantı, HLTV kuyruk
// kimliği (uzun karışık token) ve "boN" atılır; takım adları ml-jobs'ta
// (takımlar parse edilince) ayıklanır.
var boCutRe = regexp.MustCompile(`-bo[135](-.*)?$`)

func tournamentSlug(path string) string {
	base := filepath.Base(path)
	base = strings.TrimSuffix(strings.TrimSuffix(base, filepath.Ext(base)), ".dem")
	// HLTV deseni: {event}-{a}-vs-{b}-boN-{id}; id tire içerebildiğinden
	// güvenli kesim "-boN" çapasından yapılır
	if m := boCutRe.FindStringIndex(base); m != nil {
		return base[:m[0]]
	}
	parts := strings.Split(base, "-")
	for len(parts) > 0 && len(parts[len(parts)-1]) >= 16 {
		parts = parts[:len(parts)-1]
	}
	return strings.Join(parts, "-")
}

// backfillFile: tek arşiv/demoyu açar, içindeki her .dem'i ingest eder.
func (s *server) backfillFile(path string) ([]map[string]any, error) {
	lower := strings.ToLower(path)
	// arşiv dosya tarihi ≈ maç tarihi (HLTV rar'ları maç günü damgalıdır)
	playedAt := ""
	if st, err := os.Stat(path); err == nil {
		playedAt = st.ModTime().UTC().Format(time.RFC3339)
	}
	switch {
	case strings.HasSuffix(lower, ".rar"):
		return s.backfillRar(path, playedAt)
	case strings.HasSuffix(lower, ".zip"):
		return s.backfillZip(path, playedAt)
	case strings.HasSuffix(lower, ".dem.gz"):
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		gz, err := gzip.NewReader(f)
		if err != nil {
			return nil, err
		}
		defer gz.Close()
		r, err := s.ingestStream(gz, demBase(path), playedAt, tournamentSlug(path))
		return wrapResult(r, err)
	case strings.HasSuffix(lower, ".dem.zst"):
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		zr, err := zstd.NewReader(f)
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		r, err := s.ingestStream(zr, demBase(path), playedAt, tournamentSlug(path))
		return wrapResult(r, err)
	default: // .dem
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		r, err := s.ingestStream(f, demBase(path), playedAt, tournamentSlug(path))
		return wrapResult(r, err)
	}
}

func (s *server) backfillRar(path, playedAt string) ([]map[string]any, error) {
	rr, err := rardecode.OpenReader(path)
	if err != nil {
		return nil, fmt.Errorf("rar açılamadı: %w", err)
	}
	defer rr.Close()
	var out []map[string]any
	for {
		hdr, err := rr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return out, err
		}
		if hdr.IsDir || !strings.HasSuffix(strings.ToLower(hdr.Name), ".dem") {
			continue
		}
		// rar girdileri orijinal dosya tarihini korur ≈ maç günü
		entryPlayed := playedAt
		if !hdr.ModificationTime.IsZero() {
			entryPlayed = hdr.ModificationTime.UTC().Format(time.RFC3339)
		}
		r, err := s.ingestStream(rr, demBase(hdr.Name), entryPlayed, tournamentSlug(path))
		if err != nil {
			// içteki hata yutulmaz: arşiv done'a taşınmaz, hata panelde görünür
			return out, fmt.Errorf("%s: %w", hdr.Name, err)
		}
		out = append(out, r)
	}
	return out, nil
}

func (s *server) backfillZip(path, playedAt string) ([]map[string]any, error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	var out []map[string]any
	for _, zf := range zr.File {
		if !strings.HasSuffix(strings.ToLower(zf.Name), ".dem") {
			continue
		}
		f, err := zf.Open()
		if err != nil {
			return out, err
		}
		entryPlayed := playedAt
		if !zf.Modified.IsZero() {
			entryPlayed = zf.Modified.UTC().Format(time.RFC3339)
		}
		r, err := s.ingestStream(f, demBase(zf.Name), entryPlayed, tournamentSlug(path))
		f.Close()
		if err != nil {
			return out, fmt.Errorf("%s: %w", zf.Name, err)
		}
		out = append(out, r)
	}
	return out, nil
}

// ingestStream: akışı geçici dosyaya alır (sha ile birlikte) ve hatta verir.
func (s *server) ingestStream(r io.Reader, sourceFile, playedAt, tournament string) (map[string]any, error) {
	tmp, err := os.CreateTemp("", "backfill-*.dem")
	if err != nil {
		return nil, err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	h := sha256.New()
	size, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(r, maxDemoBytes))
	tmp.Close()
	if err != nil {
		return nil, err
	}
	sha := hex.EncodeToString(h.Sum(nil))
	resp, _, err := s.ingestLocalDemo(tmpPath, sha, size, sourceFile, playedAt, tournament, false)
	if err != nil {
		return nil, err
	}
	resp["source_file"] = sourceFile
	return resp, nil
}

func demBase(p string) string {
	return strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(
		filepath.Base(p), ".zst"), ".gz"), ".dem")
}

func wrapResult(r map[string]any, err error) ([]map[string]any, error) {
	if err != nil {
		return nil, err
	}
	return []map[string]any{r}, nil
}

// retentionLoop: saklama politikası (güncel karar: 12 ay) — eşikten
// eski maçların HAM demosu (MinIO) ve tick verisi (CH) silinir; PG meta
// süresiz kalır (leaderboard/kariyer bozulmaz). Günde bir koşar.
func (s *server) retentionLoop() {
	months := 12
	if v := os.Getenv("RETENTION_MONTHS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			months = n
		}
	}
	if months <= 0 {
		return
	}
	for {
		rows, err := s.pg.Query(context.Background(), `
			SELECT match_id, demo_object_key FROM matches
			WHERE status = 'ready' AND NOT tick_purged
			  AND played_at < now() - ($1 || ' months')::interval
			LIMIT 50`, strconv.Itoa(months))
		if err == nil {
			type victim struct {
				id  uuid.UUID
				key string
			}
			var vs []victim
			for rows.Next() {
				var v victim
				if rows.Scan(&v.id, &v.key) == nil {
					vs = append(vs, v)
				}
			}
			rows.Close()
			for _, v := range vs {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
				_ = s.up.mc.RemoveObject(ctx, s.up.bucket, v.key, minio.RemoveObjectOptions{})
				err1 := s.ch.Exec(ctx, "DELETE FROM player_ticks WHERE match_id = ?", v.id)
				err2 := s.ch.Exec(ctx, "DELETE FROM shots WHERE match_id = ?", v.id)
				cancel()
				if err1 == nil && err2 == nil {
					_, _ = s.pg.Exec(context.Background(),
						"UPDATE matches SET tick_purged = true WHERE match_id = $1", v.id)
					log.Printf("saklama: %s arşivlendi (ham+tick silindi, meta kaldı)", v.id)
				}
			}
		}
		time.Sleep(24 * time.Hour)
	}
}

// POST /api/v1/reprocess {"match_id": "..."} | {} = tüm arşiv.
// MinIO'daki ham demoları demo.ingested olarak yeniden yayınlar — parser
// şeması evrildiğinde arşivi tazelemenin standart yolu (sha dedup korunur;
// parser aynı match_id ile üzerine yazar).
func (s *server) reprocess(w http.ResponseWriter, r *http.Request) {
	if s.up == nil {
		writeErr(w, 503, fmt.Errorf("upload infrastructure unavailable"))
		return
	}
	var body struct {
		MatchID string `json:"match_id"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	// tekil maçta statü filtresi yok: takılı (parsing) işler de kurtarılabilir
	cond, args := "status IN ('ready','failed')", []any{}
	if body.MatchID != "" {
		cond, args = "match_id = $1", []any{body.MatchID}
	}
	rows, err := s.pg.Query(r.Context(), `
		SELECT match_id, demo_sha256, demo_object_key,
		       COALESCE(event_name,''), COALESCE(to_char(played_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"'),''),
		       COALESCE(tournament,'')
		FROM matches WHERE `+cond, args...)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var mid, sha, key, ev, played, tour string
		if rows.Scan(&mid, &sha, &key, &ev, &played, &tour) != nil {
			continue
		}
		payload, _ := json.Marshal(map[string]any{
			"demo_sha256": sha, "match_id": mid, "object_key": key,
			"source_file": ev, "played_at": played, "tournament": tour,
		})
		if s.up.nc.Publish("demo.ingested", payload) == nil {
			n++
		}
	}
	markIngest() // kuyruk boşalınca ml-auto tazeler
	writeJSON(w, 200, map[string]any{"republished": n})
}

// POST /api/v1/admin/compress-raw {"limit": N} — mevcut sıkıştırılmamış ham
// demoları yerinde .dem.zst'ye çevirir (oku→sıkıştır→yaz→doğrula→eskisini sil
// →demo_object_key güncelle). İdempotent; arka planda koşar, log'a yazar.
func (s *server) compressRaw(w http.ResponseWriter, r *http.Request) {
	if s.up == nil {
		writeErr(w, 503, fmt.Errorf("upload infrastructure unavailable"))
		return
	}
	var body struct {
		Limit int `json:"limit"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Limit <= 0 {
		body.Limit = 100000
	}
	rows, err := s.pg.Query(r.Context(), `
		SELECT match_id, demo_object_key FROM matches
		WHERE demo_object_key LIKE '%.dem' AND NOT tick_purged
		LIMIT $1`, body.Limit)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	type item struct{ id, key string }
	var items []item
	for rows.Next() {
		var it item
		if rows.Scan(&it.id, &it.key) == nil {
			items = append(items, it)
		}
	}
	rows.Close()

	go func() {
		okN, failN := 0, 0
		for i, it := range items {
			err := func() error {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
				defer cancel()
				obj, err := s.up.mc.GetObject(ctx, s.up.bucket, it.key, minio.GetObjectOptions{})
				if err != nil {
					return err
				}
				defer obj.Close()
				newKey := it.key + ".zst"
				pr, pw := io.Pipe()
				go func() {
					zw, _ := zstd.NewWriter(pw, zstd.WithEncoderLevel(zstd.SpeedDefault))
					_, cErr := io.Copy(zw, obj)
					if cErr == nil {
						cErr = zw.Close()
					} else {
						zw.Close()
					}
					pw.CloseWithError(cErr)
				}()
				info, err := s.up.mc.PutObject(ctx, s.up.bucket, newKey, pr, -1,
					minio.PutObjectOptions{ContentType: "application/zstd"})
				if err != nil {
					return err
				}
				if info.Size <= 0 {
					return fmt.Errorf("empty compressed object")
				}
				if _, err := s.pg.Exec(ctx,
					"UPDATE matches SET demo_object_key = $1 WHERE match_id = $2",
					newKey, it.id); err != nil {
					return err
				}
				return s.up.mc.RemoveObject(ctx, s.up.bucket, it.key, minio.RemoveObjectOptions{})
			}()
			if err != nil {
				failN++
				log.Printf("compress-raw %d/%d HATA %s: %v", i+1, len(items), it.key, err)
			} else {
				okN++
				if (i+1)%25 == 0 {
					log.Printf("compress-raw ilerleme: %d/%d", i+1, len(items))
				}
			}
		}
		log.Printf("compress-raw bitti: ok=%d hata=%d", okN, failN)
	}()
	writeJSON(w, 200, map[string]any{"queued": len(items)})
}

// GET /api/v1/coverage — arşiv kapsam envanteri (backfill kör uçuşu önler)
func (s *server) coverage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	out := map[string]any{}
	_ = s.pg.QueryRow(ctx, `
		SELECT count(*) FROM matches WHERE status = 'ready'`).Scan(new(int))
	out["totals"] = s.jsonQuery(ctx, `
		SELECT json_build_object(
		    'matches', count(*),
		    'rounds', (SELECT count(*) FROM rounds),
		    'teams', (SELECT count(DISTINCT t) FROM (
		        SELECT team_a_id AS t FROM matches WHERE status='ready'
		        UNION SELECT team_b_id FROM matches WHERE status='ready') x WHERE t IS NOT NULL),
		    'oldest', (SELECT to_char(min(played_at),'YYYY-MM-DD') FROM matches WHERE status='ready'),
		    'newest', (SELECT to_char(max(played_at),'YYYY-MM-DD') FROM matches WHERE status='ready'))
		FROM matches WHERE status = 'ready'`)
	out["maps"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY x.matches DESC), '[]'::json) FROM (
		    SELECT map_name, count(*) AS matches FROM matches
		    WHERE status = 'ready' GROUP BY map_name
		) x`)
	out["tournaments"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY x.latest DESC NULLS LAST), '[]'::json) FROM (
		    SELECT COALESCE(tournament, '(untagged)') AS tournament,
		           count(*) AS matches,
		           to_char(max(played_at), 'YYYY-MM-DD') AS latest
		    FROM matches WHERE status = 'ready'
		    GROUP BY COALESCE(tournament, '(untagged)')
		) x`)
	out["teams"] = s.jsonQuery(ctx, `
		SELECT COALESCE(json_agg(x ORDER BY x.matches DESC), '[]'::json) FROM (
		    SELECT t.name, count(DISTINCT m.match_id) AS matches,
		           to_char(max(m.played_at), 'YYYY-MM-DD') AS latest
		    FROM teams t
		    JOIN matches m ON (m.team_a_id = t.team_id OR m.team_b_id = t.team_id)
		         AND m.status = 'ready'
		    GROUP BY t.name
		) x`)
	writeJSON(w, 200, out)
}
