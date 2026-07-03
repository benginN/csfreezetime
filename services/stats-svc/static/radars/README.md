# Radar görselleri (opsiyonel)

Bu klasöre `de_mirage.png`, `de_dust2.png`... koyarsan test sayfası harita
arka planı olarak **veri silüeti yerine gerçek radar görselini** kullanır.

Görseller telifli oyun içeriği olduğundan depoya dahil edilmez (klasör
gitignore'da). Kendi CS2 kurulumundan çıkarabilirsin:

1. [Source2Viewer](https://valveresourceformat.github.io/) aç
2. `game/csgo/pak01_dir.vpk` → `panorama/images/overheadmaps/` içinden
   `de_mirage_radar_psd.vtex_c` gibi dosyaları PNG olarak dışa aktar
3. Bu klasöre `de_<harita>.png` adıyla kaydet (1024×1024)

Radar görseli, `maps` tablosundaki kalibrasyonla (pos_x/pos_y/scale) aynı
uzayı kullanır — CS2'nin kendi overview meta verisi olduğu için birebir oturur.
