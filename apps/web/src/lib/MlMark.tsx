// 🧠 ML işareti: makine öğrenmesi hattından gelen her sayının yanına konur;
// imleç üzerine gelince kaynağı açıklar. (Kullanıcı isteği: "yapay zekâ ile
// bulunan şeyler belli olsun".) Tek yerden yönetilir ki metin tutarlı kalsın.
const DEFAULT_NOTE =
  'Machine learning — computed locally by the Freezetime ML pipeline '
  + '(clustering / calibrated models), fully deterministic, no external AI. '
  + 'How it works and how well: see the ML Lab page.';

export function MlMark({ note }: { note?: string }) {
  return (
    <span
      title={note ?? DEFAULT_NOTE}
      style={{ cursor: 'help', marginLeft: 4, fontSize: '0.85em' }}
      aria-label="machine learning"
    >
      🧠
    </span>
  );
}
