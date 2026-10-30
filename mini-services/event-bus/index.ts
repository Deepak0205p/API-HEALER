/**
 * API-HEALER · Event Bus (socket.io mini service · port 3003)
 * ------------------------------------------------------------
 * Fans out hot-path heal events, canary verdicts, PR notifications, TTL
 * sweeps and metrics snapshots to every connected Command Center dashboard.
 *
 * Ingress (server-to-server): the Next.js engine holds a persistent socket.io
 * client connection and emits `publish` frames: { channel, data }.
 * Egress (dashboards): subscribe to the same channel names.
 */
import { Server } from 'socket.io'
import type { Server as HttpServer } from 'http'
import { createServer } from 'http'

const httpServer: HttpServer = createServer()

const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60_000,
  pingInterval: 25_000,
})

io.on('connection', (socket) => {
  console.log(`[event-bus] dashboard connected: ${socket.id}`)
  socket.emit('bus:hello', { ok: true, ts: Date.now() })

  // Engine ingress: re-broadcast publisher frames to every dashboard
  socket.on('publish', (frame: { channel?: string; data?: unknown }) => {
    if (!frame || typeof frame.channel !== 'string' || !frame.channel) return
    io.emit(frame.channel, frame.data)
  })

  socket.on('disconnect', () => {
    console.log(`[event-bus] dashboard disconnected: ${socket.id}`)
  })
  socket.on('error', (e) => console.error('[event-bus] socket error', e))
})

const PORT = 3003
httpServer.listen(PORT, () => {
  console.log(`[event-bus] API-Healer telemetry bus on :${PORT}`)
})

process.on('SIGTERM', () => httpServer.close(() => process.exit(0)))
process.on('SIGINT', () => httpServer.close(() => process.exit(0)))
