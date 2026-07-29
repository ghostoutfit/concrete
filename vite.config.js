import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import http from 'http'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const V3_DEV_PORT = 5174

function serveBuiltFile(sub, url, res, next) {
  const rel = url.slice(`/concrete/${sub}/`.length) || 'index.html'
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
  } else {
    next()
  }
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'serve-sub-apps',
      configureServer(server) {
        // Auto-start v3 dev server; kill it when root server closes
        const v3Dev = spawn('npm', ['run', 'dev'], {
          cwd: path.resolve(__dirname, 'v3'),
          stdio: 'inherit',
          shell: true,
        })
        server.httpServer?.on('close', () => v3Dev.kill())

        server.middlewares.use((req, res, next) => {
          // v3: proxy to live dev server, fall back to built files
          if (req.url === '/concrete/v3' || req.url.startsWith('/concrete/v3/')) {
            const opts = {
              hostname: 'localhost',
              port: V3_DEV_PORT,
              path: req.url,
              method: req.method,
              headers: { ...req.headers, host: `localhost:${V3_DEV_PORT}` },
            }
            const proxy = http.request(opts, pRes => {
              res.writeHead(pRes.statusCode, pRes.headers)
              pRes.pipe(res, { end: true })
            })
            proxy.on('error', () => serveBuiltFile('v3', req.url, res, next))
            req.pipe(proxy, { end: true })
            return
          }

          // v1, v2: serve from built files
          for (const sub of ['v1', 'v2']) {
            if (req.url === `/concrete/${sub}` || req.url.startsWith(`/concrete/${sub}/`)) {
              serveBuiltFile(sub, req.url, res, next)
              return
            }
          }

          next()
        })
      },
    },
  ],
  base: '/concrete/',
})
