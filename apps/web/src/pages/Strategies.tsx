import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

// Küme isimlendirme (insan döngüde, §6.2): koç temsilci rauntları izler,
// kümeye ad verir; adlar eğilim/tahmin panellerinde ve maç rozetlerinde görünür.
export default function Strategies() {
  const qc = useQueryClient();
  const matches = useQuery({ queryKey: ['matches', ''], queryFn: () => api.matches() });
  const maps = useMemo(
    () => [...new Set((matches.data ?? []).map((m) => m.map_name).filter(Boolean))].sort() as string[],
    [matches.data],
  );
  const [mapName, setMapName] = useState('');
  const [side, setSide] = useState<'T' | 'CT'>('T');
  const effMap = mapName || maps[0] || '';

  const clusters = useQuery({
    queryKey: ['clusters', effMap, side],
    queryFn: () => api.clusters(effMap, side),
    enabled: !!effMap,
  });

  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  async function save(clusterId: number) {
    await api.renameCluster(effMap, side, clusterId, draft.trim());
    setEditing(null);
    qc.invalidateQueries({ queryKey: ['clusters', effMap, side] });
    qc.invalidateQueries({ queryKey: ['tendencies'] });
  }

  return (
    <>
      <h1>Stratejiler <span className="meta">(otomatik kümeler — izleyip adlandır)</span></h1>
      <div className="toolbar">
        <select value={effMap} onChange={(e) => setMapName(e.target.value)}>
          {maps.map((m) => <option key={m}>{m}</option>)}
        </select>
        <select value={side} onChange={(e) => setSide(e.target.value as 'T' | 'CT')}>
          <option>T</option><option>CT</option>
        </select>
        {clusters.isLoading && <span className="meta">yükleniyor…</span>}
      </div>

      <div className="grid cards">
        {(clusters.data ?? []).map((c) => (
          <div key={c.cluster_id} className="card">
            <div className="teams">
              {editing === c.cluster_id ? (
                <span style={{ display: 'flex', gap: 6, flex: 1 }}>
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && save(c.cluster_id)}
                    placeholder='ör. "B rush", "A execute (yavaş)"'
                    style={{ flex: 1 }}
                  />
                  <button onClick={() => save(c.cluster_id)}>✓</button>
                  <button className="ghost" onClick={() => setEditing(null)}>✕</button>
                </span>
              ) : (
                <>
                  <span>{c.label ?? <span className="meta">küme #{c.cluster_id} (isimsiz)</span>}</span>
                  <button
                    className="ghost"
                    onClick={() => { setEditing(c.cluster_id); setDraft(c.label ?? ''); }}
                  >
                    ✏️ adlandır
                  </button>
                </>
              )}
            </div>
            <div className="meta" style={{ margin: '8px 0' }}>
              {c.size} raunt · bölge akışı:{' '}
              {c.top_places.map((p) => p.place).join(' → ') || '—'}
            </div>
            <div className="meta">
              Temsilci rauntlar (izle → adlandır):{' '}
              {c.representatives.map((r, i) => (
                <span key={i}>
                  {i > 0 && ' · '}
                  <Link to={`/match/${r.match_id}/round/${r.round_number}`}>
                    ▶ r{r.round_number}
                  </Link>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      {!clusters.isLoading && (clusters.data ?? []).length === 0 && (
        <p className="meta">Bu harita/taraf için küme yok (ml-jobs çalıştırılmalı).</p>
      )}
    </>
  );
}
