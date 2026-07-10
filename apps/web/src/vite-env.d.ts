/// <reference types="vite/client" />

interface ImportMetaEnv {
  // statik yayın modu: publish.sh build sırasında '1' yapar (staticdata.ts)
  readonly VITE_STATIC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
