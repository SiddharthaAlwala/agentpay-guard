import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';

export type GuardEvent =
  | { type: 'payment.decided'; payment: Record<string, unknown> }
  | { type: 'payment.reviewed'; payment: Record<string, unknown> }
  | { type: 'agent.updated'; agentId: string }
  | { type: 'demo.reset' };

const CHANNEL = 'agentpay:events';

/**
 * Fan-out for live dashboard updates. Uses Redis pub/sub so every instance's SSE clients see
 * every decision, and falls back to in-process delivery when Redis is unavailable.
 */
export class EventBus {
  private local = new EventEmitter();

  constructor(
    private pub: Redis | null,
    private sub: Redis | null,
  ) {
    this.local.setMaxListeners(1000);
    if (this.sub) {
      this.sub.subscribe(CHANNEL).catch(() => undefined);
      this.sub.on('message', (_channel: string, message: string) => {
        try {
          this.local.emit('event', JSON.parse(message));
        } catch {
          /* ignore malformed */
        }
      });
    }
  }

  publish(event: GuardEvent) {
    if (this.pub && this.pub.status === 'ready' && this.sub?.status === 'ready') {
      this.pub.publish(CHANNEL, JSON.stringify(event)).catch(() => this.local.emit('event', event));
    } else {
      this.local.emit('event', event);
    }
  }

  subscribe(fn: (e: GuardEvent) => void): () => void {
    this.local.on('event', fn);
    return () => this.local.off('event', fn);
  }
}
