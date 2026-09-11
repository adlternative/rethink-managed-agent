import { Redis } from "ioredis";
import { EventEmitter } from "node:events";
import { env } from "../shared/env.ts";
import type { ContentBlock, StreamDelta } from "../shared/types.ts";

/** A user message persisted while the session was running; `seq` lets the runner dedupe against the log. */
export interface Steer { seq: number; content: ContentBlock[] }
/** Result for a client/function tool call, delivered from the API process to the runner. */
export interface ToolResultMsg { content: ContentBlock[]; isError: boolean }

/**
 * The event bus (pub/sub for SSE deltas + durable lists for steer and per-call tool results) behind a
 * pluggable backend selected by MESSAGING_BACKEND:
 *   - "redis":  cross-process (default) — pub/sub + Redis lists. Required for the split api/runner stack.
 *   - "memory": in-process only — an EventEmitter + Maps. For single-process dev and tests (no Redis).
 * Callers use the stable functions below and never see the backend. BYOC additionally needs Redis.
 */
interface Bus {
  publish(delta: StreamDelta): Promise<void>;
  subscribe(sessionId: string, cb: (d: StreamDelta) => void): Promise<() => void>;
  publishInterrupt(sessionId: string): Promise<void>;
  onInterrupt(sessionId: string, cb: () => void): Promise<() => void>;
  pushSteer(sessionId: string, ev: Steer): Promise<void>;
  popSteer(sessionId: string): Promise<Steer[]>;
  publishToolResult(sessionId: string, callId: string, msg: ToolResultMsg): Promise<void>;
  takeToolResult(sessionId: string, callId: string): Promise<ToolResultMsg | null>;
  publishProvidersChanged(): Promise<void>;
  onProvidersChanged(cb: () => void): Promise<() => void>;
  close(): Promise<void>;
}

/** Shared Redis connection for commands (publish, lists). Subscribers need their own. Also used by queue.ts and byoc.ts. */
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });

const PROVIDERS_CHANNEL = "providers:changed";

function redisBus(): Bus {
  async function subscriber(channel: string, onMessage: (msg: string) => void): Promise<() => void> {
    const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    sub.on("message", (ch, msg) => { if (ch === channel) onMessage(msg); });
    try { await sub.subscribe(channel); } catch (e) { sub.disconnect(); throw e; }
    return () => sub.disconnect();
  }
  return {
    async publish(delta) { const id = delta.type === "event" ? delta.event.session_id : delta.session_id; await redis.publish(`sess:${id}`, JSON.stringify(delta)); },
    subscribe(sessionId, cb) { return subscriber(`sess:${sessionId}`, (msg) => cb(JSON.parse(msg) as StreamDelta)); },
    async publishInterrupt(sessionId) { await redis.publish(`interrupt:${sessionId}`, "1"); },
    onInterrupt(sessionId, cb) { return subscriber(`interrupt:${sessionId}`, () => cb()); },
    async pushSteer(sessionId, ev) { await redis.rpush(`steer:${sessionId}`, JSON.stringify(ev)); },
    async popSteer(sessionId) {
      const key = `steer:${sessionId}`;
      const res = await redis.multi().lrange(key, 0, -1).del(key).exec();
      return ((res?.[0]?.[1] as string[] | undefined) ?? []).map((s) => JSON.parse(s) as Steer);
    },
    async publishToolResult(sessionId, callId, msg) { await redis.rpush(`toolresult:${sessionId}:${callId}`, JSON.stringify(msg)); await redis.pexpire(`toolresult:${sessionId}:${callId}`, 3_600_000); },
    async takeToolResult(sessionId, callId) { const s = await redis.lpop(`toolresult:${sessionId}:${callId}`); return s ? (JSON.parse(s) as ToolResultMsg) : null; },
    async publishProvidersChanged() { await redis.publish(PROVIDERS_CHANNEL, String(Date.now())); },
    onProvidersChanged(cb) { return subscriber(PROVIDERS_CHANNEL, () => cb()); },
    async close() { await redis.quit().catch(() => {}); },
  };
}

function memoryBus(): Bus {
  const emitter = new EventEmitter(); emitter.setMaxListeners(0);
  const lists = new Map<string, string[]>();
  const push = (k: string, v: string) => { (lists.get(k) ?? lists.set(k, []).get(k)!).push(v); };
  const on = (channel: string, cb: (msg: string) => void): Promise<() => void> => {
    const h = (msg: string) => cb(msg); emitter.on(channel, h); return Promise.resolve(() => emitter.off(channel, h));
  };
  return {
    async publish(delta) { const id = delta.type === "event" ? delta.event.session_id : delta.session_id; emitter.emit(`sess:${id}`, JSON.stringify(delta)); },
    subscribe(sessionId, cb) { return on(`sess:${sessionId}`, (msg) => cb(JSON.parse(msg) as StreamDelta)); },
    async publishInterrupt(sessionId) { emitter.emit(`interrupt:${sessionId}`, "1"); },
    onInterrupt(sessionId, cb) { return on(`interrupt:${sessionId}`, () => cb()); },
    async pushSteer(sessionId, ev) { push(`steer:${sessionId}`, JSON.stringify(ev)); },
    async popSteer(sessionId) { const k = `steer:${sessionId}`; const items = lists.get(k) ?? []; lists.delete(k); return items.map((s) => JSON.parse(s) as Steer); },
    async publishToolResult(sessionId, callId, msg) { push(`toolresult:${sessionId}:${callId}`, JSON.stringify(msg)); },
    async takeToolResult(sessionId, callId) { const k = `toolresult:${sessionId}:${callId}`; const arr = lists.get(k); const s = arr?.shift(); if (arr && !arr.length) lists.delete(k); return s ? (JSON.parse(s) as ToolResultMsg) : null; },
    async publishProvidersChanged() { emitter.emit(PROVIDERS_CHANNEL); },
    onProvidersChanged(cb) { return on(PROVIDERS_CHANNEL, () => cb()); },
    async close() {},
  };
}

const bus: Bus = env.MESSAGING_BACKEND === "memory" ? memoryBus() : redisBus();

// Stable module API (callers unchanged): delegate to the selected backend.
export const publish = (delta: StreamDelta) => bus.publish(delta);
export const subscribe = (sessionId: string, cb: (d: StreamDelta) => void) => bus.subscribe(sessionId, cb);
export const publishInterrupt = (sessionId: string) => bus.publishInterrupt(sessionId);
export const onInterrupt = (sessionId: string, cb: () => void) => bus.onInterrupt(sessionId, cb);
export const pushSteer = (sessionId: string, ev: Steer) => bus.pushSteer(sessionId, ev);
export const popSteer = (sessionId: string) => bus.popSteer(sessionId);
export const publishToolResult = (sessionId: string, callId: string, msg: ToolResultMsg) => bus.publishToolResult(sessionId, callId, msg);
export const takeToolResult = (sessionId: string, callId: string) => bus.takeToolResult(sessionId, callId);
export const publishProvidersChanged = () => bus.publishProvidersChanged();
export const onProvidersChanged = (cb: () => void) => bus.onProvidersChanged(cb);
export const closeBus = () => bus.close();
