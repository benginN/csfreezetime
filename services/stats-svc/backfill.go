// Toplu backfill: BACKFILL_DIR klasörüne atılan arşivler (.rar/.zip) ve
// tekil demolar (.dem/.dem.gz/.dem.zst) taranır, içlerindeki .dem'ler
// mevcut ingest hattına (sha dedup → MinIO → demo.ingested) verilir.
// HLTV iş akışı: turnuva rar'larını indir → klasöre yığ → "Scan" → sabah hazır.
// İşlenen dosyalar done/ altına taşınır; iş arka planda, ilerleme /status'tan.
package main

import (
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"
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
			// başarılı dosya done/ altına (yeniden taramada atlanır)
			os.Rename(f, filepath.Join(dir, "done", filepath.Base(f)))
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
		r, err := s.ingestStream(gz, demBase(path), playedAt, "")
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
		r, err := s.ingestStream(zr, demBase(path), playedAt, "")
		return wrapResult(r, err)
	default: // .dem
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		r, err := s.ingestStream(f, demBase(path), playedAt, "")
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
		res, _ := wrapResult(r, err)
		out = append(out, res...)
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
		res, _ := wrapResult(r, err)
		out = append(out, res...)
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
	resp, _, err := s.ingestLocalDemo(tmpPath, sha, size, sourceFile, playedAt, tournament)
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
