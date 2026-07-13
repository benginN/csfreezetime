import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { teamHue, teamInitials } from '../lib/rounds';

// Collabs barı: publish, T7 kökündeki collabs.txt'yi data/collabs.json'a
// çevirir (izinli takım adları). Dosya yoksa/boşsa bar hiç görünmez;
// stüdyo modunda da 404 sessizce yutulur.
//
// Sitenin footer'ı olarak SABİT alt bar — her sayfada, içeriğin üstünde
// yüzer (z-index nav'dan yüksek). ✕ ile kapanır; kapatma sekme oturumu
// boyunca hatırlanır (sessionStorage — sonraki ziyarette geri gelir).
//
// Kayma tekniği: bir kopyanın genişliği ölçülür, kopya sayısı görünür
// alanı aşacak kadar artırılır ve animasyon tam BİR kopya genişliği
// kaydırır — içerik azken de boşluksuz, sabit piksel hızında döngü.
const CLOSED_KEY = 'fz_collabs_closed';

export default function CollabsBar() {
  const [closed, setClosed] = useState(() => sessionStorage.getItem(CLOSED_KEY) === '1');
  const q = useQuery({
    queryKey: ['collabs'],
    queryFn: async (): Promise<string[]> => {
      const r = await fetch(import.meta.env.BASE_URL + 'data/collabs.json');
      if (!r.ok) return [];
      const j: unknown = await r.json();
      return Array.isArray(j) ? j.filter((n): n is string => typeof n === 'string' && n.trim() !== '') : [];
    },
    staleTime: Infinity,
    retry: false,
  });
  const names = q.data ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const unitRef = useRef<HTMLSpanElement>(null);
  const [unitW, setUnitW] = useState(0);
  const [copies, setCopies] = useState(2);
  useLayoutEffect(() => {
    const measure = () => {
      if (!scrollRef.current || !unitRef.current) return;
      const uw = unitRef.current.scrollWidth;
      if (uw > 0) {
        setUnitW(uw);
        setCopies(Math.max(2, Math.ceil(scrollRef.current.clientWidth / uw) + 1));
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [names.join('|'), closed]);
  if (closed || !names.length) return null;
  const half = names.map((n) => (
    <span key={n} className="collabname">
      <span className="monogram sm" style={{ background: `hsl(${teamHue(n)},45%,32%)` }}>
        {teamInitials(n)}
      </span>
      {n}
    </span>
  ));
  return (
    <div className="collabsbar">
      <span className="meta collabslabel">used by</span>
      <div className="collabsscroll" ref={scrollRef}>
        <div
          className="collabstrack"
          style={unitW > 0 ? {
            '--shift': `${unitW}px`,
            animationDuration: `${unitW / 30}s`, // 30 px/sn sabit hız
            animationPlayState: 'running',
          } as React.CSSProperties : undefined}
        >
          {Array.from({ length: copies }, (_, i) => (
            <span key={i} className="collabshalf" ref={i === 0 ? unitRef : undefined}>{half}</span>
          ))}
        </div>
      </div>
      <button
        className="collabsclose"
        title="hide"
        aria-label="hide collabs bar"
        onClick={() => { sessionStorage.setItem(CLOSED_KEY, '1'); setClosed(true); }}
      >
        ✕
      </button>
    </div>
  );
}
