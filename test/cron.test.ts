import { describe, it, expect } from "vitest";
import { assertTimezone, cronMatchesAt, nextRunAfter, parseCron } from "../src/shared/cron.ts";

describe("parseCron", () => {
  it("parses stars, ranges, steps and lists", () => {
    const c = parseCron("*/15 9-17 * * 1-5");
    expect([...c.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect(c.hour.has(9)).toBe(true);
    expect(c.hour.has(17)).toBe(true);
    expect(c.hour.has(8)).toBe(false);
    expect(c.dow.has(0)).toBe(false);
    expect(c.dow.has(1)).toBe(true);
  });

  it("treats dow 7 as Sunday", () => {
    expect(parseCron("0 0 * * 7").dow.has(0)).toBe(true);
  });

  it("rejects malformed expressions", () => {
    expect(() => parseCron("* * *")).toThrow(/5 fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/minute/);
    expect(() => parseCron("* * * * x")).toThrow(/dow/);
  });
});

describe("nextRunAfter", () => {
  it("finds the next hourly fire", () => {
    const after = new Date("2026-03-01T10:30:00.000Z");
    const next = nextRunAfter("0 * * * *", after, "UTC");
    expect(next?.toISOString()).toBe("2026-03-01T11:00:00.000Z");
  });

  it("matches every-minute schedules within a tick", () => {
    const after = new Date("2026-03-01T10:00:10.000Z");
    const next = nextRunAfter("* * * * *", after, "UTC");
    expect(next?.toISOString()).toBe("2026-03-01T10:01:00.000Z");
    expect(cronMatchesAt("* * * * *", next!, "UTC")).toBe(true);
  });

  it("respects a non-UTC timezone wall clock", () => {
    // 15:00 America/New_York on a winter day is 20:00 UTC
    const after = new Date("2026-01-15T19:30:00.000Z");
    const next = nextRunAfter("0 15 * * *", after, "America/New_York");
    expect(next?.toISOString()).toBe("2026-01-15T20:00:00.000Z");
  });
});

describe("assertTimezone", () => {
  it("accepts IANA names and rejects junk", () => {
    expect(assertTimezone("UTC")).toBe("UTC");
    expect(assertTimezone("Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(() => assertTimezone("Not/AZone")).toThrow(/unknown timezone/);
  });
});
