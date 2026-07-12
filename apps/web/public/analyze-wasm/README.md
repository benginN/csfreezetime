# demoparser2 — WASM build (vendored)

Kaynak: https://github.com/LaihoE/demoparser (MIT), rev e8c1ad45 —
projenin parser-worker'ıyla AYNI pinli sürüm, `src/wasm` paketinden
`wasm-pack build --target web --release` ile üretildi.

Yeniden üretmek: demoparser reposunu klonla, aynı rev'e checkout,
`src/wasm` içinde yukarıdaki komut (getrandom için
`--cfg getrandom_backend="wasm_js"` rustflag'i gerekebilir).

Kullanım: apps/web/src/lib/analyze/* (statik sitede "kendi demonu
analiz et" — demo tarayıcıdan dışarı çıkmaz).
