# Backlog — kullanıcı istekleri (plan sonunda topluca ele alınacak)

Kural: yeni istekler buraya eklenir, akış bölünmez. Veri toplamayı etkileyen
maddeler (parser değişikliği gerektirenler) beklemeden yapılır.

## Frontend / UX (kalıcı arayüz fazında)
- [ ] Genel kullanıcı dostu tasarım (test sayfası user-friendly değil)
- [ ] Takım seçimi: takım listesi → seçilen takımın maçları
- [ ] Maç seçicinin detaylanması (takım adları, tarih, skor — "rastgele sayı" değil)
- [ ] Harita görselleri birebir net (radar PNG'leri; static/radars/README.md'deki
      manuel yol mevcut, kalıcı çözüm frontend fazında kararlaştırılacak)

## Veri / parser (erken yapılması avantajlı)
- [ ] Demolardan takım adlarının çıkarılması (team_clan_name) → teams tablosu
      dolsun, matches.team_a/b bağlansın (takım seçimi özelliğinin ön koşulu)

## Tamamlananlar
- [x] Silahlar görünsün (oyuncu yanında aktif silah) — a3e695f
- [x] Bombalar görünsün: smoke 20 sn, molotof 7 sn, flash/HE patlama — a3e695f
- [x] Kim kör oluyor görünsün (flash_remaining'ten beyaz hale) — a3e695f
- [x] Cana göre gösterge (HP halkası) — a3e695f
- [x] Maç seçicide dosya adları — a3e695f
- [x] Harita silüeti 2× çözünürlük + radar PNG desteği — a3e695f
