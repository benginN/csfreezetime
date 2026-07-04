"""Veri bütünlüğü onarımları (idempotent; her koşuda önce bu çalışır).

1) Ters raunt etiketi: parça (p1/p2) demoların kesim anındaki rauntlarda
   rounds.t_team_id/ct_team_id, PRS taraflarıyla çelişebiliyor (taraf
   değişimi tespiti parçanın son raundunda şaşıyor). Kural muhafazakâr:
   T etiketli takımın HİÇBİR oyuncusu PRS'te T değil VE CT etiketli
   takımın ≥3 oyuncusu T ise → etiket çifti o raunt için takas edilir.
   (winner_side ve buy kolonları taraf-bazlı olduğundan dokunulmaz.)
"""

from __future__ import annotations


def run(pgconn) -> int:
    with pgconn.cursor() as cur:
        cur.execute(
            """
            WITH bad AS (
              SELECT r.match_id, r.round_number
              FROM rounds r
              WHERE r.t_team_id IS NOT NULL AND r.ct_team_id IS NOT NULL
                AND (SELECT count(*) FROM player_round_states s
                     JOIN players p ON p.player_id = s.player_id
                     WHERE (s.match_id, s.round_number) = (r.match_id, r.round_number)
                       AND s.side = 'T' AND p.current_team_id = r.ct_team_id) >= 3
                AND (SELECT count(*) FROM player_round_states s
                     JOIN players p ON p.player_id = s.player_id
                     WHERE (s.match_id, s.round_number) = (r.match_id, r.round_number)
                       AND s.side = 'T' AND p.current_team_id = r.t_team_id) = 0
            )
            UPDATE rounds r
            SET t_team_id = r.ct_team_id, ct_team_id = r.t_team_id
            FROM bad
            WHERE (r.match_id, r.round_number) = (bad.match_id, bad.round_number)
            """
        )
        n = cur.rowcount
    pgconn.commit()
    return n
