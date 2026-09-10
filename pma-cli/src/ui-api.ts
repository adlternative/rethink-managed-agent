/**
 * pma UI plugin API — client-side only. Plugins extend the terminal UI: slash commands handled
 * locally, keyboard shortcuts, header status segments, custom rendering of tool rows and events,
 * and observers over the session's event stream. They never see server code; the only shared
 * thing with the server is the JSON shape of events, which is the public API.
 *
 * A plugin is a module in ~/.pma/plugins/<name>.(ts|js) (or a path listed under `ui_plugins` in
 * ~/.pma/config.json) that default-exports `(ui: UiAPI) => void`.
 */
import type { Session, SessionEvent } from "./lib/client.ts";

export interface UiContext {
  session: Session | null;
  /** send a user message to the current session (starts one if needed) */
  send(text: string): Promise<void>;
  /** show a local system line in the transcript (not sent anywhere) */
  note(text: string): void;
  /** the pma HTTP client, already pointed at the configured host */
  api: { get(path: string): Promise<any>; post(path: string, body?: unknown): Promise<any> };
  /** current tool-output expansion state (ctrl+o) */
  expanded: boolean;
  /** open a picker; resolves with the chosen id or null */
  select(title: string, items: { id: string; label: string; hint?: string }[]): Promise<string | null>;
  /** switch the TUI to another session */
  openSession(sessionId: string): Promise<void>;
}

export interface UiCommand {
  name: string; // without the leading slash
  description: string;
  handler(args: string, ctx: UiContext): Promise<void> | void;
}

export interface UiShortcut {
  /** "ctrl+g", "meta+r", "ctrl+shift+x" — letters only */
  key: string;
  description: string;
  handler(ctx: UiContext): Promise<void> | void;
}

export interface ToolRender {
  /** replaces the "name(arg)" title */
  title?: string;
  /** replaces the result lines (already truncated/expanded by you) */
  lines?: string[];
}

export interface UiAPI {
  registerCommand(cmd: UiCommand): void;
  registerShortcut(sc: UiShortcut): void;
  /** a header segment; return null to hide */
  registerStatus(id: string, render: (ctx: UiContext) => string | null): void;
  /** custom rendering for one tool's rows; return null to keep the default */
  registerToolRenderer(toolName: string, render: (input: any, result: string | undefined, ctx: UiContext) => ToolRender | null): void;
  /** custom one-line rendering for an event type (persisted events only); return null to keep the default / hide */
  registerEventRenderer(eventType: string, render: (payload: any, event: SessionEvent, ctx: UiContext) => string | null): void;
  /** observe persisted events ("*" for all) */
  on(eventType: string, handler: (event: SessionEvent, ctx: UiContext) => void): void;
}

export type UiPluginFactory = (ui: UiAPI) => void | Promise<void>;
