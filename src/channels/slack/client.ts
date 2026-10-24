/** Minimal Slack Web API client used by the channel adapter (chat.postMessage + reactions). */

export interface SlackPostMessageOpts {
  channel: string;
  thread_ts?: string;
  text: string;
  blocks?: unknown[];
}

export interface SlackClient {
  postMessage(opts: SlackPostMessageOpts): Promise<{ ok: boolean; ts?: string; error?: string }>;
}

export function slackClient(botToken: string, fetchImpl: typeof fetch = fetch): SlackClient {
  return {
    async postMessage(opts) {
      const res = await fetchImpl("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${botToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: opts.channel,
          text: opts.text,
          ...(opts.thread_ts ? { thread_ts: opts.thread_ts } : {}),
          ...(opts.blocks ? { blocks: opts.blocks } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; ts?: string; error?: string };
      if (!res.ok) return { ok: false, error: `http_${res.status}` };
      return { ok: !!data.ok, ts: data.ts, error: data.error };
    },
  };
}

/** Strip Slack user/channel mention markup so the model sees plain text. */
export function stripSlackMentions(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+>/gi, "")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/gi, "#$1")
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract plain text from rethink content blocks (agent.message / user.message). */
export function textOfBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((b: { type?: string; text?: string }) => (typeof b?.text === "string" ? b.text : b?.type && b.type !== "text" ? `[${b.type}]` : ""))
    .join("")
    .trim();
}
