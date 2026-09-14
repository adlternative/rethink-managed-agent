/**
 * System prompt = the user's text, plus the smallest possible framework sections.
 *
 * Placeholders give full control: `{{skills}}`, `{{memory}}`, `{{plugins}}`. If the prompt uses any
 * placeholder, only those sections are rendered, where they appear; unused ones are dropped. If it
 * uses none, the sections that apply are appended, one short block each. `{{plugins}}` is the text
 * plugins add through `context` / `before_agent_start` hooks.
 */
export const DEFAULT_SYSTEM_PROMPT = "You are a coding agent working in a sandboxed workspace. Paths are relative to the workspace root.";

export interface PromptSections {
  skills?: { name: string; description: string }[];
  prompts?: { name: string; description: string }[];
  memory?: { mount_path: string; description?: string }[];
  plugins?: string;
}

const PLACEHOLDER = /\{\{(skills|memory|plugins)\}\}/g; // for replace() only: a /g regex carries lastIndex between test() calls
const HAS_PLACEHOLDER = /\{\{(skills|memory|plugins)\}\}/;

export function renderSkills(s: PromptSections): string {
  const items = [...(s.skills ?? []), ...(s.prompts ?? [])];
  if (items.length === 0) return "";
  return `Skills (load with the skill tool before use):\n${items.map((x) => `- ${x.name}: ${x.description}`).join("\n")}`;
}

export function renderMemory(s: PromptSections): string {
  if (!s.memory?.length) return "";
  return `Memory (persists across sessions; read first, write durable notes there):\n${s.memory.map((m) => `- ${m.mount_path}${m.description ? `: ${m.description}` : ""}`).join("\n")}`;
}

export function renderSystemPrompt(system: string | null | undefined, sections: PromptSections): string {
  const base = system?.trim() || DEFAULT_SYSTEM_PROMPT;
  const parts: Record<string, string> = { skills: renderSkills(sections), memory: renderMemory(sections), plugins: sections.plugins?.trim() ?? "" };
  if (HAS_PLACEHOLDER.test(base)) {
    return base.replace(PLACEHOLDER, (_m, k: string) => parts[k] ?? "").replace(/\n{3,}/g, "\n\n").trim();
  }
  return [base, parts.skills, parts.memory, parts.plugins].filter(Boolean).join("\n\n");
}

export const usesPlaceholders = (system: string | null | undefined) => HAS_PLACEHOLDER.test(system ?? "");
