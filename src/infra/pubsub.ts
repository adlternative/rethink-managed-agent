import { Redis } from "ioredis";
import { env } from "../shared/env.ts";
import type { ContentBlock, StreamDelta } from "../shared/types.ts";

/** Shared connection for commands (publish, lists). Subscribers need their own. */
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });

/** Resolves once the SUBSCRIBE is acknowledged, so nothing published after return is missed. */
async function subscriber(channel: string, onMessage: (msg: string) => void): Promise<() => void> {
  const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  sub.on("message", (ch, msg) => {
    if (ch === channel) onMessage(msg);
  });
  try {
    await sub.subscribe(channel);
  } catch (e) {
    sub.disconnect();
    throw e;
  }
  return () => {
    sub.disconnect();
  };
}

export async function publish(delta: StreamDelta): Promise<void> {
  const id = delta.type === "event" ? delta.event.session_id : delta.session_id;
  await redis.publish(`sess:${id}`, JSON.stringify(delta));
}

export function subscribe(sessionId: string, cb: (d: StreamDelta) => void): Promise<() => void> {
  return subscriber(`sess:${sessionId}`, (msg) => cb(JSON.parse(msg) as StreamDelta));
}

export async function publishInterrupt(sessionId: string): Promise<void> {
  await redis.publish(`interrupt:${sessionId}`, "1");
}

export function onInterrupt(sessionId: string, cb: () => void): Promise<() => void> {
  return subscriber(`interrupt:${sessionId}`, () => cb());
}

/** A user message persisted while the session was running; `seq` lets the runner dedupe against the log. */
export interface Steer {
  seq: number;
  content: ContentBlock[];
}

export async function pushSteer(sessionId: string, ev: Steer): Promise<void> {
  await redis.rpush(`steer:${sessionId}`, JSON.stringify(ev));
}

export async function popSteer(sessionId: string): Promise<Steer[]> {
  const key = `steer:${sessionId}`;
  const res = await redis.multi().lrange(key, 0, -1).del(key).exec();
  const items = (res?.[0]?.[1] as string[] | undefined) ?? [];
  return items.map((s) => JSON.parse(s) as Steer);
}

/** Result for a client/function tool call, delivered from the API process to the runner. */
export interface ToolResultMsg {
  content: ContentBlock[];
  isError: boolean;
}
/**
 * A durable per-call result channel (a Redis list, not lossy pub/sub): a result pushed before the
 * runner starts polling is still there, so there is no subscribe-before-publish race. The awaiting
 * tool execute drains it with takeToolResult.
 */
export async function publishToolResult(sessionId: string, callId: string, msg: ToolResultMsg): Promise<void> {
  await redis.rpush(`toolresult:${sessionId}:${callId}`, JSON.stringify(msg));
  await redis.pexpire(`toolresult:${sessionId}:${callId}`, 3_600_000);
}
export async function takeToolResult(sessionId: string, callId: string): Promise<ToolResultMsg | null> {
  const s = await redis.lpop(`toolresult:${sessionId}:${callId}`);
  return s ? (JSON.parse(s) as ToolResultMsg) : null;
}

const PROVIDERS_CHANNEL = "providers:changed";
export async function publishProvidersChanged(): Promise<void> {
  await redis.publish(PROVIDERS_CHANNEL, String(Date.now()));
}
export function onProvidersChanged(cb: () => void): Promise<() => void> {
  return subscriber(PROVIDERS_CHANNEL, () => cb());
}
