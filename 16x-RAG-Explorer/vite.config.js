import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          transformers: ['@xenova/transformers'],
          pdf: ['pdfjs-dist']
        }
      }
    }
  },
  server: { port: 5173, strictPort: true }
});
