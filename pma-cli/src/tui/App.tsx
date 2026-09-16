import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { apiGet, apiPost, apiRequest, fmtCtx, fmtTokens, interrupt, sendMessage, streamEvents, textOf, ApiError, type Agent, type PluginInfo, type ContextSize, type Environment, type ModelInfo, type Session, type SessionEvent, type Usage } from "../lib/client.ts";
import { loadConfig, saveConfig } from "../lib/config.ts";
import { createSession } from "../cli/sessions.ts";
import { Input } from "./Input.tsx";
import { Selector, type SelectorItem } from "./Selector.tsx";
import { emitUiEvent, keyOf, loadUiPlugins, type UiRegistry } from "./plugins.ts";
import type { UiContext } from "../ui-api.ts";

// ─── Message model (same shape as qca: tool results hang under their tool_use) ───
interface Message {
  id: number;
  role: "user" | "agent" | "tool" | "system" | "thinking";
  content: string;
  toolName?: string;
  toolUseId?: string;
  toolStatus?: "preparing" | "running" | "success" | "error";
  /** streaming tool-call argument fragments (before the persisted agent.tool_use arrives) */
  argsPreview?: string;
  streamIndex?: number;
  /** stream id shared by an assistant message's deltas and its persisted event */
  streamId?: string;
  /** raw tool input (for UI plugin renderers) */
  toolInput?: unknown;
  result?: string;
  streaming?: boolean;
  /** Optimistically shown user message not yet confirmed by its persisted event. */
  pending?: boolean;
}
let nextId = 1;
const msg = (m: Omit<Message, "id">): Message => ({ id: nextId++, ...m });

function formatToolDesc(name: string, input: any): string {
  if (!input || typeof input !== "object") return `${name}()`;
  const first = input.command ?? input.path ?? Object.values(input)[0] ?? "";
  const s = String(first).split("\n")[0]!;
  return `${name}(${s.length > 80 ? s.slice(0, 77) + "…" : s})`;
}

/** Fold persisted events into messages; returns the last seq so the stream can resume after it. */
function buildMessages(events: SessionEvent[]): { messages: Message[]; lastSeq: number; running: boolean } {
  const out: Message[] = [];
  const tools = new Map<string, Message>();
  let running = false;
  for (const e of events) {
    const p = e.payload;
    switch (e.type) {
      case "user.message": out.push(msg({ role: "user", content: textOf(p.content) })); break;
      case "agent.message": {
        if (p.thinking) out.push(msg({ role: "thinking", content: p.thinking }));
        const t = textOf(p.content); if (t) out.push(msg({ role: "agent", content: t })); break;
      }
      case "agent.tool_use": { const m = msg({ role: "tool", content: formatToolDesc(p.name, p.input), toolName: p.name, toolUseId: p.tool_use_id, toolStatus: "success", toolInput: p.input }); tools.set(p.tool_use_id, m); out.push(m); break; }
      case "agent.tool_result": { const m = tools.get(p.tool_use_id); if (m) { m.result = textOf(p.content); m.toolStatus = p.is_error ? "error" : "success"; } break; }
      case "session.status_running": running = true; break;
      case "session.status_idle": running = false; if (p.stop_reason !== "end_turn") out.push(msg({ role: "system", content: `stopped: ${p.stop_reason}` })); break;
      case "session.status_terminated": running = false; out.push(msg({ role: "system", content: "session terminated" })); break;
      case "session.error": out.push(msg({ role: "system", content: `✗ ${p.error.type}: ${p.error.message}` })); break;
      case "agent.thread_context_compacted": out.push(msg({ role: "system", content: `⇣ context compacted: ${p.tokens_before} → ${p.tokens_after} tokens` })); break;
      case "plugin.message": out.push(msg({ role: "system", content: `⚑ ${p.plugin}: ${textOf(p.content)}` })); break;
    }
  }
  return { messages: out, lastSeq: events.length ? events[events.length - 1]!.seq : 0, running };
}

const COMMANDS: { name: string; desc: string }[] = [
  { name: "/new", desc: "New session (optional first message)" },
  { name: "/sessions", desc: "Switch session" },
  { name: "/agent", desc: "Pick default agent" },
  { name: "/env", desc: "Pick default environment" },
  { name: "/model", desc: "Model override for the next /new" },
  { name: "/status", desc: "Session info" },
  { name: "/prompt", desc: "Show the system prompt as sent (/prompt set <text> changes it)" },
  { name: "/plugins", desc: "Plugins on this session (or chosen for the next), and what this deployment offers" },
  { name: "/plugins search", desc: "Search the available plugins (/plugins search outcome)" },
  { name: "/plugins add", desc: "Attach one by name — no argument opens a picker; before a session, it is chosen for the next" },
  { name: "/plugins remove", desc: "Detach one (/plugins remove <source>)" },
  { name: "/sandboxes", desc: "List sandboxes" },
  { name: "/export", desc: "Export conversation to a file (--json)" },
  { name: "/cancel", desc: "Interrupt the running turn" },
  { name: "/clear", desc: "Clear the screen" },
  { name: "/help", desc: "All commands" },
  { name: "/quit", desc: "Exit" },
];

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function Spinner({ seconds }: { seconds: number }) {
  const [f, setF] = useState(0);
  useEffect(() => { const t = setInterval(() => setF((x) => (x + 1) % FRAMES.length), 80); return () => clearInterval(t); }, []);
  return <Text color="cyan">{FRAMES[f]} Generating… <Text dimColor>(esc to cancel, {seconds}s)</Text></Text>;
}

function MessageView({ m, expanded, reg, uiCtx }: { m: Message; expanded: boolean; reg?: UiRegistry; uiCtx?: UiContext }) {
  switch (m.role) {
    case "user":
      return <Box marginTop={1}><Text color="cyan" bold>› </Text><Text>{m.content}</Text></Box>;
    case "agent":
      return <Box marginTop={1}><Text>{m.content}{m.streaming ? <Text color="cyan">▌</Text> : null}</Text></Box>;
    case "system":
      return <Box marginTop={1}><Text dimColor italic>{m.content}</Text></Box>;
    case "thinking": {
      const lines = m.content.split("\n").filter((l) => l.trim());
      const shown = expanded ? lines : lines.slice(-2);
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor italic>∴ thinking{m.streaming ? "…" : ""}{!expanded && lines.length > 2 ? ` (${lines.length} lines, ctrl+o)` : ""}</Text>
          {shown.map((l, i) => <Text key={i} dimColor italic>  {l}</Text>)}
        </Box>
      );
    }
    case "tool": {
      const color = m.toolStatus === "error" ? "red" : m.toolStatus === "running" || m.toolStatus === "preparing" ? "yellow" : "green";
      // A UI plugin may take over the title and body of this tool's rows.
      let custom: { title?: string; lines?: string[] } | null = null;
      const renderer = m.toolName && reg?.toolRenderers.get(m.toolName);
      if (renderer && uiCtx && m.toolStatus !== "preparing") { try { custom = renderer(m.toolInput, m.result, uiCtx); } catch { custom = null; } }
      const title = custom?.title ?? m.content;
      const lines = custom?.lines ?? (m.result ?? "").split("\n");
      const shown = custom?.lines ? custom.lines : expanded ? lines : lines.slice(0, 3);
      const preview = m.toolStatus === "preparing" ? (m.argsPreview ?? "").replace(/\s+/g, " ").slice(-70) : "";
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text><Text color={color}>▪</Text> <Text bold>{title}</Text>{m.toolStatus === "running" ? <Text dimColor> …</Text> : m.toolStatus === "preparing" ? <Text dimColor> {preview || "…"}</Text> : null}</Text>
          {(m.result !== undefined || custom?.lines) && shown.map((l, i) => <Text key={i} dimColor>  {i === 0 ? "└ " : "  "}{l}</Text>)}
          {m.result !== undefined && !custom?.lines && lines.length > shown.length && <Text dimColor>    … {lines.length - shown.length} more lines (ctrl+o)</Text>}
        </Box>
      );
    }
  }
}

export interface TuiOptions { resume?: string; agent?: string; env?: string; message?: string; workspaceId?: string; model?: string }

function App({ opts }: { opts: TuiOptions }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [selector, setSelector] = useState<{ title: string; items: SelectorItem[]; onSelect(it: SelectorItem): void } | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [ctrlC, setCtrlC] = useState(0);
  const [modelOverride, setModelOverride] = useState<string | undefined>(opts.model);
  /** Plugins chosen before there is a session: attached to the one the next message starts. */
  const [pendingPlugins, setPendingPlugins] = useState<string[]>([]);
  const [sandboxInfo, setSandboxInfo] = useState<string>("");
  const [ctx, setCtx] = useState<ContextSize | null>(null);
  const [reg, setReg] = useState<UiRegistry | null>(null);
  const regRef = useRef<UiRegistry | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const expandedRef = useRef(false);
  const selectResolve = useRef<((id: string | null) => void) | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const lastSeq = useRef(0);
  const streamAbort = useRef<AbortController | null>(null);
  const streamingMsg = useRef<Message | null>(null);
  const thinkingMsg = useRef<Message | null>(null);
  const preparingTools = useRef(new Map<number, Message>());
  const allCommands = [...COMMANDS, ...[...(reg?.commands.values() ?? [])].map((c) => ({ name: `/${c.name}`, desc: `${c.description} (${c.source})` }))];
  const suggestions = value.startsWith("/") && !value.includes(" ") ? allCommands.filter((c) => c.name.startsWith(value)) : [];
  const [sugIdx, setSugIdx] = useState(0);

  const sys = useCallback((content: string) => setMessages((p) => [...p, msg({ role: "system", content })]), []);

  // What UI plugins get: a small, client-only capability set.
  const uiCtx: UiContext = {
    get session() { return sessionRef.current; },
    send: (text) => send(text),
    note: (text) => sys(text),
    api: { get: (p) => apiGet(p), post: (p, b) => apiPost(p, b) },
    get expanded() { return expandedRef.current; },
    openSession: (id) => openSession(id),
    select: (title, items) => new Promise<string | null>((resolve) => {
      selectResolve.current = resolve;
      setSelector({ title, items, onSelect: (it) => { setSelector(null); selectResolve.current = null; resolve(it.id); } });
    }),
  };
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);
  useEffect(() => {
    loadUiPlugins().then((r) => {
      regRef.current = r; setReg(r);
      for (const l of r.loaded) if (l.error) sys(`✗ ui plugin ${l.source}: ${l.error}`);
    }).catch((e) => sys(`✗ ui plugins: ${e.message}`));
  }, []);

  // generating timer
  useEffect(() => {
    if (!generating) { setSeconds(0); return; }
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [generating]);

  // ── stream handling ──
  const handleItem = useCallback((item: Parameters<Parameters<typeof streamEvents>[2]>[0]) => {
    if (item.type === "agent.thinking_delta") {
      setMessages((prev) => {
        const cur = thinkingMsg.current;
        if (cur && prev.includes(cur) && cur.streamId === item.stream_id) {
          const upd = { ...cur, content: cur.content + item.text };
          thinkingMsg.current = upd;
          return prev.map((m) => (m === cur ? upd : m));
        }
        const m = msg({ role: "thinking", content: item.text, streaming: true, streamId: item.stream_id });
        thinkingMsg.current = m;
        return [...prev, m];
      });
      return;
    }
    if (item.type === "agent.tool_use_start") {
      finishThinking();
      setMessages((prev) => {
        const m = msg({ role: "tool", content: `${item.name}(…)`, toolName: item.name, toolStatus: "preparing", argsPreview: "", streamIndex: item.index });
        preparingTools.current.set(item.index, m);
        return [...prev, m];
      });
      return;
    }
    if (item.type === "agent.tool_use_delta") {
      setMessages((prev) => {
        const cur = preparingTools.current.get(item.index);
        if (!cur || !prev.includes(cur)) return prev;
        const upd = { ...cur, argsPreview: (cur.argsPreview ?? "") + item.text };
        preparingTools.current.set(item.index, upd);
        return prev.map((m) => (m === cur ? upd : m));
      });
      return;
    }
    if (item.type === "agent.message_delta") {
      finishThinking();
      setMessages((prev) => {
        const cur = streamingMsg.current;
        if (cur && prev.includes(cur) && cur.streamId === item.stream_id) {
          const upd = { ...cur, content: cur.content + item.text };
          streamingMsg.current = upd;
          return prev.map((m) => (m === cur ? upd : m));
        }
        const m = msg({ role: "agent", content: item.text, streaming: true, streamId: item.stream_id });
        streamingMsg.current = m;
        return [...prev, m];
      });
      return;
    }
    const e = item.event;
    if (e.seq <= lastSeq.current) return;
    lastSeq.current = e.seq;
    const p = e.payload;
    const r = regRef.current;
    if (r) {
      emitUiEvent(r, e, uiCtx);
      const render = r.eventRenderers.get(e.type);
      if (render) {
        let line: string | null = null;
        try { line = render(p, e, uiCtx); } catch (err: any) { line = `✗ renderer: ${err?.message ?? err}`; }
        if (line) sys(line);
        // a registered renderer owns this event type entirely (except the state transitions below)
        if (!["session.status_running", "session.status_idle", "session.status_terminated", "agent.message", "agent.tool_use", "agent.tool_result", "user.message", "span.model_request_end", "session.usage", "sandbox.acquired", "sandbox.released"].includes(e.type)) return;
      }
    }
    switch (e.type) {
      case "session.status_running": setGenerating(true); break;
      case "session.status_idle":
        setGenerating(false);
        finishStream();
        finishThinking();
        preparingTools.current.clear();
        if (p.stop_reason !== "end_turn") sys(`stopped: ${p.stop_reason}`);
        break;
      case "session.status_terminated": setGenerating(false); finishStream(); sys("session terminated"); break;
      case "session.error": sys(`✗ ${p.error.type}: ${p.error.message}`); break;
      case "agent.thread_context_compacted": sys(`⇣ context compacted: ${p.tokens_before} → ${p.tokens_after} tokens`); break;
      case "plugin.message": sys(`⚑ ${p.plugin}: ${textOf(p.content)}`); break;
      case "session.updated": sys(`⚙ session updated: ${Object.keys(p.changes).join(", ")} (applies next turn)`); break;
      case "user.message": {
        const text = textOf(p.content);
        setMessages((prev) => {
          // Our own send: the optimistic copy is already on screen (the POST reply may still be in flight).
          const i = prev.findIndex((m) => m.role === "user" && m.pending && m.content === text);
          if (i >= 0) return prev.map((m, k) => (k === i ? { ...m, pending: false } : m));
          return [...prev, msg({ role: "user", content: text })];
        });
        break;
      }
      case "agent.message": {
        const text = textOf(p.content);
        finishThinking();
        setMessages((prev) => {
          const cur = streamingMsg.current;
          streamingMsg.current = null;
          const byId = p.stream_id ? prev.find((m) => m.role === "agent" && m.streamId === p.stream_id) : undefined;
          const target = byId ?? (cur && prev.includes(cur) ? cur : undefined);
          let next = prev;
          if (target) next = prev.map((m) => (m === target ? { ...m, content: text || m.content, streaming: false } : m));
          else if (p.thinking && !prev.some((m) => m.role === "thinking" && m.streamId === p.stream_id)) next = [...prev, msg({ role: "thinking", content: p.thinking })];
          if (!target && text) next = [...next, msg({ role: "agent", content: text, streamId: p.stream_id })];
          return next;
        });
        break;
      }
      case "agent.tool_use": {
        finishStream();
        finishThinking();
        // Replace the streaming "preparing" placeholder (oldest pending one of this name) with the real call.
        const pending = [...preparingTools.current.entries()].find(([, m]) => m.toolName === p.name);
        setMessages((prev) => {
          const real = { role: "tool" as const, content: formatToolDesc(p.name, p.input), toolName: p.name, toolUseId: p.tool_use_id, toolStatus: "running" as const, toolInput: p.input };
          if (pending && prev.includes(pending[1])) {
            preparingTools.current.delete(pending[0]);
            return prev.map((m) => (m === pending[1] ? { ...m, ...real, argsPreview: undefined } : m));
          }
          return [...prev, msg(real)];
        });
        break;
      }
      case "agent.tool_result":
        setMessages((prev) => prev.map((m) => (m.role === "tool" && m.toolUseId === p.tool_use_id ? { ...m, result: textOf(p.content), toolStatus: p.is_error ? "error" : "success" } : m)));
        break;
      case "span.model_request_end": setCtx(p.context); break;
      case "session.usage": setUsage(p.usage); setCtx(p.context); break;
      case "sandbox.acquired": setSandboxInfo(`${p.provider}:${p.sandbox_id}`); break;
      case "sandbox.released": setSandboxInfo(""); break;
    }
  }, [sys]);

  function finishThinking() {
    const cur = thinkingMsg.current;
    if (!cur) return;
    thinkingMsg.current = null;
    setMessages((prev) => prev.map((m) => (m === cur ? { ...m, streaming: false } : m)));
  }

  function finishStream() {
    const cur = streamingMsg.current;
    if (!cur) return;
    streamingMsg.current = null;
    setMessages((prev) => prev.map((m) => (m === cur ? { ...m, streaming: false } : m)));
  }

  // attach the SSE stream whenever the session changes
  useEffect(() => {
    streamAbort.current?.abort();
    if (!session) return;
    const ac = new AbortController();
    streamAbort.current = ac;
    streamEvents(session.id, lastSeq.current, handleItem, ac.signal).catch((e) => { if (!ac.signal.aborted) sys(`✗ stream: ${e.message}`); });
    return () => ac.abort();
  }, [session?.id]);

  // ── session switching ──
  const openSession = useCallback(async (id: string) => {
    const s = (await apiGet(`/sessions/${id}`)) as Session;
    const { data } = (await apiGet(`/sessions/${id}/events?limit=100000`)) as { data: SessionEvent[] };
    const built = buildMessages(data);
    lastSeq.current = built.lastSeq;
    streamingMsg.current = null;
    setMessages(built.messages);
    setGenerating(built.running);
    setSandboxInfo("");
    setCtx(s.context ?? null);
    setUsage(s.usage ?? null);
    setSession(s);
  }, []);

  const newSession = useCallback(async (first?: string) => {
    const s = await createSession({ agent: opts.agent, env: opts.env, workspaceId: opts.workspaceId, model: modelOverride, packages: pendingPlugins, message: first });
    lastSeq.current = 0;
    streamingMsg.current = null;
    setMessages(first ? [msg({ role: "user", content: first, pending: true })] : []);
    setGenerating(!!first);
    setSandboxInfo("");
    setCtx(null);
    setUsage(null);
    setSession(s);
    return s;
  }, [opts, modelOverride, pendingPlugins]);

  // initial: resume, or create when a first message is given, else wait for input
  useEffect(() => {
    (async () => {
      try {
        if (opts.resume === "latest") {
          const { data } = (await apiGet("/sessions")) as { data: Session[] };
          const latest = data.filter((s) => s.status !== "terminated").sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
          if (!latest) return sys("no sessions to resume; type a message to start one");
          await openSession(latest.id);
        } else if (opts.resume) await openSession(opts.resume);
        else if (opts.message) await newSession(opts.message);
        else sys("type a message to start a session · /help for commands");
      } catch (e: any) { sys(`✗ ${e.message}`); }
    })();
  }, []);

  // ── sending ──
  async function send(text: string) {
    setHistory((h) => [text, ...h].slice(0, 100));
    setHistIdx(-1);
    try {
      if (!session) { await newSession(text); return; }
      setMessages((prev) => [...prev, msg({ role: "user", content: text, pending: true })]);
      const { events } = await sendMessage(session.id, text);
      for (const e of events) lastSeq.current = Math.max(lastSeq.current, e.seq);
      if (!generating) setGenerating(true);
    } catch (e: any) { sys(`✗ ${e.message}`); }
  }

  async function cancel() {
    if (!session || !generating) return;
    try { await interrupt(session.id); sys("interrupt sent"); } catch (e: any) { sys(`✗ ${e.message}`); }
  }

  // ── slash commands ──
  async function runCommand(line: string) {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(" ");
    const cfg = loadConfig();
    const plugin = regRef.current?.commands.get((cmd ?? "").slice(1));
    if (plugin) {
      try { await plugin.handler(arg, uiCtx); } catch (e: any) { sys(`✗ /${plugin.name}: ${e?.message ?? e}`); }
      return;
    }
    try {
      switch (cmd) {
        case "/help": {
          const sc = [...(regRef.current?.shortcuts.values() ?? [])].map((x) => `${x.key.padEnd(12)} ${x.description} (${x.source})`);
          sys(allCommands.map((c) => `${c.name.padEnd(16)} ${c.desc}`).join("\n") + "\n\nkeys: esc cancel · ctrl+o expand tools · ↑↓ history · tab complete · ctrl+c ×2 exit" + (sc.length ? "\n" + sc.join("\n") : ""));
          return;
        }
        case "/quit": case "/exit": case "/q": exit(); return;
        case "/cancel": case "/stop": await cancel(); return;
        case "/clear": stdout.write("\x1b[2J\x1b[H"); setMessages([]); return;
        case "/new": await newSession(arg || undefined); if (!arg) sys("new session started"); return;
        case "/status": {
          if (!session) return sys("no session");
          const s = (await apiGet(`/sessions/${session.id}`)) as Session;
          const u = s.usage;
          sys([`session   ${s.id}`, `status    ${s.status}`, `agent     ${s.agent.name} (${s.agent_id})`, `model     ${s.agent.model.provider}/${s.agent.model.id}`,
            `context   ${fmtCtx(s.context)}`,
            `usage     ${u ? `${fmtTokens(u.total_tokens)} tokens · in ${fmtTokens(u.input)} · cache ${fmtTokens(u.cache_read)} · out ${fmtTokens(u.output)} · ${u.requests} requests` : "-"}`,
            `envs      ${(s.environments ?? []).map((e) => `${e.key}=${e.environment_id}`).join(", ") || s.environment_id}`,
            `workspace ${s.workspace_id}`, `sandbox   ${sandboxInfo || "-"}`, `host      ${cfg.host}`].join("\n"));
          return;
        }
        case "/prompt": {
          if (!session) return sys("no session");
          if (arg.startsWith("set ")) { await apiRequest("PATCH", `/sessions/${session.id}`, { system: arg.slice(4) }); sys("system prompt updated (next turn)"); return; }
          if (arg === "reset") { await apiRequest("PATCH", `/sessions/${session.id}`, { system: null }); sys("system prompt reset to default (next turn)"); return; }
          const r = (await apiGet(`/sessions/${session.id}/system_prompt`)) as { rendered: string; source: string };
          sys(`system prompt (${r.source}):\n${r.rendered}`);
          return;
        }
        case "/plugins": case "/plugin": {
          const [op, ...srcParts] = arg.split(/\s+/).filter(Boolean);
          // Browsing the catalogue needs no session; only attaching does.
          const isSearch = op === "search" || op === "available";
          const source0 = srcParts.join(" ");
          // Before there is a session, plugins are *chosen* for the one the next message will start —
          // the same shape as /model. Nothing is attached to a saved agent either way.
          if (!session) {
            const { data } = (await apiGet(`/plugins${isSearch && source0 ? `?q=${encodeURIComponent(source0)}` : ""}`)) as { data: PluginInfo[] };
            const usable = data.filter((p) => p.allowed.runner || p.allowed.sandbox);
            const chosen = (list: string[]) => list.length ? `\n\nchosen for the next session:\n${list.map((p) => `  ${p}`).join("\n")}` : "";
            if (op === "remove" || op === "rm") {
              if (!source0) return sys("usage: /plugins remove <source>");
              const next = pendingPlugins.filter((p) => p !== source0 && !p.endsWith(`/${source0}`));
              setPendingPlugins(next);
              return sys(next.length === pendingPlugins.length ? `${source0} was not chosen` : `removed ${source0}${chosen(next)}`);
            }
            if (op === "add") {
              const match = usable.find((p) => p.source === source0 || p.name === source0);
              const pick = match?.source ?? source0;
              if (!pick) {
                if (!usable.length) return sys("this deployment ships no plugins you can attach");
                setSelector({ title: "Attach to the next session", items: usable.map((p) => ({ id: p.source, label: `${p.name}${pendingPlugins.includes(p.source) ? "  (chosen)" : ""}`, hint: p.description.slice(0, 90) })), onSelect: (it) => { setSelector(null); void runCommand(`/plugins add ${it.id}`); } });
                return;
              }
              if (pendingPlugins.includes(pick)) return sys(`${pick} is already chosen${chosen(pendingPlugins)}`);
              const next = [...pendingPlugins, pick];
              setPendingPlugins(next);
              return sys(`will attach ${pick} when the session starts (type a message or /new)${chosen(next)}`);
            }
            return sys((usable.length
              ? `plugins this deployment offers:\n${usable.map((p) => `  ${p.name.padEnd(12)} ${p.description.slice(0, 70)}`).join("\n")}`
              : "this deployment ships no plugins you can attach") + chosen(pendingPlugins)
              + (pendingPlugins.length ? "" : "\n\n/plugins add <name> chooses one for the session your next message starts"));
          }
          if ((op === "add" && !source0) || isSearch) {
            const q = isSearch ? source0 : "";
            const { data } = (await apiGet(`/plugins${q ? `?q=${encodeURIComponent(q)}` : ""}`)) as { data: PluginInfo[] };
            const attached = new Set(session.agent.packages ?? []);
            const items = data.filter((p) => p.allowed.runner || p.allowed.sandbox).map((p) => ({
              id: p.source,
              label: `${p.name}${attached.has(p.source) ? "  (attached)" : ""}`,
              hint: p.description.slice(0, 90),
            }));
            if (!items.length) return sys(q ? `no plugin matches "${q}"` : "this deployment ships no plugins you can attach");
            if (q && items.length === 1) return sys(`${items[0]!.label}\n  ${items[0]!.hint}\n  attach with: /plugins add ${items[0]!.id}`);
            setSelector({ title: "Attach a plugin to this session", items, onSelect: (it) => {
              setSelector(null);
              if (attached.has(it.id)) { sys(`${it.id} is already attached`); return; }
              void runCommand(`/plugins add ${it.id}`);
            } });
            return;
          }
          if (op === "add" || op === "remove" || op === "rm") {
            if (!source0) return sys("usage: /plugins add|remove <name | npm:pkg | git:url | /absolute/path>");
            // a bare catalogue name is accepted as well as a full source, since that is what the list shows
            const known = ((await apiGet("/plugins")) as { data: PluginInfo[] }).data.find((p) => p.name === source0);
            const source = known?.source ?? source0;
            const next = op === "add"
              ? await apiPost(`/sessions/${session.id}/packages`, { source })
              : await apiRequest("DELETE", `/sessions/${session.id}/packages/${encodeURIComponent(source)}`);
            const list = (next as Session).agent.packages ?? [];
            // the runner loads a host with the new list on the next run, so it is live from the next message
            sys(`${op === "add" ? "attached" : "detached"} ${source} (live from the next turn)\nplugins: ${list.join(", ") || "(none)"}`);
            return;
          }
          if (op) return sys("usage: /plugins [search <query> | add [name|source] | remove <name|source>]");
          const s = (await apiGet(`/sessions/${session.id}`)) as Session;
          const list = s.agent.packages ?? [];
          const { data } = (await apiGet("/plugins")) as { data: PluginInfo[] };
          const available = data.filter((p) => (p.allowed.runner || p.allowed.sandbox) && !list.includes(p.source));
          sys([
            list.length ? `plugins on this session:\n${list.map((p) => `  ${p}`).join("\n")}` : "no plugins on this session",
            available.length ? `\navailable here (/plugins add to pick one, /plugins <query> to search):\n${available.map((p) => `  ${p.name.padEnd(12)} ${p.description.slice(0, 70)}`).join("\n")}` : "",
          ].filter(Boolean).join("\n"));
          return;
        }
        case "/sessions": {
          const { data } = (await apiGet("/sessions")) as { data: Session[] };
          const items = data.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((s) => ({ id: s.id, label: `${s.id}  ${s.status.padEnd(10)} ${s.agent.name}`, hint: s.updated_at.slice(0, 16).replace("T", " ") }));
          setSelector({ title: "Sessions", items, onSelect: (it) => { setSelector(null); openSession(it.id).catch((e) => sys(`✗ ${e.message}`)); } });
          return;
        }
        case "/agent": case "/agents": {
          const { data } = (await apiGet("/agents")) as { data: Agent[] };
          setSelector({ title: "Default agent", items: data.map((a) => ({ id: a.id, label: `${a.name}`, hint: `${a.model.provider}/${a.model.id}  ${a.id}` })), onSelect: (it) => { setSelector(null); const c = loadConfig(); c.default_agent_id = it.id; saveConfig(c); opts.agent = it.id; sys(`default agent = ${it.id} (used by /new)`); } });
          return;
        }
        case "/env": case "/envs": {
          const { data } = (await apiGet("/environments")) as { data: Environment[] };
          setSelector({ title: "Default environment", items: data.map((e) => ({ id: e.id, label: `${e.name}`, hint: `${e.provider}${e.image ? " " + e.image : ""}  ${e.id}` })), onSelect: (it) => { setSelector(null); const c = loadConfig(); c.default_env_id = it.id; saveConfig(c); opts.env = it.id; sys(`default env = ${it.id} (used by /new)`); } });
          return;
        }
        case "/model": {
          const { data } = (await apiGet("/models")) as { data: ModelInfo[] };
          setSelector({ title: "Model override (applies to the next /new)", items: data.map((m) => ({ id: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}`, hint: `${m.context_window} ctx` })), onSelect: (it) => { setSelector(null); setModelOverride(it.id); sys(`model override = ${it.id}; run /new to start a session with it`); } });
          return;
        }
        case "/sandboxes": {
          const { data } = (await apiGet("/sandboxes")) as { data: { id: string; provider: string; status: string; workspace_id: string | null }[] };
          sys(data.length ? data.map((s) => `${s.id}  ${s.provider.padEnd(6)} ${s.status.padEnd(9)} ${s.workspace_id ?? ""}`).join("\n") : "no live sandboxes");
          return;
        }
        case "/export": {
          if (!session) return sys("no session");
          const json = arg.includes("--json");
          const { data } = (await apiGet(`/sessions/${session.id}/events?limit=100000`)) as { data: SessionEvent[] };
          const file = `${session.id}.${json ? "json" : "txt"}`;
          const body = json ? JSON.stringify(data, null, 2) : data.map((e) => {
            if (e.type === "user.message") return `> ${textOf(e.payload.content)}\n`;
            if (e.type === "agent.message") return `${textOf(e.payload.content)}\n`;
            if (e.type === "agent.tool_use") return `▪ ${e.payload.name}(${JSON.stringify(e.payload.input)})`;
            if (e.type === "agent.tool_result") return `  ${textOf(e.payload.content).replace(/\n/g, "\n  ")}\n`;
            return "";
          }).filter(Boolean).join("\n");
          const { writeFileSync } = await import("node:fs");
          writeFileSync(file, body);
          sys(`exported to ${file}`);
          return;
        }
        default:
          // Not a local command: server-side plugin commands (e.g. /goal) are ordinary messages.
          await send(line.trim());
      }
    } catch (e: any) { sys(`✗ ${e instanceof ApiError ? `${e.status} ${e.message}` : e.message}`); }
  }

  function onSubmit(v: string) {
    const text = v.trim();
    if (!text) return;
    if (suggestions.length && text.startsWith("/") && !allCommands.some((c) => c.name === text.split(" ")[0])) {
      const s = suggestions[sugIdx] ?? suggestions[0]!;
      setValue(s.name + " "); setCursor(s.name.length + 1); return;
    }
    setValue(""); setCursor(0); setSugIdx(0);
    if (text.startsWith("/")) void runCommand(text); else void send(text);
  }

  // global keys (handled before the editor)
  const onKey = (input: string, key: any): boolean => {
    const k = keyOf(input, key);
    const sc = k ? regRef.current?.shortcuts.get(k) : undefined;
    if (sc && !(key.ctrl && (input === "c" || input === "o"))) {
      Promise.resolve(sc.handler(uiCtx)).catch((e: any) => sys(`✗ ${sc.key}: ${e?.message ?? e}`));
      return true;
    }
    if (key.ctrl && input === "c") {
      if (ctrlC > 0) { exit(); return true; }
      setCtrlC(1); setTimeout(() => setCtrlC(0), 1500); return true;
    }
    if (key.ctrl && input === "o") { setExpanded((x) => !x); return true; }
    if (key.escape) {
      if (suggestions.length) { setSugIdx(0); setValue(""); setCursor(0); return true; }
      if (value) { setValue(""); setCursor(0); return true; }
      if (generating) { void cancel(); return true; }
      return true;
    }
    if (key.tab) { if (suggestions.length) { const s = suggestions[sugIdx] ?? suggestions[0]!; setValue(s.name + " "); setCursor(s.name.length + 1); } return true; }
    if (key.upArrow) {
      if (suggestions.length) { setSugIdx((i) => (i - 1 + suggestions.length) % suggestions.length); return true; }
      const n = Math.min(histIdx + 1, history.length - 1);
      if (n >= 0 && history[n] !== undefined) { setHistIdx(n); setValue(history[n]!); setCursor(history[n]!.length); }
      return true;
    }
    if (key.downArrow) {
      if (suggestions.length) { setSugIdx((i) => (i + 1) % suggestions.length); return true; }
      const n = histIdx - 1;
      if (n < 0) { setHistIdx(-1); setValue(""); setCursor(0); } else { setHistIdx(n); setValue(history[n]!); setCursor(history[n]!.length); }
      return true;
    }
    return false;
  };

  const model = session ? `${session.agent.model.provider}/${session.agent.model.id}` : modelOverride ? `${modelOverride} (next)` : "";
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="magenta">pma</Text>
        <Text dimColor> · {session ? `${session.id} · ${session.agent.name}` : "no session"}{model ? ` · ${model}` : ""}{sandboxInfo ? ` · ⧉ ${sandboxInfo}` : ""}</Text>
        {ctx ? <Text color={ctx.ratio > 0.8 ? "red" : ctx.ratio > 0.5 ? "yellow" : undefined}> · ctx {fmtCtx(ctx)}</Text> : null}
        {usage ? <Text dimColor> · {fmtTokens(usage.total_tokens)} tok</Text> : null}
        {[...(reg?.status.entries() ?? [])].map(([id, render]) => { let t: string | null = null; try { t = render(uiCtx); } catch { t = null; } return t ? <Text key={id} dimColor> · {t}</Text> : null; })}
      </Box>
      {messages.map((m) => <MessageView key={m.id} m={m} expanded={expanded} reg={reg ?? undefined} uiCtx={uiCtx} />)}
      {generating && <Box marginTop={1}><Spinner seconds={seconds} /></Box>}
      <Box marginTop={1} flexDirection="column">
        {selector ? (
          <Selector title={selector.title} items={selector.items} onSelect={selector.onSelect} onCancel={() => { setSelector(null); selectResolve.current?.(null); selectResolve.current = null; }} />
        ) : (
          <>
            <Input value={value} cursor={cursor} onChange={(v, c) => { setValue(v); setCursor(c); setSugIdx(0); }} onSubmit={onSubmit} onKey={onKey} active={!selector} placeholder={session ? "message…  (/ for commands)" : "first message starts a session…"} />
            {suggestions.length > 0 && (
              <Box flexDirection="column" paddingLeft={2}>
                {suggestions.slice(0, 8).map((s, i) => <Text key={s.name} color={i === sugIdx ? "cyan" : undefined}>{i === sugIdx ? "❯ " : "  "}{s.name.padEnd(16)}<Text dimColor>{s.desc}</Text></Text>)}
              </Box>
            )}
          </>
        )}
        <Text dimColor>{ctrlC ? "press ctrl+c again to exit" : "esc cancel · ctrl+o tools · /help"}</Text>
      </Box>
    </Box>
  );
}

export async function startTUI(opts: TuiOptions): Promise<void> {
  const { waitUntilExit } = render(<App opts={opts} />, { exitOnCtrlC: false });
  await waitUntilExit();
}
