/**
 * Dependency-free static file server for local verification.
 *
 *   node scripts/static-server.mjs [port] [root]
 *
 * Serves the repo root (or a given directory) so index.html can be opened at
 * http://localhost:8080/ *exactly as a static host will serve it* — same relative
 * paths, same MIME types, same subpath behaviour. Opening index.html via file://
 * does NOT work for ES modules or fetch(), so a real server is needed from the start.
 *
 * Correct MIME types matter: a module served as text/plain is refused by the browser,
 * and .wasm must be application/wasm.
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, normalize } from 'node:path'

const root = process.argv[3]
  ? normalize(process.argv[3])
  : join(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.argv[2]) || 8080

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pdf': 'application/pdf',
}

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    if (urlPath === '/') urlPath = '/index.html'

    const filePath = join(root, normalize(urlPath).replace(/^(\.\.[/\\])+/, ''))
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end('Forbidden')
      return
    }

    const info = await stat(filePath).catch(() => null)
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + urlPath)
      return
    }

    const body = await readFile(filePath)
    res.writeHead(200, {
      'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream',
      'Content-Length': body.length,
      // No caching locally: a stale module silently invalidates your test run.
      'Cache-Control': 'no-store',
    })
    res.end(body)
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Server error: ' + err.message)
  }
})

server.listen(port, () => {
  console.log(`serving ${root}`)
  console.log(`  http://localhost:${port}/`)
})
