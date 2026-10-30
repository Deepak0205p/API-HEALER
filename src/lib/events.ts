/**
 * Server-side event bus client.
 * The heal engine (Next.js process) publishes telemetry to the socket.io
 * event-bus mini service (port 3003) over a persistent client connection,
 * which fans frames out to all dashboards. Emission is fire-and-forget:
 * telemetry NEVER blocks the hot path. Frames emitted while the socket is
 * connecting are buffered and flushed on connect.
 */
import type { Socket } from 'socket.io-client';

const BUS_URL = 'http://127.0.0.1:3003';

interface BusState {
  socket: Socket | null;
  connecting: boolean;
  buffer: { channel: string; data: unknown }[];
}

const globalForBus = globalThis as unknown as { __apiHealerBus?: BusState };

function state(): BusState {
  if (!globalForBus.__apiHealerBus) {
    globalForBus.__apiHealerBus = { socket: null, connecting: false, buffer: [] };
  }
  return globalForBus.__apiHealerBus;
}

async function ensureSocket(): Promise<Socket | null> {
  const s = state();
  if (s.socket?.connected) return s.socket;
  if (s.connecting) return null;
  s.connecting = true;
  try {
    const { io: ioClient } = await import('socket.io-client');
    const socket = ioClient(BUS_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      timeout: 4000,
    });
    socket.on('connect', () => {
      const buffered = s.buffer.splice(0);
      for (const f of buffered) socket.emit('publish', f);
    });
    socket.on('connect_error', () => {
      // bus down — telemetry is best-effort, the firewall stays up
    });
    s.socket = socket;
    return socket;
  } catch {
    return null;
  } finally {
    s.connecting = false;
  }
}

export function emitEvent(channel: string, data: unknown): void {
  try {
    const s = state();
    if (s.socket?.connected) {
      s.socket.emit('publish', { channel, data });
      return;
    }
    if (s.buffer.length < 200) s.buffer.push({ channel, data });
    void ensureSocket();
  } catch {
    // telemetry must never take the firewall down
  }
}
