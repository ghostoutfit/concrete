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
      name: 'serve-sub-apps',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          for (const sub of ['v1', 'v2', 'v3']) {
            if (req.url === `/concrete/${sub}` || req.url.startsWith(`/concrete/${sub}/`)) {
              // Strip base + sub prefix to get the relative path within the build
              const rel = req.url.slice(`/concrete/${sub}/`.length) || 'index.html'
              // Only serve files without extensions as index.html (SPA routing)
              const filePath = path.resolve(__dirname, `public/${sub}`, rel.includes('.') ? rel : 'index.html')
              if (fs.existsSync(filePath)) {
                const ext = path.extname(filePath)
                const mime = {
                  '.html': 'text/html; charset=utf-8',
                  '.js':   'application/javascript',
                  '.css':  'text/css',
                  '.svg':  'image/svg+xml',
                  '.png':  'image/png',
                }[ext] ?? 'application/octet-stream'
                res.setHeader('Content-Type', mime)
                res.end(fs.readFileSync(filePath))
                return
              }
            }
          }
          next()
        })
      },
    },
  ],
  base: '/concrete/',
})
