// export — çalışan stats-svc'den statik site verisi üretir (Faz Y1,
// docs/mimari.md §11.1). Sunucudaki endpoint'leri olduğu gibi dosyaya
// döker: sayfa JSON'ları <out>/data/api/… altına (canon.go eşlemesiyle),
// maç paketleri <out>/bundles-new/<turnuva>/<match_id>.json.gz altına.
// Fark bazlıdır: <out>/data/manifest.json'da kayıtlı maçların paketi
// yeniden üretilmez; sayfa JSON'ları her koşuda tazelenir.
//
//	go run ./cmd/export -api http://localhost:8090 -out ../csfreezetime-data \
//	  -bundle-base https://github.com/OWNER/csfreezetime-data/releases/download
package main

import (
	"compress/gzip"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type matchSummary struct {
	MatchID    string  `json:"match_id"`
	MapName    *string `json:"map_name"`
	Status     string  `json:"status"`
	Name       *string `json:"name"`
	TeamAID    *string `json:"team_a_id"`
	TeamA      *string `json:"team_a"`
	TeamBID    *string `json:"team_b_id"`
	TeamB      *string `json:"team_b"`
	Rounds     int     `json:"rounds"`
	ScoreA     int     `json:"score_a"`
	ScoreB     int     `json:"score_b"`
	PlayedAt   *string `json:"played_at"`
	Tournament *string `json:"tournament"`
}

type team struct {
	TeamID  string `json:"team_id"`
	Name    string `json:"name"`
	Matches int    `json:"matches"`
}

type playerRow struct {
	PlayerID string `json:"player_id"`
	Nickname string `json:"nickname"`
}

type manifestEntry struct {
	Tag        string  `json:"tag"`  // release etiketi (turnuva slug'ı)
	File       string  `json:"file"` // <match_id>.json.gz
	Tournament *string `json:"tournament"`
	MapName    *string `json:"map_name"`
	Name       *string `json:"name"`
	TeamA      *string `json:"team_a"`
	TeamB      *string `json:"team_b"`
	Rounds     int     `json:"rounds"`
	PlayedAt   *string `json:"played_at"`
	Bytes      int64   `json:"bytes"`
}

type manifest struct {
	GeneratedAt string                   `json:"generated_at"`
	BundleBase  string                   `json:"bundle_base"`
	Matches     map[string]manifestEntry `json:"matches"`
}

type client struct {
	api  string
	http *http.Client
}

// getRaw endpoint yanıtını ham bayt olarak döner; {"error":…} yanıtını
// hataya çevirir (frontend'in get() sözleşmesiyle aynı).
func (c *client) getRaw(pathAndQuery string) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 2 * time.Second)
		}
		resp, err := c.http.Get(c.api + pathAndQuery)
		if err != nil {
			lastErr = err
			continue
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}
		var probe struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(body, &probe)
		if probe.Error != "" {
			return nil, fmt.Errorf("%s: %s", pathAndQuery, probe.Error)
		}
		if resp.StatusCode != 200 {
			return nil, fmt.Errorf("%s: HTTP %d", pathAndQuery, resp.StatusCode)
		}
		return body, nil
	}
	return nil, fmt.Errorf("%s: %w", pathAndQuery, lastErr)
}

func (c *client) getJSON(pathAndQuery string, into any) error {
	b, err := c.getRaw(pathAndQuery)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, into)
}

// savePage endpoint yanıtını canon eşlemesiyle <out>/data/api altına yazar.
func (c *client) savePage(outDir, pathAndQuery string) error {
	rel, err := canonPath(pathAndQuery)
	if err != nil {
		return err
	}
	body, err := c.getRaw(pathAndQuery)
	if err != nil {
		return err
	}
	dst := filepath.Join(outDir, "data", "api", filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return os.WriteFile(dst, body, 0o644)
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func main() {
	apiBase := flag.String("api", "http://localhost:8090", "stats-svc adresi")
	out := flag.String("out", "", "çıktı dizini (veri reposu çalışma kopyası)")
	bundleBase := flag.String("bundle-base", "", "manifest'e yazılacak paket URL kökü (…/releases/download)")
	skipBundles := flag.Bool("skip-bundles", false, "yalnız sayfa JSON'ları (paket üretme)")
	flag.Parse()
	if *out == "" || (*bundleBase == "" && !*skipBundles) {
		log.Fatal("usage: export -out <dir> -bundle-base <url> [-api <addr>] [-skip-bundles]")
	}
	c := &client{api: *apiBase, http: &http.Client{Timeout: 5 * time.Minute}}
	start := time.Now()

	// ---- envanter -------------------------------------------------------
	var all []matchSummary
	must(c.getJSON("/api/v1/matches", &all))
	var matches []matchSummary
	for _, m := range all {
		if m.Status == "ready" {
			matches = append(matches, m)
		}
	}
	var teams []team
	must(c.getJSON("/api/v1/teams", &teams))
	mapSet := map[string]bool{}
	for _, m := range matches {
		if m.MapName != nil {
			mapSet[*m.MapName] = true
		}
	}
	maps := sortedKeys(mapSet)
	log.Printf("export: %d ready matches, %d teams, %d maps", len(matches), len(teams), len(maps))

	// ---- manifest (fark bazının kaynağı) --------------------------------
	man := manifest{Matches: map[string]manifestEntry{}, BundleBase: *bundleBase}
	manPath := filepath.Join(*out, "data", "manifest.json")
	if b, err := os.ReadFile(manPath); err == nil {
		if err := json.Unmarshal(b, &man); err != nil {
			log.Fatalf("corrupt manifest %s: %v", manPath, err)
		}
		if man.Matches == nil {
			man.Matches = map[string]manifestEntry{}
		}
	}

	// ---- maç paketleri + oyuncu envanteri -------------------------------
	// matchPlayers her maç için çekilir (arama indeksi + profil listesi);
	// paket yalnız manifest'te olmayan maçlar için üretilir.
	playerSet := map[string]string{} // id → nickname
	var manMu, playerMu sync.Mutex
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	errCh := make(chan error, len(matches))
	for _, m := range matches {
		wg.Add(1)
		go func(m matchSummary) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			playersRaw, err := c.getRaw("/api/v1/matches/" + m.MatchID + "/players")
			if err != nil {
				errCh <- err
				return
			}
			var players []playerRow
			if err := json.Unmarshal(playersRaw, &players); err != nil {
				errCh <- fmt.Errorf("%s players: %w", m.MatchID, err)
				return
			}
			playerMu.Lock()
			for _, p := range players {
				playerSet[p.PlayerID] = p.Nickname
			}
			playerMu.Unlock()

			manMu.Lock()
			_, done := man.Matches[m.MatchID]
			manMu.Unlock()
			if done || *skipBundles {
				return
			}
			entry, err := c.writeBundle(*out, m, playersRaw)
			if err != nil {
				errCh <- err
				return
			}
			manMu.Lock()
			man.Matches[m.MatchID] = entry
			manMu.Unlock()
			log.Printf("bundle %s (%s, %s)", m.MatchID, str(m.Name), entry.Tag)
		}(m)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		log.Fatalf("bundle export failed: %v", err) // fail-fast: eksik yayınlamayalım
	}

	// ---- sayfa JSON'ları -------------------------------------------------
	pages := []string{
		"/api/v1/matches", "/api/v1/teams", "/api/v1/mlstatus",
		"/api/v1/winprob", "/api/v1/leaderboards",
	}
	for _, mp := range maps {
		q := url.QueryEscape(mp)
		pages = append(pages, "/api/v1/maplayout?map="+q,
			"/api/v1/clusters?map="+q+"&side=T", "/api/v1/clusters?map="+q+"&side=CT",
			// Moments-lite: harita-başına kompakt olay dizini (istemci DSL'i
			// bunun üzerinde koşar; GH Pages'ın hat-üstü gzip'i sıkıştırır)
			"/api/v1/export/moments-index?map="+q,
			// Pattern Finder: son 20k granat yörüngesi + team_id/date
			// (side/team/since filtreleri istemcide uygulanır)
			"/api/v1/patterns?export=1&map="+q)
	}
	for _, t := range teams {
		if t.Matches == 0 {
			continue
		}
		id := url.PathEscape(t.TeamID)
		pages = append(pages,
			"/api/v1/matches?team_id="+t.TeamID+"&since=&roster_min=0",
			"/api/v1/teams/"+id+"/summary?since=&roster_min=0",
			"/api/v1/teams/"+id+"/tendencies")
		for _, mp := range teamMaps(matches, t.TeamID) {
			q := url.QueryEscape(mp)
			pages = append(pages,
				"/api/v1/teams/"+id+"/control?map="+q+"&since=&roster_min=0",
				"/api/v1/report?team_id="+t.TeamID+"&map="+q+"&since=&roster_min=0")
			// Takım ısı haritaları (Compare + Report pencere önayarları).
			// Yalnız ≥3 maçlık takım-harita kombinasyonları: altı istatistiksel
			// gürültü, hacim de kontrolde kalsın (pencere başına ~40 KB).
			nOnMap := 0
			for _, m := range matches {
				if m.MapName != nil && *m.MapName == mp &&
					((m.TeamAID != nil && *m.TeamAID == t.TeamID) ||
						(m.TeamBID != nil && *m.TeamBID == t.TeamID)) {
					nOnMap++
				}
			}
			if nOnMap >= 3 {
				for _, side := range []string{"T", "CT"} {
					for _, w := range [][2]string{{"0", "25"}, {"25", "115"}, {"0", "115"}} {
						pages = append(pages, "/api/v1/teams/"+id+"/heatmap?map="+q+
							"&side="+side+"&t0="+w[0]+"&t1="+w[1]+"&since=&roster_min=0")
					}
					pages = append(pages, "/api/v1/teams/"+id+"/heatmap?map="+q+
						"&side="+side+"&anchor=plant&t0=0&t1=40&since=&roster_min=0")
				}
			}
			for _, side := range []string{"T", "CT"} {
				pages = append(pages, "/api/v1/predict?team_id="+t.TeamID+"&map="+q+"&side="+side)
				for _, buy := range []string{"pistol", "eco", "semi", "force", "full"} {
					pages = append(pages,
						"/api/v1/predict?team_id="+t.TeamID+"&map="+q+"&side="+side+"&buy_type="+buy)
				}
			}
		}
	}
	// Oyuncu profilleri: yanıtı hem dosyaya yaz hem harita listesini çıkar —
	// pozisyon ısı haritasının statikteki tek varyantı (tam raunt, AWP'siz)
	// oyuncunun oynadığı haritalar için dökülür (Player.tsx ile aynı sorgu).
	for pid := range playerSet {
		esc := url.PathEscape(pid)
		profURL := "/api/v1/players/" + esc + "/profile"
		body, err := c.getRaw(profURL)
		if err != nil {
			log.Fatalf("profile export failed: %v", err)
		}
		rel, _ := canonPath(profURL)
		dst := filepath.Join(*out, "data", "api", filepath.FromSlash(rel))
		must(os.MkdirAll(filepath.Dir(dst), 0o755))
		must(os.WriteFile(dst, body, 0o644))
		var prof struct {
			Maps []struct {
				MapName string `json:"map_name"`
			} `json:"maps"`
		}
		must(json.Unmarshal(body, &prof))
		for _, pm := range prof.Maps {
			q := url.QueryEscape(pm.MapName)
			for _, side := range []string{"T", "CT"} {
				pages = append(pages,
					"/api/v1/players/"+esc+"/heatmap?map="+q+"&side="+side+"&t0=0&t1=115")
			}
		}
	}
	log.Printf("export: %d page files", len(pages))
	pageErr := make(chan error, len(pages))
	pageCh := make(chan string)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for p := range pageCh {
				if err := c.savePage(*out, p); err != nil {
					pageErr <- err
				}
			}
		}()
	}
	for _, p := range pages {
		pageCh <- p
	}
	close(pageCh)
	wg.Wait()
	close(pageErr)
	for err := range pageErr {
		log.Fatalf("page export failed: %v", err)
	}

	// ---- arama indeksi ----------------------------------------------------
	writeSearchIndex(*out, teams, playerSet, matches)

	// ---- manifest ---------------------------------------------------------
	man.GeneratedAt = time.Now().UTC().Format(time.RFC3339)
	man.BundleBase = *bundleBase
	mb, _ := json.MarshalIndent(man, "", " ")
	must(os.MkdirAll(filepath.Dir(manPath), 0o755))
	must(os.WriteFile(manPath, mb, 0o644))
	log.Printf("export done in %s: %d bundles in manifest", time.Since(start).Round(time.Second), len(man.Matches))
}

// writeBundle bir maçın paketini üretir: localdb.ts Bundle formatı
// (match_id, name, detail, players, rounds{n: RoundTicks}).
func (c *client) writeBundle(out string, m matchSummary, playersRaw []byte) (manifestEntry, error) {
	tag := "untagged"
	if m.Tournament != nil && *m.Tournament != "" {
		tag = slugPart(strings.ToLower(*m.Tournament))
	}
	file := m.MatchID + ".json.gz"
	dst := filepath.Join(out, "bundles-new", tag, file)
	// kaldığı yerden devam: önceki (yarıda kesilmiş) koşunun ürettiği paket
	// duruyorsa yeniden üretme — dosyalar atomik yazılır, var = tam demektir
	if st, err := os.Stat(dst); err == nil && st.Size() > 0 {
		return manifestEntry{
			Tag: tag, File: file, Tournament: m.Tournament, MapName: m.MapName,
			Name: m.Name, TeamA: m.TeamA, TeamB: m.TeamB, Rounds: m.Rounds,
			PlayedAt: m.PlayedAt, Bytes: st.Size(),
		}, nil
	}
	detailRaw, err := c.getRaw("/api/v1/matches/" + m.MatchID)
	if err != nil {
		return manifestEntry{}, err
	}
	var detail struct {
		Rounds []struct {
			RoundNumber int `json:"round_number"`
		} `json:"rounds"`
	}
	if err := json.Unmarshal(detailRaw, &detail); err != nil {
		return manifestEntry{}, fmt.Errorf("%s detail: %w", m.MatchID, err)
	}
	rounds := map[string]json.RawMessage{}
	for _, r := range detail.Rounds {
		t, err := c.getRaw(fmt.Sprintf("/api/v1/rounds/%s/%d/ticks", m.MatchID, r.RoundNumber))
		if err != nil {
			// dejenere raunt (parça sınırında tick'siz) tüm yayını
			// durdurmasın: raunt paketten düşer, replay onu atlar
			if strings.Contains(err.Error(), "no tick data") {
				log.Printf("uyarı: %s r%d tick verisi yok — pakette atlandı (%s)",
					str(m.Name), r.RoundNumber, m.MatchID)
				continue
			}
			return manifestEntry{}, err
		}
		rounds[fmt.Sprint(r.RoundNumber)] = t
	}
	bundle := map[string]any{
		"match_id": m.MatchID,
		"name":     m.Name,
		"detail":   json.RawMessage(detailRaw),
		"players":  json.RawMessage(playersRaw),
		"rounds":   rounds,
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return manifestEntry{}, err
	}
	// atomik yazım: tmp'ye yaz, bitince adlandır — kesilen koşu yarım dosya
	// bırakamaz, yukarıdaki "var = tam" devam mantığı buna güvenir
	tmp := dst + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return manifestEntry{}, err
	}
	gz, _ := gzip.NewWriterLevel(f, gzip.BestCompression)
	if err := json.NewEncoder(gz).Encode(bundle); err != nil {
		f.Close()
		return manifestEntry{}, err
	}
	if err := gz.Close(); err != nil {
		f.Close()
		return manifestEntry{}, err
	}
	if err := f.Close(); err != nil {
		return manifestEntry{}, err
	}
	if err := os.Rename(tmp, dst); err != nil {
		return manifestEntry{}, err
	}
	st, _ := os.Stat(dst)
	return manifestEntry{
		Tag: tag, File: file, Tournament: m.Tournament, MapName: m.MapName,
		Name: m.Name, TeamA: m.TeamA, TeamB: m.TeamB, Rounds: m.Rounds,
		PlayedAt: m.PlayedAt, Bytes: st.Size(),
	}, nil
}

func writeSearchIndex(out string, teams []team, players map[string]string, matches []matchSummary) {
	type nameID struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	tCount := map[string]int{}
	for _, m := range matches {
		if m.Tournament != nil && *m.Tournament != "" {
			tCount[*m.Tournament]++
		}
	}
	idx := struct {
		Teams       []nameID `json:"teams"`
		Players     []nameID `json:"players"`
		Tournaments []struct {
			Name    string `json:"name"`
			Matches int    `json:"matches"`
		} `json:"tournaments"`
		Matches []matchSummary `json:"matches"`
	}{Matches: matches}
	for _, t := range teams {
		if t.Matches > 0 {
			idx.Teams = append(idx.Teams, nameID{t.TeamID, t.Name})
		}
	}
	for id, nick := range players {
		idx.Players = append(idx.Players, nameID{id, nick})
	}
	sort.Slice(idx.Players, func(i, j int) bool { return idx.Players[i].Name < idx.Players[j].Name })
	for name, n := range tCount {
		idx.Tournaments = append(idx.Tournaments, struct {
			Name    string `json:"name"`
			Matches int    `json:"matches"`
		}{name, n})
	}
	sort.Slice(idx.Tournaments, func(i, j int) bool { return idx.Tournaments[i].Name < idx.Tournaments[j].Name })
	b, _ := json.Marshal(idx)
	must(os.MkdirAll(filepath.Join(out, "data"), 0o755))
	must(os.WriteFile(filepath.Join(out, "data", "search-index.json"), b, 0o644))
}

func teamMaps(matches []matchSummary, teamID string) []string {
	set := map[string]bool{}
	for _, m := range matches {
		if m.MapName == nil {
			continue
		}
		if (m.TeamAID != nil && *m.TeamAID == teamID) || (m.TeamBID != nil && *m.TeamBID == teamID) {
			set[*m.MapName] = true
		}
	}
	return sortedKeys(set)
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
