#!/usr/bin/env node
/**
 * warp-relay — a local HTTP CONNECT relay that puts proxy hops (Cloudflare
 * WARP in proxy mode) in front of zen-proxy's upstream calls, with a direct
 * fallback when every hop is unavailable.
 *
 * Zero dependencies: node:http + node:net only.
 *
 *   node scripts/warp-relay.mjs --listen 127.0.0.1:8890 \
 *        --hop http://127.0.0.1:40000 --fallback direct
 *   node scripts/warp-relay.mjs --listen 127.0.0.1:8890 \
 *        --hops http://127.0.0.1:40000,http://127.0.0.1:40001 --fallback none
 *
 * Why a relay and not "HTTPS_PROXY=http://127.0.0.1:40000" straight in the
 * zen-proxy unit: Node's env proxy (NODE_USE_ENV_PROXY=1 + HTTPS_PROXY) is
 * process-wide and has no failover, so a stopped WARP service would take every
 * upstream call down with it. The relay keeps one stable address for
 * zen-proxy and picks a hop (or a direct socket) per tunnel.
 *
 * With several hops the relay round-robins them per tunnel; a hop that
 * refuses a CONNECT is avoided for --hop-cooldown-ms (default 60s) while the
 * others keep serving. With --fallback none there is no direct socket at all:
 * a dead hop answers 502 instead of leaking the host's own address — that is
 * what zen-proxy's `warp-only` mode requires.
 *
 * Endpoints:
 *   CONNECT host:port   tunneled through a hop, or direct when the hops fail
 *   GET /__status       JSON counters, including one entry per hop
 */
import http from "node:http"
import net from "node:net"
import process from "node:process"

function parseArgs(argv) {
  const out = { hop: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) {
      out[key] = true
    } else if (key === "hop") {
      out.hop.push(next)
      i++
    } else {
      out[key] = next
      i++
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

// "127.0.0.1:40000" and "http://127.0.0.1:40000" mean the same hop.
export function normalizeHop(value) {
  const s = String(value ?? "").trim()
  if (!s) return ""
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s
  return `http://${s}`
}

export function parseHops(options = {}) {
  const raw = []
  if (Array.isArray(options.hops)) raw.push(...options.hops)
  else if (typeof options.hops === "string") raw.push(...options.hops.split(","))
  if (Array.isArray(options.hop)) raw.push(...options.hop)
  else if (options.hop) raw.push(options.hop)
  const seen = new Set()
  const out = []
  for (const entry of raw) {
    const url = normalizeHop(entry)
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

export function createRelay(options = {}) {
  const listenHost = options.listenHost ?? "127.0.0.1"
  const listenPort = Number(options.listenPort ?? 8890)
  const hopUrls = parseHops(options)
  const hopUrl = hopUrls[0] ?? ""
  const fallback = options.fallback ?? "direct"
  const connectTimeoutMs = Number(options.connectTimeoutMs ?? 15000)
  const hopCooldownMs = Math.max(1000, Number(options.hopCooldownMs ?? 60000))
  const log = options.log ?? (() => {})

  const hops = hopUrls.map((url) => {
    const u = new URL(url)
    return {
      url,
      host: u.hostname,
      port: Number(u.port || (u.protocol === "https:" ? 443 : 80)),
      viaHop: 0,
      failures: 0,
      unhealthyUntil: 0,
    }
  })
  let hopCursor = 0

  const stats = {
    startedAt: new Date().toISOString(),
    tunnels: 0,
    viaHop: 0,
    viaDirect: 0,
    fallbacks: 0,
    failed: 0,
    lastTarget: "",
    lastPath: "",
    lastHop: "",
    hopUrl,
    hops: hops.map((h) => ({ hop: h.url, viaHop: 0, failures: 0, healthy: true, avoidForSec: 0 })),
    fallback,
  }

  function hopStatus() {
    const now = Date.now()
    return hops.map((h) => ({
      hop: h.url,
      viaHop: h.viaHop,
      failures: h.failures,
      healthy: h.unhealthyUntil <= now,
      avoidForSec: Math.max(0, Math.round((h.unhealthyUntil - now) / 1000)),
    }))
  }

  function refreshHopStats() {
    stats.hops = hopStatus()
  }

  function connectDirect(host, port) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port })
      socket.setTimeout(connectTimeoutMs)
      const onError = (err) => {
        socket.destroy()
        reject(err)
      }
      socket.once("error", onError)
      socket.once("timeout", () => {
        socket.destroy()
        reject(new Error("direct connect timed out"))
      })
      socket.once("connect", () => {
        socket.removeListener("error", onError)
        socket.setTimeout(0)
        resolve(socket)
      })
    })
  }

  // Tunnel to the target *through* one hop proxy with an HTTP CONNECT.
  function connectViaHop(hop, host, port) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: hop.host, port: hop.port })
      socket.setTimeout(connectTimeoutMs)
      let buf = Buffer.alloc(0)
      const fail = (err) => {
        socket.destroy()
        reject(err)
      }
      socket.once("error", fail)
      socket.once("timeout", () => fail(new Error("hop connect timed out")))
      socket.once("connect", () => {
        socket.setTimeout(0)
        socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
      })
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk])
        const end = buf.indexOf("\r\n\r\n")
        if (end === -1) return
        socket.removeListener("data", onData)
        const head = buf.subarray(0, end).toString("latin1")
        const status = Number(head.split(" ")[1] || 0)
        if (status >= 200 && status < 300) {
          const rest = buf.subarray(end + 4)
          if (rest.length) socket.unshift(rest)
          resolve(socket)
        } else {
          fail(new Error(`hop refused CONNECT (${status})`))
        }
      }
      socket.on("data", onData)
    })
  }

  // Next healthy hop in round-robin order, or null when every hop is cooling
  // down. The cursor only moves when a hop is actually picked, so a single
  // healthy hop keeps serving while the others sit out their cooldown.
  function pickHop() {
    const now = Date.now()
    for (let i = 0; i < hops.length; i++) {
      const hop = hops[(hopCursor + i) % hops.length]
      if (hop.unhealthyUntil <= now) {
        hopCursor = (hops.indexOf(hop) + 1) % hops.length
        return hop
      }
    }
    return null
  }

  async function openTunnel(host, port) {
    let lastErr = null
    // Try each healthy hop once, round-robin. A hop that fails is parked for
    // hopCooldownMs; the next tunnel retries it only after the cooldown.
    for (let tried = 0; tried < hops.length; tried++) {
      const hop = pickHop()
      if (!hop) break
      try {
        const socket = await connectViaHop(hop, host, port)
        hop.viaHop++
        stats.lastHop = hop.url
        refreshHopStats()
        return { socket, path: "hop", hop: hop.url }
      } catch (err) {
        lastErr = err
        hop.failures++
        hop.unhealthyUntil = Date.now() + hopCooldownMs
        refreshHopStats()
        log(`hop ${hop.url} failed for ${host}:${port} (${err.message}); avoiding it for ${Math.round(hopCooldownMs / 1000)}s`)
      }
    }
    if (hops.length) {
      stats.fallbacks++
      log(`all hops failed for ${host}:${port} (${lastErr?.message ?? "no hop"}); falling back to ${fallback}`)
      if (fallback !== "direct") throw lastErr ?? new Error("no hop available")
    }
    const socket = await connectDirect(host, port)
    return { socket, path: hops.length ? "direct" : "direct", hop: "" }
  }

  const server = http.createServer((req, res) => {
    if (req.url === "/__status") {
      refreshHopStats()
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ...stats, uptimeSec: Math.round(process.uptime()) }, null, 2))
      return
    }
    res.writeHead(405, { "content-type": "text/plain" })
    res.end("this endpoint only speaks HTTP CONNECT\n")
  })

  server.on("connect", (req, clientSocket, head) => {
    const target = String(req.url || "")
    const idx = target.lastIndexOf(":")
    const host = idx === -1 ? target : target.slice(0, idx)
    const port = idx === -1 ? 443 : Number(target.slice(idx + 1))
    stats.tunnels++
    stats.lastTarget = `${host}:${port}`

    clientSocket.on("error", () => {})
    openTunnel(host, port).then(({ socket, path, hop }) => {
      stats.lastPath = path
      if (hop) stats.lastHop = hop
      if (path === "hop") stats.viaHop++
      else stats.viaDirect++
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head && head.length) socket.write(head)
      // Either side going away must tear the other side down too: a plain
      // FIN (no error) used to leave the upstream socket open, and then
      // server.close() waited on it forever.
      socket.on("error", () => clientSocket.destroy())
      socket.on("close", () => clientSocket.destroy())
      clientSocket.on("error", () => socket.destroy())
      clientSocket.on("close", () => socket.destroy())
      socket.pipe(clientSocket)
      clientSocket.pipe(socket)
    }).catch((err) => {
      stats.failed++
      log(`tunnel failed for ${host}:${port}: ${err.message}`)
      try {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n")
      } catch {}
      clientSocket.destroy()
    })
  })

  return {
    server,
    stats,
    listen: () =>
      new Promise((resolve) => {
        server.listen(listenPort, listenHost, () => resolve(server.address()))
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      }),
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const relay = createRelay({
    listenHost: args["listen-host"] ?? "127.0.0.1",
    listenPort: Number(args.port ?? 8890),
    hop: args.hop === true ? [] : args.hop,
    hops: args.hops === true ? "" : args.hops ?? "",
    fallback: args.fallback === true ? "direct" : args.fallback ?? "direct",
    connectTimeoutMs: Number(args["connect-timeout-ms"] ?? 15000),
    hopCooldownMs: Number(args["hop-cooldown-ms"] ?? 60000),
    log: (msg) => console.log(`[warp-relay] ${msg}`),
  })
  await relay.listen()
  const addr = relay.server.address()
  console.log(`[warp-relay] listening on http://${addr.address}:${addr.port}`)
  console.log(`[warp-relay] hops=${relay.stats.hops.map((h) => h.hop).join(",") || "(none)"} fallback=${relay.stats.fallback}`)
  const summaryEvery = Number(args["summary-seconds"] ?? 0)
  if (summaryEvery > 0) {
    setInterval(() => {
      const s = relay.stats
      console.log(
        `[warp-relay] tunnels=${s.tunnels} hop=${s.viaHop} direct=${s.viaDirect} fallbacks=${s.fallbacks} failed=${s.failed}`,
      )
    }, summaryEvery * 1000).unref?.()
  }
}
