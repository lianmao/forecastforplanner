/**
 * Screenshot every view of a browser-only static app, so you can LOOK at it.
 *
 *   node scripts/serve.mjs &
 *   node scripts/screenshot.mjs http://localhost:8080/ [/tmp/shots] [steps.mjs]
 *
 * Why this is not optional: assertions verify what you thought to check. A blank
 * chart, an empty card and a 0x0 canvas all preserve every assertion you wrote —
 * they are only visible in a picture. Every layout bug found in practice was found
 * here, not in a test.
 *
 * STEPS FILE (optional) — `export default [ { name, setup }, ... ]`
 *   `setup` is an async arrow function body string evaluated inside the page; use it
 *   to click through the app before the shot. Example:
 *
 *     export default [
 *       { name: '01-landing', setup: '' },
 *       { name: '02-loaded', setup: `
 *           document.getElementById('loadSample').click(); ${WAIT_ROWS} ` },
 *     ]
 *
 *   Without a steps file it captures only the initial page, which is still enough to
 *   catch a broken stylesheet or a mis-specified asset path.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

const URL_TO_OPEN = process.argv[2] || 'http://localhost:8080/'
const OUT_DIR = process.argv[3] || '/tmp/static-app-shots'
const STEPS_FILE = process.argv[4]
const PORT = Number(process.env.CDP_PORT || 9334)
const VIEWPORT = { width: 1440, height: 1000 }
// SHOT_FULL=1 → 整页截图（长文讲义必需）；SHOT_MAX_H 限制最大高度避免超大 PNG
const FULL_PAGE = process.env.SHOT_FULL === '1'
const FULL_MAX_H = Number(process.env.SHOT_MAX_H || 9000)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Handy snippet to paste into a step's setup: wait for N rows in a table. */
export const WAIT_ROWS = (selector, count) =>
  `const t0 = Date.now(); while (Date.now() - t0 < 120000) { ` +
  `if (document.querySelectorAll('${selector}').length === ${count}) break; await sleep(100) }`

function findChrome() {
  for (const root of [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]) {
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
  ]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('no Chrome binary found — set CHROME_PATH')
}

async function fetchJson(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) return await r.json()
    } catch {}
    await sleep(250)
  }
  throw new Error(`could not reach ${url}`)
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 1
    const pending = new Map()
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id)
        pending.delete(m.id)
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
      }
    })
    ws.addEventListener('error', reject)
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          const mid = id++
          ws.send(JSON.stringify({ id: mid, method, params }))
          return new Promise((res, rej) => pending.set(mid, { resolve: res, reject: rej }))
        },
        close: () => ws.close(),
      }),
    )
  })
}

const steps = STEPS_FILE ? (await import(pathToFileURL(STEPS_FILE).href)).default : [{ name: '01-initial', setup: '' }]

mkdirSync(OUT_DIR, { recursive: true })
const chrome = spawn(
  process.env.CHROME_PATH || findChrome(),
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    `--remote-debugging-port=${PORT}`,
    // 唯一 profile：固定目录会让 Chrome 恢复上次的标签页，截图可能拍在陈旧页面上
    `--user-data-dir=${join(process.env.TMPDIR || '/tmp', `cdp-shot-${process.pid}-${Date.now()}`)}`,
    URL_TO_OPEN,
  ],
  { stdio: 'ignore' },
)

try {
  await fetchJson(`http://127.0.0.1:${PORT}/json/version`)
  const targets = await fetchJson(`http://127.0.0.1:${PORT}/json/list`)
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('no page target found')

  const client = await connect(page.webSocketDebuggerUrl)
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  await client.send('Emulation.setDeviceMetricsOverride', {
    ...VIEWPORT,
    deviceScaleFactor: 2, // retina, so small text is legible when you read the PNG
    mobile: false,
  })

  // Wait for the shell to exist before the first interaction.
  for (let i = 0; i < 200; i++) {
    const { result } = await client.send('Runtime.evaluate', {
      expression: "document.readyState === 'complete'",
      returnByValue: true,
    })
    if (result.value === true) break
    await sleep(200)
  }

  for (const step of steps) {
    if (step.setup) {
      const { exceptionDetails } = await client.send('Runtime.evaluate', {
        expression: `(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); ${step.setup} })()`,
        awaitPromise: true,
        returnByValue: true,
      })
      if (exceptionDetails) console.log(`  [warn] ${step.name} setup threw:`, exceptionDetails.text)
    }
    await sleep(900) // let charts finish animating before capturing
    // SHOT_FULL=1 → 整页截图（长文讲义必需：只看首屏等于没看）。
    // 长页面会产出很大的 PNG，所以整页模式下降采样到 1x，并限制最大高度。
    let shotParams = { format: 'png' }
    if (FULL_PAGE) {
      const { result } = await client.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ h: document.documentElement.scrollHeight, w: document.documentElement.clientWidth })',
        returnByValue: true,
      })
      const { h, w } = JSON.parse(result.value)
      shotParams = {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: w, height: Math.min(h, FULL_MAX_H), scale: 1 },
      }
    }
    const { data } = await client.send('Page.captureScreenshot', shotParams)
    const out = join(OUT_DIR, `${step.name}.png`)
    writeFileSync(out, Buffer.from(data, 'base64'))
    console.log(`  captured ${out}`)
  }

  client.close()
  console.log(`\nsaved to ${OUT_DIR} — open these and actually look at them`)
} finally {
  chrome.kill()
}
