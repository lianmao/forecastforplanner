/**
 * Real-browser verification for a browser-only static app, over the Chrome
 * DevTools Protocol.
 *
 *   node scripts/serve.mjs &
 *   node scripts/browser-check.mjs http://localhost:8080/ [driver.mjs]
 *   node scripts/browser-check.mjs https://<owner>.github.io/<repo>/ [driver.mjs]
 *
 * Why this exists: jsdom covers DOM logic cheaply, but it has no layout engine and
 * no real canvas. Blank charts, 0x0 canvases, CSS-overridden [hidden] and broken
 * relative paths only show up in a real browser — and a deployment must be tested
 * against its real URL, not just localhost.
 *
 * Relies only on Node's built-in `WebSocket` and `fetch` (Node 22+) plus an already
 * installed Chromium, so there is nothing extra to install.
 *
 * DRIVER CONTRACT
 *   The optional driver file must contain a single expression:
 *     (async () => { ... ; return JSON.stringify(results) })()
 *   It runs inside the page, in the same origin as the app, so it can import nothing
 *   but can click real elements and read the real rendered DOM.
 *
 * READY GATE (important)
 *   `--ready <expr>` defaults to `document.readyState === 'complete'`. Do NOT gate
 *   only on an element existing: with deferred/module scripts the shell HTML is
 *   parsed long before your app runs, so a placeholder element like
 *   `<div id="status">loading…</div>` exists while nothing is wired up yet. Gate on
 *   a value your app sets (e.g. `document.getElementById('status').textContent === 'ready'`),
 *   otherwise your first click lands on an element with no listener attached.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const URL_TO_OPEN = process.argv[2] || 'http://localhost:8080/'
const DRIVER_FILE = process.argv[3]
const READY_EXPR = process.env.READY_EXPR || "document.readyState === 'complete'"
const PORT = Number(process.env.CDP_PORT || 9333)
// 本地改动：允许覆盖窗口尺寸，便于在真浏览器里验证响应式断点（1440x1000 / 420x800）
const WINDOW_SIZE = process.env.WINDOW_SIZE || '1440,1000'
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS || 90000)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Newest Playwright-managed Chromium, then common system installs. */
function findChrome() {
  const cache = join(homedir(), 'Library/Caches/ms-playwright') // macOS
  const linuxCache = join(homedir(), '.cache/ms-playwright')
  for (const root of [cache, linuxCache]) {
    if (!existsSync(root)) continue
    const builds = readdirSync(root)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const build of builds) {
      for (const rel of [
        'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-linux/chrome',
      ]) {
        const candidate = join(root, build, rel)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  for (const candidate of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('no Chrome binary found — pass one via CHROME_PATH')
}

async function fetchJson(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error(`could not reach ${url}`)
}

/** Minimal CDP client over Node's built-in WebSocket. */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let nextId = 1
    const pending = new Map()
    const events = []

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && pending.has(message.id)) {
        const { resolve: res, reject: rej } = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) rej(new Error(message.error.message))
        else res(message.result)
      } else if (message.method) {
        events.push(message)
      }
    })
    ws.addEventListener('error', reject)
    ws.addEventListener('open', () =>
      resolve({
        events,
        send(method, params = {}) {
          const id = nextId++
          ws.send(JSON.stringify({ id, method, params }))
          return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }))
        },
        close: () => ws.close(),
      }),
    )
  })
}

const failures = []
function check(label, condition, detail = '') {
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!condition) failures.push(label)
}

const chromePath = process.env.CHROME_PATH || findChrome()
console.log(`Chrome: ${chromePath}`)
console.log(`Target: ${URL_TO_OPEN}\n`)

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--window-size=${WINDOW_SIZE}`,
    `--remote-debugging-port=${PORT}`,
    // ★ 每次运行使用**唯一**的 profile 目录。固定目录会让 Chrome 恢复上一次的标签页，
    //   /json/list 就会抓到那个陈旧页面，于是探针在一个跑着旧代码的页面上给出结论，
    //   而且 ready gate 会以 1ms 的假速度通过 —— 这会让整轮验证结论不可信。
    `--user-data-dir=${join(process.env.TMPDIR || '/tmp', `cdp-check-${process.pid}-${Date.now()}`)}`,
    URL_TO_OPEN,
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
)

try {
  await fetchJson(`http://127.0.0.1:${PORT}/json/version`)
  const targets = await fetchJson(`http://127.0.0.1:${PORT}/json/list`)
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('no page target found')

  const client = await connect(page.webSocketDebuggerUrl)
  await client.send('Runtime.enable')
  await client.send('Log.enable')
  await client.send('Page.enable')

  // Wait for the app to signal it is actually wired up (see READY GATE above).
  let ready = false
  const started = Date.now()
  while (Date.now() - started < READY_TIMEOUT_MS) {
    const { result } = await client.send('Runtime.evaluate', {
      expression: READY_EXPR,
      returnByValue: true,
    })
    if (result.value === true) {
      ready = true
      break
    }
    await sleep(250)
  }
  if (!ready) {
    console.log(`  [FAIL] not ready after ${READY_TIMEOUT_MS}ms: ${READY_EXPR}`)
    console.log('         (over a real network, cold loads are slow — raise READY_TIMEOUT_MS)')
    failures.push('readiness')
  } else {
    console.log(`App ready after ${Date.now() - started}ms.\n`)
  }

  if (DRIVER_FILE) {
    const driver = readFileSync(DRIVER_FILE, 'utf8')
    console.log(`Driving the page with ${DRIVER_FILE} …\n`)
    const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
      expression: driver,
      awaitPromise: true,
      returnByValue: true,
    })

    if (exceptionDetails) {
      console.log('  [FAIL] the driver threw inside the page')
      console.log('        ', exceptionDetails.exception?.description || exceptionDetails.text)
      failures.push('driver')
    } else {
      let parsed
      try {
        parsed = JSON.parse(result.value)
      } catch {
        console.log('  [warn] driver did not return JSON; raw value follows:')
        console.log(String(result.value).slice(0, 4000))
      }
      if (parsed) {
        console.log(JSON.stringify(parsed, null, 2))
        if (Array.isArray(parsed.failures)) {
          for (const f of parsed.failures) failures.push(f)
        }
      }
    }
  }

  // Console errors and uncaught exceptions raised while the flow ran.
  const problems = client.events
    .filter((e) => e.method === 'Runtime.exceptionThrown' || e.method === 'Log.entryAdded')
    .map((e) =>
      e.method === 'Runtime.exceptionThrown'
        ? e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text
        : `${e.params.entry.level}: ${e.params.entry.text}`,
    )
    .filter((text) => text && !/favicon|DevTools/.test(text))
  check('no console errors or uncaught exceptions', problems.length === 0, problems.slice(0, 3).join(' | '))

  client.close()
} catch (err) {
  console.log(`  [FAIL] ${err.message}`)
  failures.push(err.message)
} finally {
  chrome.kill()
}

console.log('\n' + '='.repeat(60))
if (failures.length) {
  console.log(`RESULT: ${failures.length} FAILURE(S)`)
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
console.log('RESULT: ALL BROWSER CHECKS PASSED')
