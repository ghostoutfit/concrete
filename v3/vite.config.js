import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/concrete/v3/',
  build: {
    outDir: '../public/v3',
    emptyOutDir: true,
  },
})
