import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { env } from "../src/shared/env.ts";
import { seal, open, secretsConfigured, type Sealed } from "../src/infra/secrets.ts";

// `env` is a plain object read at call time by secrets.ts, so each case sets the key directly.
const HEX = randomBytes(32).toString("hex");
const B64 = randomBytes(32).toString("base64");
afterEach(() => { env.PMA_SECRET_KEY = ""; });

const flip = (b64: string, i = 0) => { const b = Buffer.from(b64, "base64"); b[i] = b[i]! ^ 0xff; return b.toString("base64"); };

describe.each([["hex", HEX], ["base64", B64]])("seal/open with a %s key", (_n, key) => {
  it("round-trips empty, ASCII and multi-byte unicode", () => {
    env.PMA_SECRET_KEY = key;
    expect(secretsConfigured()).toBe(true);
    for (const s of ["", "sk-ant-123", "密钥 🔑 ключ"]) {
      const sealed = seal(s);
      expect(sealed).toMatchObject({ type: "encrypted", v: 1 });
      expect(Buffer.from(sealed.iv, "base64")).toHaveLength(12);
      expect(open(sealed)).toBe(s);
    }
  });

  it("two seals of the same plaintext differ (fresh IV) and never contain the plaintext", () => {
    env.PMA_SECRET_KEY = key;
    const a = seal("same secret value"), b = seal("same secret value");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(JSON.stringify(a)).not.toContain("same secret value");
  });

  it("tampering with ct, tag or iv makes open throw", () => {
    env.PMA_SECRET_KEY = key;
    const s = seal("tamper me");
    expect(() => open({ ...s, ct: flip(s.ct) })).toThrow();
    expect(() => open({ ...s, tag: flip(s.tag) })).toThrow();
    expect(() => open({ ...s, iv: flip(s.iv) })).toThrow();
  });

  it("opening with a different key throws", () => {
    env.PMA_SECRET_KEY = key;
    const s: Sealed = seal("x");
    env.PMA_SECRET_KEY = randomBytes(32).toString("hex");
    expect(() => open(s)).toThrow();
  });
});

describe("key configuration", () => {
  it("unset key: seal refuses and secretsConfigured is false", () => {
    env.PMA_SECRET_KEY = "";
    expect(secretsConfigured()).toBe(false);
    expect(() => seal("x")).toThrow(/PMA_SECRET_KEY is not set/);
  });

  it("wrong-length keys are rejected", () => {
    env.PMA_SECRET_KEY = randomBytes(16).toString("base64");
    expect(() => seal("x")).toThrow(/must be 32 bytes/);
    env.PMA_SECRET_KEY = randomBytes(16).toString("hex"); // 32 hex chars decode as base64 to 24 bytes
    expect(() => seal("x")).toThrow(/must be 32 bytes/);
  });

  it("an uppercase 64-char hex key is accepted as hex", () => {
    env.PMA_SECRET_KEY = HEX.toUpperCase();
    const s = seal("u");
    env.PMA_SECRET_KEY = HEX;
    expect(open(s)).toBe("u");
  });
});
