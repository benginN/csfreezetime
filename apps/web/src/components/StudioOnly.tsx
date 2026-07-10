// Statik yayında sunucu isteyen sayfaların yerine geçen not (Faz Y1).
// Bu özellikler ClickHouse üstünde canlı sorgu ister; statik sitede yoktur.
export default function StudioOnly({ feature }: { feature: string }) {
  return (
    <div className="panel" style={{ maxWidth: 640, margin: '48px auto', textAlign: 'center' }}>
      <h2>{feature}</h2>
      <p className="meta">
        This feature runs live queries against the full tick database, so it is
        not available on the static site. Freezetime is open source — run the
        self-hosted studio to use it:
      </p>
      <p>
        <a href="https://github.com/benginN/csfreezetime" target="_blank" rel="noreferrer">
          github.com/benginN/csfreezetime
        </a>
      </p>
    </div>
  );
}
