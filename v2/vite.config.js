import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/concrete/v2/',
  build: {
    outDir: '../public/v2',
    emptyOutDir: true,
  },
})
