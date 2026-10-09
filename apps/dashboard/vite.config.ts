import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const guard = process.env.GUARD_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/v1': guard, '/docs': guard, '/metrics': guard },
  },
});
