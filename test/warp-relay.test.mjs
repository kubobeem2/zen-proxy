import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import net from "node:net"
import { createRelay } from "../scripts/warp-relay.mjs"

// A target the tunnel can reach: plain HTTP is enough to prove the bytes flow.
function startTarget(body = "hello from target") {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(body)
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }))
  })
}

// A proxy hop that behaves like one: it accepts CONNECT and pipes to the target.
function startFakeHop() {
  const server = http.createServer((req, res) => {
    res.writeHead(400)
    res.end("only CONNECT")
  })
  server.on("connect", (req, clientSocket, head) => {
    const idx = String(req.url).lastIndexOf(":")
    const host = String(req.url).slice(0, idx)
    const port = Number(String(req.url).slice(idx + 1))
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head && head.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on("error", () => clientSocket.destroy())
    clientSocket.on("error", () => upstream.destroy())
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }))
  })
}

// A port nothing listens on: the hop is unreachable.
async function closedPort() {
  const s = net.createServer()
  await new Promise((r) => s.listen(0, "127.0.0.1", r))
  const port = s.address().port
  await new Promise((r) => s.close(r))
  return port
}

// Speak HTTP over a CONNECT tunnel, the way a proxy client does.
function tunnelRequest(proxyPort, targetHost, targetPort, path = "/") {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      agent: false,
    })
    req.once("connect", (res, socket) => {
      const chunks = []
      socket.on("data", (c) => chunks.push(c))
      socket.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }))
      socket.on("error", reject)
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nConnection: close\r\n\r\n`,
      )
    })
    req.once("response", (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }))
    })
    req.once("error", reject)
    req.end()
  })
}

describe("warp-relay", () => {
  let relay
  const closers = []

  after(async () => {
    for (const close of closers) await close()
    if (relay) await relay.close()
  })

  test("tunnels through the hop when the hop is up", async () => {
    const target = await startTarget("through the hop")
    const hop = await startFakeHop()
    closers.push(() => new Promise((r) => hop.server.close(r)), () => new Promise((r) => target.server.close(r)))

    relay = createRelay({ listenPort: 0, hop: `http://127.0.0.1:${hop.port}`, fallback: "direct" })
    const addr = await relay.listen()

    const res = await tunnelRequest(addr.port, "127.0.0.1", target.port)
    assert.equal(res.status, 200)
    assert.match(res.body, /through the hop/)
    assert.equal(relay.stats.viaHop, 1)
    assert.equal(relay.stats.viaDirect, 0)
    assert.equal(relay.stats.fallbacks, 0)
  })

  test("falls back to a direct socket when the hop is down", async () => {
    const target = await startTarget("direct fallback")
    closers.push(() => new Promise((r) => target.server.close(r)))
    const dead = await closedPort()

    const local = createRelay({ listenPort: 0, hop: `http://127.0.0.1:${dead}`, fallback: "direct" })
    const addr = await local.listen()

    const res = await tunnelRequest(addr.port, "127.0.0.1", target.port)
    assert.equal(res.status, 200)
    assert.match(res.body, /direct fallback/)
    assert.equal(local.stats.viaHop, 0)
    assert.equal(local.stats.viaDirect, 1)
    assert.equal(local.stats.fallbacks, 1)
    await local.close()
  })

  test("answers 502 when the hop is down and the fallback is off", async () => {
    const dead = await closedPort()
    const local = createRelay({ listenPort: 0, hop: `http://127.0.0.1:${dead}`, fallback: "none" })
    const addr = await local.listen()

    const res = await tunnelRequest(addr.port, "127.0.0.1", 9)
    assert.equal(res.status, 502)
    assert.equal(local.stats.failed, 1)
    await local.close()
  })

  test("round-robins several hops and skips a dead one during its cooldown", async () => {
    const target = await startTarget("through hop two")
    const hop1 = await startFakeHop()
    const hop2 = await startFakeHop()
    closers.push(
      () => new Promise((r) => hop1.server.close(r)),
      () => new Promise((r) => hop2.server.close(r)),
      () => new Promise((r) => target.server.close(r)),
    )
    const relay = createRelay({
      listenPort: 0,
      hops: [`http://127.0.0.1:${hop1.port}`, `http://127.0.0.1:${hop2.port}`],
      fallback: "direct",
      hopCooldownMs: 60_000,
    })
    const addr = await relay.listen()
    closers.push(() => relay.close())

    // Two tunnels in a row use the two hops in turn.
    await tunnelRequest(addr.port, "127.0.0.1", target.port)
    await tunnelRequest(addr.port, "127.0.0.1", target.port)
    const status = JSON.parse(
      await new Promise((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port: addr.port, path: "/__status" }, (res) => {
            const chunks = []
            res.on("data", (c) => chunks.push(c))
            res.on("end", () => resolve(Buffer.concat(chunks).toString()))
          })
          .on("error", reject)
      }),
    )
    assert.equal(status.hops.length, 2)
    assert.equal(status.hops[0].viaHop, 1)
    assert.equal(status.hops[1].viaHop, 1)
    assert.equal(status.hops[0].healthy, true)

    // Kill the first hop: the next tunnels all go through the second one
    // while the first sits out its cooldown (no direct leak, no 502).
    await new Promise((r) => hop1.server.close(r))
    const before = status.hops[1].viaHop
    await tunnelRequest(addr.port, "127.0.0.1", target.port)
    await tunnelRequest(addr.port, "127.0.0.1", target.port)
    assert.equal(relay.stats.hops[1].viaHop, before + 2)
    assert.equal(relay.stats.hops[0].healthy, false)
    assert.ok(relay.stats.hops[0].avoidForSec > 0)
    assert.equal(relay.stats.viaDirect, 0)
  })

  test("answers 502 when every hop is dead and the fallback is off", async () => {
    const dead1 = await closedPort()
    const dead2 = await closedPort()
    const local = createRelay({
      listenPort: 0,
      hops: [`http://127.0.0.1:${dead1}`, `http://127.0.0.1:${dead2}`],
      fallback: "none",
      hopCooldownMs: 60_000,
    })
    const addr = await local.listen()
    const res = await tunnelRequest(addr.port, "127.0.0.1", 9)
    assert.equal(res.status, 502)
    assert.equal(local.stats.failed, 1)
    assert.equal(local.stats.hops[0].failures, 1)
    assert.equal(local.stats.hops[1].failures, 1)
    await local.close()
  })

  test("reports its counters on /__status and refuses other plain requests", async () => {
    const local = createRelay({ listenPort: 0, hop: "", fallback: "direct" })
    const addr = await local.listen()

    const status = await new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port: addr.port, path: "/__status" }, (res) => {
          const chunks = []
          res.on("data", (c) => chunks.push(c))
          res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }))
        })
        .on("error", reject)
    })
    assert.equal(status.status, 200)
    const parsed = JSON.parse(status.body)
    assert.equal(typeof parsed.tunnels, "number")
    assert.equal(parsed.fallback, "direct")

    const refused = await new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port: addr.port, path: "/nope" }, (res) => {
          res.resume()
          res.on("end", () => resolve(res.statusCode))
        })
        .on("error", reject)
    })
    assert.equal(refused, 405)
    await local.close()
  })
})
