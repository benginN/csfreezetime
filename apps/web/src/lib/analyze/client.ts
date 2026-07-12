// Tarayıcıda demo parse etme — Analyze sayfası ve statik My DB'nin ortak
// kapısı. Worker'ı kurar, wasm paketini yükletir, Bundle döndürür.
import type { Bundle } from '../localdb';

export function parseDemoInBrowser(
  file: File,
  onPhase: (s: string) => void,
): Promise<Bundle> {
  return new Promise((resolve, reject) => {
    (async () => {
      const bytes = await file.arrayBuffer();
      const worker = new Worker(
        new URL('./analyze.worker.ts', import.meta.url), { type: 'module' });
      const wasmBase = new URL(
        `${import.meta.env.BASE_URL}analyze-wasm/`, window.location.origin).href;
      worker.onmessage = (e) => {
        const m = e.data as { phase?: string; error?: string; done?: boolean; bundle?: Bundle };
        if (m.phase) onPhase(m.phase);
        if (m.error) { worker.terminate(); reject(new Error(m.error)); }
        if (m.done && m.bundle) { worker.terminate(); resolve(m.bundle); }
      };
      worker.onerror = (err) => { worker.terminate(); reject(new Error(err.message || 'worker crashed')); };
      worker.postMessage({ bytes, name: file.name, wasmBase }, [bytes]);
    })().catch(reject);
  });
}
