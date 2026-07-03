# Radar görselleri (opsiyonel)

Bu klasöre `de_mirage.png`, `de_dust2.png`... koyarsan test sayfası harita
arka planı olarak **veri silüeti yerine gerçek radar görselini** kullanır.

Görseller telifli oyun içeriği olduğundan depoya dahil edilmez (klasör
gitignore'da). Kendi CS2 kurulumundan çıkarabilirsin:

1. [Source2Viewer](https://valveresourceformat.github.io/) aç
2. `game/csgo/pak01_dir.vpk` → `panorama/images/overheadmaps/` içinden
   `de_mirage_radar_psd.vtex_c` gibi dosyaları PNG olarak dışa aktar
3. Bu klasöre `de_<harita>.png` adıyla kaydet (1024×1024)
4. **Çok katlı haritalarda** (nuke, vertigo) iki dosya kullan:
   - `de_nuke.png` → üst kat radarı
   - `de_nuke_lower.png` → alt kat radarı
   Replay'deki "Üst kat / Alt kat" düğmesi otomatik olarak doğru görseli seçer;
   alt kat görseli yoksa alt katta üst kat görseli/silüet gösterilir.

Radar görseli, `maps` tablosundaki kalibrasyonla (pos_x/pos_y/scale) aynı
uzayı kullanır — CS2'nin kendi overview meta verisi olduğu için birebir oturur.
4. **Vektör (SVG) radar da desteklenir** — `de_<harita>.svg` PNG'den önce denenir;
   zoom'da çözünürlük sınırı olmadan keskin kalır. AI dosyasını SVG olarak export et.
