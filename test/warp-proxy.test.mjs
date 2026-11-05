import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
const run = promisify(execFile)

// The config file is read once, when the module loads, so every case gets its
// own process with its own ZEN_PROXY_CONFIG.
const MODULE = fileURLToPath(new URL("../zen-proxy.mjs", import.meta.url))
// A Windows absolute path is not a valid ESM specifier on its own — the child
// would reject it with ERR_UNSUPPORTED_ESM_URL_SCHEME. Hand it a file URL.
const MODULE_URL = pathToFileURL(MODULE).href

// A port nothing listens on: the relay is not running there, so the status
// reports it as down.
const NO_RELAY_PORT = 8899

function writeConfig(dir, config) {
  const file = path.join(dir, "zen-proxy.json")
  fs.writeFileSync(file, JSON.stringify(config, null, 2))
  return file
}

// Load zen-proxy in a child process with the given config file and report the
// proxy-hop block it ended up with.
async function loadWarpProxy(configFile) {
  const script = `
    const zp = await import(${JSON.stringify(MODULE_URL)})
    const status = await zp.relayStatus()
    process.stdout.write(JSON.stringify({ warpProxy: zp.config.warpProxy, status, egress: zp.egressStatus() }))
  `
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, ZEN_PROXY_CONFIG: configFile },
  })
  return JSON.parse(stdout)
}

describe("proxy hop configuration", () => {
  const dirs = []

  function tmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zen-warp-test-"))
    dirs.push(dir)
    return dir
  }

  after(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
  })

  test("an install without a hop leaves the proxy off", async () => {
    const file = writeConfig(tmpDir(), { port: 8799 })
    const out = await loadWarpProxy(file)
    assert.equal(out.warpProxy.enabled, false)
    assert.equal(out.warpProxy.hop, "")
    assert.equal(out.warpProxy.fallback, "direct")
    assert.equal(out.warpProxy.port, 8890)
    assert.equal(out.status.enabled, false)
    assert.equal(out.status.running, false)
  })

  test("a hop is only enabled when it has an address", async () => {
    const file = writeConfig(tmpDir(), { port: 8799, warpProxy: { enabled: true, hop: "" } })
    const out = await loadWarpProxy(file)
    assert.equal(out.warpProxy.enabled, false)
  })

  test("a partial hop block keeps the remaining defaults", async () => {
    const file = writeConfig(tmpDir(), {
      port: 8799,
      warpProxy: { enabled: true, hop: "http://127.0.0.1:40000", port: NO_RELAY_PORT },
    })
    const out = await loadWarpProxy(file)
    assert.equal(out.warpProxy.enabled, true)
    assert.equal(out.warpProxy.hop, "http://127.0.0.1:40000")
    assert.equal(out.warpProxy.port, NO_RELAY_PORT)
    assert.equal(out.warpProxy.fallback, "direct")
    assert.equal(out.status.enabled, true)
    assert.equal(out.status.hop, "http://127.0.0.1:40000")
    // Nothing listens there, so the relay is reported as down.
    assert.equal(out.status.running, false)
  })

  test("the fallback is either direct or none", async () => {
    const file = writeConfig(tmpDir(), {
      port: 8799,
      warpProxy: { enabled: true, hop: "http://127.0.0.1:40000", fallback: "nonsense" },
    })
    const out = await loadWarpProxy(file)
    assert.equal(out.warpProxy.fallback, "direct")
  })

  test("the port is a number", async () => {
    const file = writeConfig(tmpDir(), {
      port: 8799,
      warpProxy: { enabled: true, hop: "http://127.0.0.1:40000", port: "8899" },
    })
    const out = await loadWarpProxy(file)
    assert.equal(out.warpProxy.port, 8899)
  })

  test("mode warp-only is kept and pins the hop", async () => {
    const file = writeConfig(tmpDir(), {
      port: 8799,
      warpProxy: { enabled: true, hop: "http://127.0.0.1:40000", port: NO_RELAY_PORT, mode: "warp-only" },
    })
    const out = await loadWarpProxy(file)
    assert.equal(out.warpProxy.mode, "warp-only")
    assert.equal(out.status.mode, "warp-only")
    assert.equal(out.egress.active, "warp")
    assert.equal(out.egress.failClosed, true)
    assert.equal(out.egress.mode, "warp-only")
  })

  test("an unknown mode falls back to auto", async () => {
    const file = writeConfig(tmpDir(), {
      port: 8799,
      warpProxy: { enabled: true, hop: "http://127.0.0.1:40000", mode: "pinned" },
    })
    const out = await loadWarpProxy(file)
    assert.equal(out.warpProxy.mode, "auto")
  })

  test("several hops normalise to full URLs, first one stays `hop`", async () => {
    const file = writeConfig(tmpDir(), {
      port: 8799,
      warpProxy: {
        enabled: true,
        hops: ["127.0.0.1:40000", "http://127.0.0.1:40001", "127.0.0.1:40000"],
        port: NO_RELAY_PORT,
      },
    })
    const out = await loadWarpProxy(file)
    assert.deepEqual(out.warpProxy.hops, ["http://127.0.0.1:40000", "http://127.0.0.1:40001"])
    assert.equal(out.warpProxy.hop, "http://127.0.0.1:40000")
    assert.equal(out.warpProxy.enabled, true)
    assert.deepEqual(out.status.hops, ["http://127.0.0.1:40000", "http://127.0.0.1:40001"])
  })

  test("rotate defaults are present and auto-rotate is off", async () => {
    const file = writeConfig(tmpDir(), {
      port: 8799,
      warpProxy: { enabled: true, hop: "http://127.0.0.1:40000" },
    })
    const out = await loadWarpProxy(file)
    assert.equal(out.warpProxy.rotateCommand, "warp-cli --accept-tos disconnect && warp-cli --accept-tos connect")
    assert.equal(out.warpProxy.rotateCooldownMs, 60000)
    assert.equal(out.warpProxy.rotateTimeoutMs, 90000)
    assert.equal(out.warpProxy.autoRotateOnEgressReject, false)
  })
})
