import { describe, expect, it } from "vitest";
import { DEFAULT_SYSTEM_PROMPT, renderMemory, renderSkills, renderSystemPrompt, usesPlaceholders } from "../src/harness/system-prompt.ts";

const skills = [{ name: "a", description: "b" }];

describe("renderSystemPrompt", () => {
  it("usesPlaceholders followed by renderSystemPrompt still renders in place (regression: shared global regex lastIndex)", () => {
    expect(usesPlaceholders("{{skills}}")).toBe(true);
    expect(renderSystemPrompt("{{skills}}", { skills })).toBe("Skills (load with the skill tool before use):\n- a: b");
  });

  it("usesPlaceholders is stable across repeated calls and handles null", () => {
    expect([usesPlaceholders("x {{memory}}"), usesPlaceholders("x {{memory}}"), usesPlaceholders(null), usesPlaceholders("{{other}}")]).toEqual([true, true, false, false]);
  });

  it("repeated renders of the same placeholder prompt are identical", () => {
    const p = "Top\n{{skills}}\n{{plugins}}";
    const first = renderSystemPrompt(p, { skills, plugins: "P" });
    expect(renderSystemPrompt(p, { skills, plugins: "P" })).toBe(first);
    expect(first).toBe("Top\nSkills (load with the skill tool before use):\n- a: b\nP");
  });

  it("drops plugin text when placeholders are used without {{plugins}}", () => {
    expect(renderSystemPrompt("Rules\n{{skills}}", { skills, plugins: "PLUGIN TEXT" })).not.toContain("PLUGIN TEXT");
  });

  it("renders prompt templates under Skills and memory without a description", () => {
    expect(renderSkills({ prompts: [{ name: "plan", description: "plan it" }], skills })).toBe("Skills (load with the skill tool before use):\n- a: b\n- plan: plan it");
    expect(renderMemory({ memory: [{ mount_path: "memories/x" }] })).toBe("Memory (persists across sessions; read first, write durable notes there):\n- memories/x");
  });

  it("falls back to the default for empty or whitespace-only system text and trims plugin text", () => {
    expect(renderSystemPrompt("   \n\t", {})).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(renderSystemPrompt(null, { plugins: "  \n " })).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(renderSystemPrompt("  Be brief.  ", { plugins: "  note  " })).toBe("Be brief.\n\nnote");
  });
});
