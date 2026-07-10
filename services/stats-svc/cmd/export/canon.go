package main

import (
	"fmt"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"
)

// canon.go — API GET URL'sini statik dosya yoluna çevirir. Frontend'deki
// apps/web/src/lib/staticdata.ts::staticApiPath ile BİREBİR aynı kuralı
// uygular; iki taraf ayrışırsa statik site 404 verir. Kural değişirse iki
// dosya birlikte değişmeli (test: canon_test.go).
//
// Kurallar:
//   - /api/v1/ öneki atılır, kalan segmentler dizin olur (son segment dosya).
//   - Sorgu parametreleri: değeri boş olanlar atılır, anahtara göre
//     sıralanır, her biri "k=v" olarak yazılır ve '~' ile eklenir.
//   - Dosya adına girmeyen her karakter ([^A-Za-z0-9._-]) '_' olur.

var unsafeChar = regexp.MustCompile(`[^A-Za-z0-9._-]`)

func slugPart(s string) string { return unsafeChar.ReplaceAllString(s, "_") }

// canonPath: "/api/v1/teams/X/summary?since=&roster_min=0"
//   → "teams/X/summary~roster_min_0.json"
func canonPath(rawURL string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	p := strings.TrimPrefix(u.Path, "/api/v1/")
	if p == u.Path {
		return "", fmt.Errorf("not an /api/v1/ url: %s", rawURL)
	}
	segs := strings.Split(strings.Trim(p, "/"), "/")
	for i, s := range segs {
		segs[i] = slugPart(s)
	}
	q := u.Query()
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	name := segs[len(segs)-1]
	for _, k := range keys {
		vals := append([]string(nil), q[k]...)
		sort.Strings(vals)
		for _, v := range vals {
			if v == "" {
				continue
			}
			name += "~" + slugPart(k+"="+v)
		}
	}
	return path.Join(append(segs[:len(segs)-1], name+".json")...), nil
}
