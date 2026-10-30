'use client';

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

export type HealChannel =
  | 'heal:event'
  | 'heal:canary'
  | 'heal:pr'
  | 'heal:metrics'
  | 'heal:ttl'
  | 'jobs:update';

export interface BusFrame {
  channel: HealChannel;
  data: unknown;
  ts: number;
}

export function useHealerBus(onFrame: (frame: BusFrame) => void) {
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const handlerRef = useRef(onFrame);

  useEffect(() => {
    handlerRef.current = onFrame;
  }, [onFrame]);

  useEffect(() => {
    const socket = io('/?XTransformPort=3003', {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 3,
      reconnectionDelay: 3000,
      timeout: 5000,
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    const channels: HealChannel[] = [
      'heal:event',
      'heal:canary',
      'heal:pr',
      'heal:metrics',
      'heal:ttl',
      'jobs:update',
    ];
    const listeners = channels.map((channel) => {
      const fn = (data: unknown) => handlerRef.current({ channel, data, ts: Date.now() });
      socket.on(channel, fn);
      return { channel, fn };
    });

    return () => {
      for (const { channel, fn } of listeners) socket.off(channel, fn);
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  return { connected };
}
