import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Geliştirmede API ve radar görselleri stats-svc'den (:8090) proxy'lenir;
// üretimde stats-svc dist'i doğrudan servis ettiği için proxy devre dışıdır.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8090',
      '/radars': 'http://localhost:8090',
    },
  },
  build: { chunkSizeWarningLimit: 1200 },
});
