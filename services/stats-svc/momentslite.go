package main

import (
	"fmt"
	"net/http"

	"github.com/google/uuid"
)

// Moments-lite indeksi: statik sitenin harita-başına kompakt olay dizini.
// Exporter bu ucu her harita için sayfalar; istemci (lib/momentslite.ts)
// aynı DSL alt kümesini (kill/grenade/bomb/economy) bu sütunlu veri
// üzerinde değerlendirir. presence CH gerektirdiğinden stüdyoda kalır.
// Sütun sözlükleri (buy/side/grenade sırası) istemciyle BİREBİR sözleşmedir.

type miMatch struct {
	ID  uuid.UUID `json:"id"`
	Src string    `json:"src"`
}

type miRounds struct {
	M  []int32   `json:"m"`  // matches dizinine indeks
	N  []int16   `json:"n"`  // round_number
	TB []int8    `json:"tb"` // buy: 0=yok, 1..5 = pistol,eco,semi,force,full
	CB []int8    `json:"cb"`
	TE []int32   `json:"te"` // equip value (-1 = bilinmiyor; SQL NULL karşılığı)
	CE []int32   `json:"ce"`
	FE []int32   `json:"fe"` // freeze_end_tick
	BS []int8    `json:"bs"` // bomb site: 0=yok, 1=A, 2=B
	BP []int32   `json:"bp"` // bomb_plant_tick (0 = plant yok)
	ER []int16   `json:"er"` // end_reasons dizinine indeks
	ET []int32   `json:"et"` // end_tick
}

type miKills struct {
	RI []int32   `json:"ri"` // rounds satır indeksi
	T  []int32   `json:"t"`
	RT []float32 `json:"rt"`
	W  []int32   `json:"w"`  // weapons dizinine indeks
	F  []int8    `json:"f"`  // bit: 1=first_kill, 2=trade, 4=headshot
	AP []int32   `json:"ap"` // places: 0=yok, i+1
	VP []int32   `json:"vp"`
	A  []int32   `json:"a"`  // players: 0=yok, i+1 (saldırgan)
	S  []int8    `json:"s"`  // 0=bilinmiyor, 1=T, 2=CT (saldırgan tarafı)
}

type miGrenades struct {
	RI []int32 `json:"ri"`
	T  []int32 `json:"t"` // detonate_tick
	G  []int8  `json:"g"` // 1..6 = flash,smoke,he,molotov,incendiary,decoy
	S  []int8  `json:"s"`
	F  []int8  `json:"f"` // bit: 1=first_of_type_in_round
	P  []int32 `json:"p"` // players: 0=yok, i+1 (atan)
}

type momentsIndex struct {
	V          int        `json:"v"`
	Map        string     `json:"map"`
	Matches    []miMatch  `json:"matches"`
	Weapons    []string   `json:"weapons"`
	Places     []string   `json:"places"`
	Players    []string   `json:"players"`
	EndReasons []string   `json:"end_reasons"`
	Rounds     miRounds   `json:"rounds"`
	Kills      miKills    `json:"kills"`
	Grenades   miGrenades `json:"grenades"`
}

// interner: string → 1-tabanlı sözlük indeksi ("" → 0)
type interner struct {
	idx  map[string]int32
	list []string
}

func newInterner() *interner { return &interner{idx: map[string]int32{}} }

func (in *interner) get(s string) int32 {
	if s == "" {
		return 0
	}
	if i, ok := in.idx[s]; ok {
		return i
	}
	in.list = append(in.list, s)
	in.idx[s] = int32(len(in.list))
	return in.idx[s]
}

var miBuy = map[string]int8{"pistol": 1, "eco": 2, "semi": 3, "force": 4, "full": 5}
var miGren = map[string]int8{"flash": 1, "smoke": 2, "he": 3, "molotov": 4, "incendiary": 5, "decoy": 6}

func miSide(s string) int8 {
	switch s {
	case "T":
		return 1
	case "CT":
		return 2
	}
	return 0
}

// GET /api/v1/export/moments-index?map=de_mirage
func (s *server) momentsIndexHandler(w http.ResponseWriter, r *http.Request) {
	mapName := r.URL.Query().Get("map")
	if mapName == "" {
		writeErr(w, 400, fmt.Errorf("map is required"))
		return
	}
	ctx := r.Context()
	out := &momentsIndex{V: 1, Map: mapName}
	weapons := newInterner()
	places := newInterner()
	players := newInterner()
	endReasons := newInterner()
	matchIdx := map[uuid.UUID]int32{}
	roundIdx := map[[2]int64]int32{} // [matchIdx, roundNumber] → rounds satırı

	rrows, err := s.pg.Query(ctx, `
		SELECT r.match_id, COALESCE(m.source,''), r.round_number,
		       COALESCE(r.freeze_end_tick,0), COALESCE(r.end_tick,0),
		       COALESCE(r.end_reason,''), COALESCE(r.bomb_plant_tick,0),
		       COALESCE(r.bomb_site,''), COALESCE(r.t_equip_value,-1),
		       COALESCE(r.ct_equip_value,-1), COALESCE(r.t_buy_type,''),
		       COALESCE(r.ct_buy_type,'')
		FROM rounds r JOIN matches m ON m.match_id = r.match_id
		WHERE m.status = 'ready' AND m.map_name = $1
		ORDER BY r.match_id, r.round_number`, mapName)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer rrows.Close()
	for rrows.Next() {
		var mid uuid.UUID
		var src, er, bs, tb, cb string
		var n int16
		var fe, et, bp, te, ce int32
		if err := rrows.Scan(&mid, &src, &n, &fe, &et, &er, &bp, &bs, &te, &ce, &tb, &cb); err != nil {
			writeErr(w, 500, err)
			return
		}
		mi, ok := matchIdx[mid]
		if !ok {
			mi = int32(len(out.Matches))
			matchIdx[mid] = mi
			out.Matches = append(out.Matches, miMatch{ID: mid, Src: src})
		}
		roundIdx[[2]int64{int64(mi), int64(n)}] = int32(len(out.Rounds.M))
		var bsi int8
		switch bs {
		case "A":
			bsi = 1
		case "B":
			bsi = 2
		}
		ro := &out.Rounds
		ro.M = append(ro.M, mi)
		ro.N = append(ro.N, n)
		ro.TB = append(ro.TB, miBuy[tb])
		ro.CB = append(ro.CB, miBuy[cb])
		ro.TE = append(ro.TE, te)
		ro.CE = append(ro.CE, ce)
		ro.FE = append(ro.FE, fe)
		ro.BS = append(ro.BS, bsi)
		ro.BP = append(ro.BP, bp)
		ro.ER = append(ro.ER, int16(endReasons.get(er)))
		ro.ET = append(ro.ET, et)
	}
	if err := rrows.Err(); err != nil {
		writeErr(w, 500, err)
		return
	}

	krows, err := s.pg.Query(ctx, `
		SELECT k.match_id, k.round_number, COALESCE(k.tick,0),
		       COALESCE(k.round_time,0), COALESCE(lower(k.weapon),''),
		       COALESCE(k.is_first_kill,false), COALESCE(k.is_trade,false),
		       COALESCE(k.headshot,false), COALESCE(k.attacker_place,''),
		       COALESCE(k.victim_place,''), COALESCE(p.nickname,''),
		       COALESCE(s.side,'')
		FROM kills k
		JOIN matches m ON m.match_id = k.match_id
		     AND m.status = 'ready' AND m.map_name = $1
		LEFT JOIN players p ON p.player_id = k.attacker_id
		LEFT JOIN player_round_states s ON s.match_id = k.match_id
		     AND s.round_number = k.round_number AND s.player_id = k.attacker_id
		ORDER BY k.match_id, k.round_number, k.tick`, mapName)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer krows.Close()
	for krows.Next() {
		var mid uuid.UUID
		var n int16
		var tick int32
		var rt float32
		var weapon, ap, vp, nick, side string
		var first, trade, hs bool
		if err := krows.Scan(&mid, &n, &tick, &rt, &weapon, &first, &trade, &hs, &ap, &vp, &nick, &side); err != nil {
			writeErr(w, 500, err)
			return
		}
		mi, ok := matchIdx[mid]
		if !ok {
			continue
		}
		ri, ok := roundIdx[[2]int64{int64(mi), int64(n)}]
		if !ok {
			continue
		}
		var f int8
		if first {
			f |= 1
		}
		if trade {
			f |= 2
		}
		if hs {
			f |= 4
		}
		k := &out.Kills
		k.RI = append(k.RI, ri)
		k.T = append(k.T, tick)
		k.RT = append(k.RT, rt)
		k.W = append(k.W, weapons.get(weapon))
		k.F = append(k.F, f)
		k.AP = append(k.AP, places.get(ap))
		k.VP = append(k.VP, places.get(vp))
		k.A = append(k.A, players.get(nick))
		k.S = append(k.S, miSide(side))
	}
	if err := krows.Err(); err != nil {
		writeErr(w, 500, err)
		return
	}

	grows, err := s.pg.Query(ctx, `
		SELECT g.match_id, g.round_number, g.detonate_tick, g.type,
		       COALESCE(g.side,''), COALESCE(g.is_first_of_type_in_round,false),
		       COALESCE(p.nickname,'')
		FROM grenades g
		JOIN matches m ON m.match_id = g.match_id
		     AND m.status = 'ready' AND m.map_name = $1
		LEFT JOIN players p ON p.player_id = g.thrower_id
		WHERE g.detonate_tick IS NOT NULL
		ORDER BY g.match_id, g.round_number, g.detonate_tick`, mapName)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer grows.Close()
	for grows.Next() {
		var mid uuid.UUID
		var n int16
		var tick int32
		var typ, side, nick string
		var first bool
		if err := grows.Scan(&mid, &n, &tick, &typ, &side, &first, &nick); err != nil {
			writeErr(w, 500, err)
			return
		}
		mi, ok := matchIdx[mid]
		if !ok {
			continue
		}
		ri, ok := roundIdx[[2]int64{int64(mi), int64(n)}]
		if !ok {
			continue
		}
		var f int8
		if first {
			f |= 1
		}
		g := &out.Grenades
		g.RI = append(g.RI, ri)
		g.T = append(g.T, tick)
		g.G = append(g.G, miGren[typ])
		g.S = append(g.S, miSide(side))
		g.F = append(g.F, f)
		g.P = append(g.P, players.get(nick))
	}
	if err := grows.Err(); err != nil {
		writeErr(w, 500, err)
		return
	}

	out.Weapons = weapons.list
	out.Places = places.list
	out.Players = players.list
	out.EndReasons = endReasons.list
	writeJSON(w, 200, out)
}
