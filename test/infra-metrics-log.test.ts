import { describe, it, expect, vi, afterEach } from "vitest";

// log.ts reads LOG_LEVEL once at import (threshold), so set it before importing.
process.env.LOG_LEVEL = "warn";
process.env.LOG_FORMAT = "json";
const { counter, gauge, histogram, onScrape, render } = await import("../src/infra/metrics.ts");
const { log } = await import("../src/infra/log.ts");
const { env } = await import("../src/shared/env.ts");

const section = (text: string, name: string) => text.split("\n").filter((l) => l.includes(name));

describe("metrics exposition", () => {
  it("counter renders HELP/TYPE and sorted labels", async () => {
    const c = counter("t_requests_total", "Requests");
    c.inc({ b: "2", a: "1" });
    c.inc({ a: "1", b: "2" }, 2);
    c.inc();
    const lines = section(await render(), "t_requests_total");
    expect(lines).toEqual(["# HELP t_requests_total Requests", "# TYPE t_requests_total counter", 't_requests_total{a="1",b="2"} 3', "t_requests_total 1"]);
  });

  it("label values with quotes, backslashes or newlines are sanitized", async () => {
    counter("t_sanitize_total").inc({ v: 'a"b\\c\nd' });
    expect(section(await render(), "t_sanitize_total")).toContain('t_sanitize_total{v="a_b_c_d"} 1');
  });

  it("gauge set replaces the value; no HELP line without help", async () => {
    const g = gauge("t_depth"); g.set(5); g.set(2);
    expect(section(await render(), "t_depth")).toEqual(["# TYPE t_depth gauge", "t_depth 2"]);
  });

  it("histogram buckets are cumulative, +Inf equals count, sum is correct", async () => {
    const h = histogram("t_latency_seconds");
    h.observe(0.3); h.observe(400);
    const lines = section(await render(), "t_latency_seconds");
    const bucket = (le: string) => lines.find((l) => l.startsWith(`t_latency_seconds_bucket{le="${le}"}`))!.split(" ")[1];
    expect(bucket("0.25")).toBe("0");
    for (const le of ["0.5", "1", "2.5", "5", "10", "30", "60", "300"]) expect(bucket(le)).toBe("1");
    expect(bucket("+Inf")).toBe("2");
    expect(lines).toContain("t_latency_seconds_sum 400.3");
    expect(lines).toContain("t_latency_seconds_count 2");
  });

  it("histogram with labels merges le into the label set", async () => {
    const h = histogram("t_run_seconds", "", [1]);
    h.observe(0.5, { outcome: "done" });
    const lines = section(await render(), "t_run_seconds");
    expect(lines).toContain('t_run_seconds_bucket{le="1",outcome="done"} 1');
    expect(lines).toContain('t_run_seconds_bucket{le="+Inf",outcome="done"} 1');
    expect(lines).toContain('t_run_seconds_count{outcome="done"} 1');
  });

  it("scrapers refresh gauges; a throwing scraper does not break render", async () => {
    onScrape(() => { throw new Error("redis down"); });
    onScrape(async () => { gauge("t_scraped").set(42); });
    expect(section(await render(), "t_scraped")).toContain("t_scraped 42");
  });

  // Regression: reg() returns the existing metric regardless of kind, so the call site crashes later.
  it("re-registering a name as a different kind is rejected at registration", () => {
    counter("t_kind_clash").inc();
    let g: unknown;
    try { g = gauge("t_kind_clash"); } catch { return; } // throwing at registration is the fix
    expect(() => (g as { set(n: number): void }).set(1)).not.toThrow();
    throw new Error("gauge() after counter() returned a metric instead of rejecting");
  });
});

describe("structured logger", () => {
  afterEach(() => { vi.restoreAllMocks(); env.LOG_FORMAT = "json"; });
  const spies = () => ({ out: vi.spyOn(console, "log").mockImplementation(() => {}), err: vi.spyOn(console, "error").mockImplementation(() => {}) });
  const rec = (spy: { mock: { calls: unknown[][] } }, i = 0) => JSON.parse(spy.mock.calls[i]![0] as string);

  it("LOG_LEVEL=warn suppresses debug/info; error goes to console.error", () => {
    const { out, err } = spies();
    log.debug("d"); log.info("i"); log.warn("w"); log.error("e");
    expect(out).toHaveBeenCalledTimes(1);
    expect(rec(out)).toMatchObject({ level: "warn", msg: "w" });
    expect(err).toHaveBeenCalledTimes(1);
    expect(rec(err)).toMatchObject({ level: "error", msg: "e" });
    expect(typeof rec(out).ts).toBe("string");
  });

  it("child merges context; child-of-child overrides; fields override context", () => {
    const { out } = spies();
    log.child({ service: "api", run: "r1" }).child({ run: "r2" }).warn("x", { extra: 1 });
    expect(rec(out)).toMatchObject({ service: "api", run: "r2", extra: 1 });
    log.child({ k: "ctx" }).warn("y", { k: "field" });
    expect(rec(out, 1).k).toBe("field");
  });

  it("pretty format renders a single human line", () => {
    const { out } = spies();
    env.LOG_FORMAT = "pretty";
    log.warn("hello", { a: "b", n: { x: 1 } });
    expect(out.mock.calls[0]![0]).toMatch(/ WARN hello a=b n=\{"x":1\}$/);
  });

  // Regression: record spread lets fields override the record's level and msg.
  it("fields cannot override level or msg", () => {
    const { out } = spies();
    log.warn("real", { level: "debug", msg: "fake" });
    expect(rec(out)).toMatchObject({ level: "warn", msg: "real" });
  });

  // Regression: JSON.stringify throws on BigInt / circular values, so a log call can throw inside a finally.
  it("a BigInt or circular field does not make the log call throw", () => {
    spies();
    const circ: Record<string, unknown> = {}; circ.self = circ;
    expect(() => log.warn("n", { n: 1n })).not.toThrow();
    expect(() => log.warn("c", { circ })).not.toThrow();
  });
});
