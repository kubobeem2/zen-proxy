import { test, describe, beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createRelay } from "../scripts/warp-relay.mjs"

// Must be set before importing the module (CONFIG_PATH is computed at load).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zen-warp-rotate-test-"))
process.env.ZEN_PROXY_CONFIG = path.join(tmpDir, "zen-proxy.json")
for (const k of [
  "PORT", "HOST", "ZEN_URL", "ZEN_UA", "DEFAULT_MODEL", "PROXY_KEY", "ZEN_KEY",
  "FALLBACK_MODELS", "MODEL_ALIASES", "TRUST_FORWARDED", "TIMEOUT_MS", "CACHE_MS",
  "AUTO_SYNC", "AUTO_SYNC_MS",
]) delete process.env[k]

const zp = await import("../zen-proxy.mjs")
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))
const isWindows = process.platform === "win32"

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })
}

async function closedPort() {
  const s = net.createServer()
  await new Promise((r) => s.listen(0, "127.0.0.1", r))
  const port = s.address().port
  await new Promise((r) => s.close(r))
  return port
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The relay is down in these cases, so the IP probe fails fast; the rotate
// itself only needs its command to run.
function warpConfig(over = {}) {
  return {
    enabled: true,
    hop: "http://127.0.0.1:40000",
    port: 8899,
    fallback: "direct",
    mode: "auto",
    rotateCommand: "true",
    rotateCooldownMs: 60000,
    rotateTimeoutMs: 10000,
    ...over,
  }
}

describe("cdn-cgi/trace parsing", () => {
  test("reads ip= out of a trace body", () => {
    const trace = "fl=1f\nip=203.0.113.42\nts=1\nvisit_scheme=https\nloc=JP\n"
    assert.equal(zp.parseTraceIp(trace), "203.0.113.42")
  })

  test("a body without ip= parses to nothing", () => {
    assert.equal(zp.parseTraceIp("fl=1f\nloc=JP\n"), "")
    assert.equal(zp.parseTraceIp(""), "")
  })

  test("a trailing carriage return does not stick to the address", () => {
    assert.equal(zp.parseTraceIp("ip=198.51.100.7\r\nloc=JP\r\n"), "198.51.100.7")
  })
})

describe("warp-only egress", () => {
  test("pins the hop and never offers direct as the other path", () => {
    zp.saveConfig({ warpProxy: warpConfig({ mode: "warp-only" }) })
    zp.initEgress()
    const st = zp.egressStatus()
    assert.equal(st.mode, "warp-only")
    assert.equal(st.active, "warp")
    assert.equal(st.failClosed, true)
    assert.equal(zp.canSwitchEgress(), false)
    assert.equal(zp.switchEgress("refused"), false)
    assert.equal(zp.egressUsable("direct"), false)
    assert.equal(zp.egressStatus().active, "warp", "a refused switch leaves the hop active")
    zp.saveConfig({ warpProxy: warpConfig({ mode: "auto" }) })
    zp.initEgress()
  })
})

describe("warp rotate", () => {
  beforeEach(() => {
    zp.rotateState.running = false
    zp.rotateState.lastAt = 0
    zp.rotateState.last = null
  })

  // The rotate command runs through a shell, so these cases are unix-only.
  test("runs the configured command and reports unknown IPs when the relay is down", { skip: isWindows }, async () => {
    const dead = await closedPort()
    zp.saveConfig({ warpProxy: warpConfig({ port: dead }) })
    const out = await zp.rotateWarpEgress()
    assert.equal(out.ok, true)
    assert.equal(out.ipBefore, null)
    assert.equal(out.ipAfter, null)
    assert.equal(out.changed, false)
  })

  test("a second rotate inside the cooldown is refused", { skip: isWindows }, async () => {
    const dead = await closedPort()
    zp.saveConfig({ warpProxy: warpConfig({ port: dead }) })
    await zp.rotateWarpEgress()
    await assert.rejects(() => zp.rotateWarpEgress(), (err) => {
      assert.equal(err.status, 429)
      assert.equal(typeof err.retryAfterSec, "number")
      assert.ok(err.retryAfterSec > 0)
      return true
    })
  })

  test("a second rotate while one runs is refused", { skip: isWindows }, async () => {
    const dead = await closedPort()
    zp.saveConfig({ warpProxy: warpConfig({ port: dead, rotateCommand: "sleep 2" }) })
    const first = zp.rotateWarpEgress()
    await sleep(100)
    await assert.rejects(() => zp.rotateWarpEgress(), (err) => {
      assert.equal(err.status, 409)
      return true
    })
    const out = await first
    assert.equal(out.ok, true)
  })

  test("rotate without a hop fails closed instead of pretending", async () => {
    zp.saveConfig({ warpProxy: { enabled: false, hop: "", port: 8899, mode: "auto" } })
    await assert.rejects(() => zp.rotateWarpEgress(), (err) => {
      assert.equal(err.status, 503)
      return true
    })
    zp.saveConfig({ warpProxy: warpConfig({ mode: "auto" }) })
  })

  test("auto-rotate stays off unless opted in", { skip: isWindows }, async () => {
    const dead = await closedPort()
    zp.saveConfig({ warpProxy: warpConfig({ port: dead, mode: "always", autoRotateOnEgressReject: false }) })
    zp.initEgress()
    assert.equal(zp.egressStatus().active, "warp")
    assert.equal(zp.requestAutoRotate("test"), false)

    zp.saveConfig({ warpProxy: warpConfig({ port: dead, mode: "always", autoRotateOnEgressReject: true }) })
    zp.initEgress()
    assert.equal(zp.requestAutoRotate("test"), true, "opt-in starts one rotate")
    assert.equal(zp.requestAutoRotate("test"), false, "the running rotate is not started twice")
    for (let i = 0; i < 50 && zp.rotateState.running; i++) await sleep(200)
    assert.equal(zp.rotateState.running, false)
    zp.saveConfig({ warpProxy: warpConfig({ mode: "auto" }) })
    zp.initEgress()
  })
})

describe("warp-only gate against a live server", () => {
  const closers = []
  let child = null

  // close() alone waits for keep-alive sockets; drop them first so a
  // finished test never hangs on a lingering connection.
  function closeServer(server) {
    return new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
  }

  after(async () => {
    if (child) child.kill("SIGTERM")
    for (const close of closers) await close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function waitForTcp(port, timeoutMs = 15000) {
    const started = Date.now()
    for (;;) {
      const ok = await new Promise((resolve) => {
        const s = net.connect({ host: "127.0.0.1", port })
        s.once("connect", () => {
          s.destroy()
          resolve(true)
        })
        s.once("error", () => resolve(false))
      })
      if (ok) return
      if (Date.now() - started > timeoutMs) throw new Error(`nothing listening on ${port}`)
      await sleep(200)
    }
  }

  test("a relay that falls back to direct answers 503; a fail-closed relay lets the request through", async () => {
    const dead = await closedPort()
    const relayPort = await freePort()
    const stubPort = await freePort()
    const proxyPort = await freePort()

    // A stub upstream that answers 400, so a request that reaches it is
    // distinguishable from one the warp-only gate stopped.
    let stubHits = 0
    const stub = http.createServer((req, res) => {
      stubHits++
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "stub" } }))
    })
    await new Promise((r) => stub.listen(stubPort, "127.0.0.1", r))
    closers.push(() => closeServer(stub))

    const relayDirect = createRelay({ listenPort: relayPort, hop: `http://127.0.0.1:${dead}`, fallback: "direct" })
    await relayDirect.listen()

    const cfgFile = path.join(tmpDir, "live-zen-proxy.json")
    fs.writeFileSync(
      cfgFile,
      JSON.stringify({
        port: proxyPort,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${stubPort}`,
        autoSync: false,
        autoUA: false,
        warpProxy: {
          enabled: true,
          hop: `http://127.0.0.1:${dead}`,
          port: relayPort,
          fallback: "direct",
          mode: "warp-only",
          rotateCommand: "true",
          rotateCooldownMs: 10000,
        },
      }),
    )
    child = spawn(process.execPath, ["zen-proxy.mjs"], {
      cwd: REPO_ROOT,
      env: { ...process.env, ZEN_PROXY_CONFIG: cfgFile },
      stdio: "ignore",
    })
    await waitForTcp(proxyPort)

    const chatBody = JSON.stringify({ model: "beam-free", messages: [{ role: "user", content: "hi" }] })
    const postChat = () =>
      fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody,
      })

    // Relay falls back to direct: the gate stops the request before upstream.
    const refused = await postChat()
    assert.equal(refused.status, 503)
    assert.equal((await refused.json()).error.type, "egress_unavailable")
    assert.equal(stubHits, 0)

    // The rotate endpoint answers on the same server (localhost-only).
    const rotated = await fetch(`http://127.0.0.1:${proxyPort}/api/warp/rotate`, { method: "POST" })
    if (isWindows) {
      assert.equal(rotated.status, 502, "no sh on Windows, so the command itself fails")
    } else {
      assert.equal(rotated.status, 200)
      assert.equal((await rotated.json()).ok, true)
      const again = await fetch(`http://127.0.0.1:${proxyPort}/api/warp/rotate`, { method: "POST" })
      assert.equal(again.status, 429, "the second rotate hits the cooldown")
    }

    // /api/status still answers when the probe cannot reach the hop.
    const status = await fetch(`http://127.0.0.1:${proxyPort}/api/status?refresh=1`)
    assert.equal(status.status, 200)
    const statusJson = await status.json()
    assert.equal(statusJson.egress.mode, "warp-only")
    assert.equal(statusJson.egress.failClosed, true)
    assert.equal(statusJson.egress.ip, null)

    // Swap the relay for a fail-closed one on the same port: the gate cache
    // lives 5s, so the next request must wait it out before it re-asks.
    await closeServer(relayDirect.server)
    const relayClosed = createRelay({ listenPort: relayPort, hop: `http://127.0.0.1:${dead}`, fallback: "none" })
    await relayClosed.listen()
    closers.push(() => closeServer(relayClosed.server))
    await sleep(6000)

    const passed = await postChat()
    assert.equal(passed.status, 400, "the gate passed and the stub answered")
    assert.equal(stubHits, 1)
  })
})
