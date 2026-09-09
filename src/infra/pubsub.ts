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
