// Harita layout'u: telifli radar görseli yerine, arşivdeki pozisyon
// verisinden türetilen yürünebilir-alan silüeti + bölge (place) etiketleri.
// Tamamen deterministik; demo sayısı arttıkça silüet keskinleşir.
package main

import (
	"fmt"
	"net/http"
	"regexp"
	"sync"
)

// silüet çözünürlüğü: radar uzayı (1024) / cellPx birimlik hücreler
const layoutCellPx = 4

var mapNameRe = regexp.MustCompile(`^de_[a-z0-9_]+$`)

type mapLayout struct {
	Map    string     `json:"map"`
	CellPx int        `json:"cell_px"`
	Radar  *radarCal  `json:"radar"`
	Cells  [][3]int32 `json:"cells"` // [cx, cy, count] — radar hücresi başına ziyaret sayısı
	Places []struct {
		Name  string  `json:"name"`
		RX    float64 `json:"rx"`
		RY    float64 `json:"ry"`
		Count int64   `json:"count"`
	} `json:"places"`
}

var (
	layoutCache   = map[string]*mapLayout{}
	layoutCacheMu sync.Mutex
)

// GET /api/v1/maplayout?map=de_mirage
func (s *server) mapLayoutHandler(w http.ResponseWriter, r *http.Request) {
	mapName := r.URL.Query().Get("map")
	if !mapNameRe.MatchString(mapName) {
		writeErr(w, 400, fmt.Errorf("geçersiz harita adı"))
		return
	}
	layoutCacheMu.Lock()
	cached := layoutCache[mapName]
	layoutCacheMu.Unlock()
	if cached != nil {
		writeJSON(w, 200, cached)
		return
	}
	ctx := r.Context()

	cal, err := s.radarFor(ctx, mapName)
	if err != nil {
		writeErr(w, 404, err)
		return
	}

	out := &mapLayout{Map: mapName, CellPx: layoutCellPx, Radar: cal}

	// Yürünebilir alan: radar hücresi başına canlı-oyuncu ziyaret sayısı.
	// Dönüşüm sabitleri DB'den (maps) geldiği için literal gömmek güvenli.
	cellQ := fmt.Sprintf(`
		SELECT toInt32(intDiv(toInt32((x - (%f)) / %f), %d))  AS cx,
		       toInt32(intDiv(toInt32(((%f) - y) / %f), %d))  AS cy,
		       toInt32(count())                               AS cnt
		FROM player_ticks
		WHERE map_name = ? AND is_alive
		GROUP BY cx, cy`,
		cal.PosX, cal.Scale, layoutCellPx, cal.PosY, cal.Scale, layoutCellPx)
	rows, err := s.ch.Query(ctx, cellQ, mapName)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	for rows.Next() {
		var cx, cy, cnt int32
		if err := rows.Scan(&cx, &cy, &cnt); err != nil {
			rows.Close()
			writeErr(w, 500, err)
			return
		}
		out.Cells = append(out.Cells, [3]int32{cx, cy, cnt})
	}
	rows.Close()

	// Bölge etiketleri: place adı + pozisyonlarının radar ağırlık merkezi
	placeQ := fmt.Sprintf(`
		SELECT place,
		       avg((x - (%f)) / %f)  AS rx,
		       avg(((%f) - y) / %f)  AS ry,
		       count()               AS cnt
		FROM player_ticks
		WHERE map_name = ? AND place != '' AND is_alive
		GROUP BY place
		HAVING cnt > 2000
		ORDER BY cnt DESC
		LIMIT 18`,
		cal.PosX, cal.Scale, cal.PosY, cal.Scale)
	prows, err := s.ch.Query(ctx, placeQ, mapName)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer prows.Close()
	for prows.Next() {
		var p struct {
			Name  string  `json:"name"`
			RX    float64 `json:"rx"`
			RY    float64 `json:"ry"`
			Count int64   `json:"count"`
		}
		var cnt uint64
		if err := prows.Scan(&p.Name, &p.RX, &p.RY, &cnt); err != nil {
			writeErr(w, 500, err)
			return
		}
		p.Count = int64(cnt)
		out.Places = append(out.Places, p)
	}

	layoutCacheMu.Lock()
	layoutCache[mapName] = out
	layoutCacheMu.Unlock()
	writeJSON(w, 200, out)
}
