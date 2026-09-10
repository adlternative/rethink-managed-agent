import { describe, it, expect } from "vitest";
import { DEFAULT_SYSTEM_PROMPT, renderSystemPrompt } from "../src/harness/system-prompt.ts";

const sections = { skills: [{ name: "haiku", description: "for haikus" }], memory: [{ mount_path: "memories/notes", description: "team notes" }], plugins: "## Goal\nship it" };

describe("system prompt rendering", () => {
  it("defaults to one sentence and appends only the sections that apply", () => {
    expect(renderSystemPrompt(undefined, {})).toBe(DEFAULT_SYSTEM_PROMPT);
    const out = renderSystemPrompt("Be terse.", sections);
    expect(out.startsWith("Be terse.")).toBe(true);
    expect(out).toContain("- haiku: for haikus");
    expect(out).toContain("- memories/notes: team notes");
    expect(out).toContain("## Goal");
    expect(renderSystemPrompt("Be terse.", {})).toBe("Be terse.");
  });
  it("gives the user full control with placeholders", () => {
    const out = renderSystemPrompt("Rules first.\n{{memory}}\nThat is all.", sections);
    expect(out).toBe("Rules first.\nMemory (persists across sessions; read first, write durable notes there):\n- memories/notes: team notes\nThat is all.");
    // skills and plugin text are not appended when placeholders are used and omitted
    expect(out).not.toContain("haiku");
    expect(out).not.toContain("## Goal");
    // an unused placeholder for an empty section disappears cleanly
    expect(renderSystemPrompt("A\n\n{{skills}}\n\nB", {})).toBe("A\n\nB");
  });
});
