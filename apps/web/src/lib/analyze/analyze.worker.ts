/// <reference lib="webworker" />
// WASM Analyze worker'ı: demo baytlarını alır, vendor'lu demoparser2 wasm
// paketini yükler, shaper'la Bundle'a çevirir. UI thread'i hiç kilitlenmez;
// demo dosyası tarayıcıdan dışarı ÇIKMAZ (ağ isteği yalnız wasm paketine).
import { shapeDemo, type ParserApi } from './shaper';

interface InMsg { bytes: ArrayBuffer; name: string; wasmBase: string }

let api: ParserApi | null = null;

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
  try {
    const { bytes, name, wasmBase } = e.data;
    if (!api) {
      post({ phase: 'loading parser (~3 MB, once)' });
      const mod = await import(/* @vite-ignore */ `${wasmBase}demoparser2.js`);
      await mod.default(`${wasmBase}demoparser2_bg.wasm`);
      api = mod as unknown as ParserApi;
    }
    const res = shapeDemo(api, new Uint8Array(bytes), name, (p) => post({ phase: p }));
    post({ done: true, bundle: res.bundle, mapName: res.mapName, warnings: res.warnings });
  } catch (err) {
    post({ error: err instanceof Error ? err.message : String(err) });
  }
};
