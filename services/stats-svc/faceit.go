// FACEIT entegrasyonu: maç listeleme (Data API) + demo indirme (Downloads API).
//
// İki ayrı yetki gerekir:
//
//	FACEIT_API_KEY        — Data API (developer portalından anında alınır)
//	FACEIT_DOWNLOADS_KEY  — Downloads API (başvuru onayı ~30 gün; onaya kadar
//	                        import "download yetkisi yok" hatası döner)
//
// Aynı anahtar Downloads kapsamı içeriyorsa iki env aynı değere işaret edebilir.
package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
)

const faceitAPI = "https://open.faceit.com/data/v4"

func faceitKey() string { return os.Getenv("FACEIT_API_KEY") }
func faceitDLKey() string {
	if k := os.Getenv("FACEIT_DOWNLOADS_KEY"); k != "" {
		return k
	}
	return faceitKey()
}

func (s *server) faceitGet(path string, out any) error {
	req, _ := http.NewRequest("GET", faceitAPI+path, nil)
	req.Header.Set("Authorization", "Bearer "+faceitKey())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("FACEIT API %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// GET /api/v1/faceit/matches?nickname=X — oyuncunun son CS2 maçları
func (s *server) faceitMatches(w http.ResponseWriter, r *http.Request) {
	if faceitKey() == "" {
		writeErr(w, 503, fmt.Errorf("FACEIT_API_KEY is not configured"))
		return
	}
	nick := strings.TrimSpace(r.URL.Query().Get("nickname"))
	if nick == "" {
		writeErr(w, 400, fmt.Errorf("nickname is required"))
		return
	}
	var player struct {
		PlayerID string `json:"player_id"`
		Nickname string `json:"nickname"`
	}
	if err := s.faceitGet("/players?nickname="+url.QueryEscape(nick), &player); err != nil {
		writeErr(w, 502, fmt.Errorf("player lookup: %w", err))
		return
	}
	var hist struct {
		Items []struct {
			MatchID   string `json:"match_id"`
			StartedAt int64  `json:"started_at"`
			Teams     map[string]struct {
				Nickname string `json:"nickname"`
			} `json:"teams"`
			Results struct {
				Winner string `json:"winner"`
			} `json:"results"`
		} `json:"items"`
	}
	if err := s.faceitGet(
		"/players/"+player.PlayerID+"/history?game=cs2&limit=20", &hist); err != nil {
		writeErr(w, 502, fmt.Errorf("history: %w", err))
		return
	}
	type row struct {
		MatchID   string `json:"match_id"`
		StartedAt string `json:"started_at"`
		Label     string `json:"label"`
	}
	out := []row{}
	for _, it := range hist.Items {
		a, b := it.Teams["faction1"].Nickname, it.Teams["faction2"].Nickname
		out = append(out, row{
			MatchID:   it.MatchID,
			StartedAt: time.Unix(it.StartedAt, 0).UTC().Format("2006-01-02"),
			Label:     fmt.Sprintf("%s vs %s", a, b),
		})
	}
	writeJSON(w, 200, map[string]any{"player": player.Nickname, "matches": out})
}

var faceitRoomRe = regexp.MustCompile(`(1-[0-9a-f-]{36})`)

// POST /api/v1/faceit/import {"match": "<match id veya oda URL'si>"}
func (s *server) faceitImport(w http.ResponseWriter, r *http.Request) {
	if s.up == nil {
		writeErr(w, 503, fmt.Errorf("upload infrastructure unavailable"))
		return
	}
	if faceitKey() == "" {
		writeErr(w, 503, fmt.Errorf("FACEIT_API_KEY is not configured"))
		return
	}
	var body struct {
		Match string `json:"match"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, 400, fmt.Errorf("could not parse JSON: %w", err))
		return
	}
	m := faceitRoomRe.FindString(body.Match)
	if m == "" {
		writeErr(w, 400, fmt.Errorf("could not find a match id in %q", body.Match))
		return
	}

	// Maç detayı: demo_url + takımlar + tarih
	var det struct {
		DemoURL   []string `json:"demo_url"`
		StartedAt int64    `json:"started_at"`
		Teams     map[string]struct {
			Name string `json:"name"`
		} `json:"teams"`
		Voting struct {
			Map struct {
				Pick []string `json:"pick"`
			} `json:"map"`
		} `json:"voting"`
	}
	if err := s.faceitGet("/matches/"+m, &det); err != nil {
		writeErr(w, 502, fmt.Errorf("match details: %w", err))
		return
	}
	if len(det.DemoURL) == 0 {
		writeErr(w, 404, fmt.Errorf("no demo available for this match yet"))
		return
	}

	// Downloads API: resource_url → imzalı URL
	reqBody, _ := json.Marshal(map[string]string{"resource_url": det.DemoURL[0]})
	dreq, _ := http.NewRequest("POST",
		"https://open.faceit.com/download/v2/demos/download", bytes.NewReader(reqBody))
	dreq.Header.Set("Authorization", "Bearer "+faceitDLKey())
	dreq.Header.Set("Content-Type", "application/json")
	dresp, err := http.DefaultClient.Do(dreq)
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	defer dresp.Body.Close()
	if dresp.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(dresp.Body, 300))
		writeErr(w, 502, fmt.Errorf(
			"Downloads API %d (Downloads scope onayı gerekli olabilir): %s",
			dresp.StatusCode, strings.TrimSpace(string(b))))
		return
	}
	var signed struct {
		Payload struct {
			DownloadURL string `json:"download_url"`
		} `json:"payload"`
	}
	if err := json.NewDecoder(dresp.Body).Decode(&signed); err != nil {
		writeErr(w, 502, err)
		return
	}

	// Demoyu indir + sıkıştırmayı aç + sha hesapla (akış halinde)
	fresp, err := http.Get(signed.Payload.DownloadURL)
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	defer fresp.Body.Close()
	if fresp.StatusCode != 200 {
		writeErr(w, 502, fmt.Errorf("demo download HTTP %d", fresp.StatusCode))
		return
	}
	var reader io.Reader = fresp.Body
	lowerURL := strings.ToLower(det.DemoURL[0])
	switch {
	case strings.HasSuffix(lowerURL, ".gz"):
		gz, err := gzip.NewReader(fresp.Body)
		if err != nil {
			writeErr(w, 502, fmt.Errorf("gzip: %w", err))
			return
		}
		defer gz.Close()
		reader = gz
	case strings.HasSuffix(lowerURL, ".zst"):
		zr, err := zstd.NewReader(fresp.Body)
		if err != nil {
			writeErr(w, 502, fmt.Errorf("zstd: %w", err))
			return
		}
		defer zr.Close()
		reader = zr
	}
	tmp, err := os.CreateTemp("", "faceit-*.dem")
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	h := sha256.New()
	size, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(reader, maxDemoBytes))
	tmp.Close()
	if err != nil {
		writeErr(w, 502, fmt.Errorf("download interrupted: %w", err))
		return
	}
	sha := hex.EncodeToString(h.Sum(nil))

	// Kaynak adı: takımlar (+harita) — arama bunun içinde eşleşir
	name := fmt.Sprintf("faceit-%s-vs-%s",
		slugify(det.Teams["faction1"].Name), slugify(det.Teams["faction2"].Name))
	if len(det.Voting.Map.Pick) > 0 {
		name += "-" + det.Voting.Map.Pick[0]
	}
	playedAt := time.Unix(det.StartedAt, 0).UTC().Format(time.RFC3339)

	resp, code, err := s.ingestLocalDemo(tmpPath, sha, size, name, playedAt)
	if err != nil {
		writeErr(w, code, err)
		return
	}
	writeJSON(w, 200, resp)
}

var slugRe = regexp.MustCompile(`[^a-zA-Z0-9]+`)

func slugify(s string) string {
	return strings.Trim(slugRe.ReplaceAllString(s, "-"), "-")
}
