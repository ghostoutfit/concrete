import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'spawn-sub-apps',
      configureServer(server) {
        const v3 = spawn('npm', ['run', 'dev'], {
          cwd: path.resolve(__dirname, 'v3'),
          stdio: 'inherit',
          shell: true,
        })
        const v4 = spawn('npm', ['run', 'dev'], {
          cwd: path.resolve(__dirname, 'v4'),
          stdio: 'inherit',
          shell: true,
        })
        server.httpServer?.on('close', () => { v3.kill(); v4.kill() })
      },
    },
  ],
  base: '/concrete/',
  server: {
    proxy: {
      '/concrete/v3': { target: 'http://localhost:5174', ws: true, changeOrigin: true },
      '/concrete/v4': { target: 'http://localhost:5175', ws: true, changeOrigin: true },
    },
  },
})
