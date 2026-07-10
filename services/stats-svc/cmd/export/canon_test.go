package main

import "testing"

// Bu tablo apps/web/src/lib/staticdata.ts ile ortak sözleşmedir: oradaki
// staticApiPath aynı girdilere aynı çıktıyı vermelidir.
func TestCanonPath(t *testing.T) {
	cases := []struct{ in, want string }{
		{"/api/v1/teams", "teams.json"},
		{"/api/v1/matches", "matches.json"},
		{"/api/v1/mlstatus", "mlstatus.json"},
		{"/api/v1/matches?team_id=ab-12&since=&roster_min=0",
			"matches~roster_min_0~team_id_ab-12.json"},
		{"/api/v1/teams/9f0/summary?since=&roster_min=0",
			"teams/9f0/summary~roster_min_0.json"},
		{"/api/v1/teams/9f0/tendencies", "teams/9f0/tendencies.json"},
		{"/api/v1/teams/9f0/control?map=de_mirage&since=&roster_min=0",
			"teams/9f0/control~map_de_mirage~roster_min_0.json"},
		{"/api/v1/report?team_id=9f0&map=de_mirage&since=&roster_min=0",
			"report~map_de_mirage~roster_min_0~team_id_9f0.json"},
		// URLSearchParams ekleme sırası ne olursa olsun anahtarlar sıralanır
		{"/api/v1/predict?team_id=9f0&map=de_nuke&side=T",
			"predict~map_de_nuke~side_T~team_id_9f0.json"},
		{"/api/v1/predict?side=CT&map=de_nuke&team_id=9f0&buy_type=full",
			"predict~buy_type_full~map_de_nuke~side_CT~team_id_9f0.json"},
		{"/api/v1/clusters?map=de_inferno&side=CT",
			"clusters~map_de_inferno~side_CT.json"},
		{"/api/v1/maplayout?map=de_dust2", "maplayout~map_de_dust2.json"},
		{"/api/v1/players/76561198.0/profile", "players/76561198.0/profile.json"},
		{"/api/v1/winprob", "winprob.json"},
		{"/api/v1/leaderboards", "leaderboards.json"},
		// dosya adına uymayan karakterler '_' olur (boşluk, %, / …)
		{"/api/v1/maplayout?map=de%20test", "maplayout~map_de_test.json"},
	}
	for _, c := range cases {
		got, err := canonPath(c.in)
		if err != nil {
			t.Fatalf("%s: %v", c.in, err)
		}
		if got != c.want {
			t.Errorf("canonPath(%s) = %s, want %s", c.in, got, c.want)
		}
	}
	if _, err := canonPath("/health"); err == nil {
		t.Error("non-api url should error")
	}
}
