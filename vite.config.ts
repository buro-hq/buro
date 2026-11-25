import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4317,
    strictPort: true,
    watch: { ignored: ['**/.buro/**'] },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id))
            return 'react';

          if (id.includes('node_modules'))
            return 'ui';
        },
      },
    },
  },
});
