import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [
    react(),
    {
      // When running v3 standalone (port 5174), serve shared images from root public/
      // so that absolute /concrete/* asset paths resolve correctly.
      name: 'serve-root-public',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url.startsWith('/concrete/') && !req.url.startsWith('/concrete/v3/')) {
            const rel = req.url.slice('/concrete/'.length)
            const filePath = path.resolve(__dirname, '../public', rel)
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
              const ext = path.extname(filePath)
              const mime = {
                '.png':  'image/png',
                '.svg':  'image/svg+xml',
                '.jpg':  'image/jpeg',
                '.webp': 'image/webp',
              }[ext] ?? 'application/octet-stream'
              res.setHeader('Content-Type', mime)
              res.end(fs.readFileSync(filePath))
              return
            }
          }
          next()
        })
      },
    },
  ],
  base: '/concrete/v3/',
  build: {
    outDir: '../public/v3',
    emptyOutDir: true,
  },
  server: { port: 5174 },
})
