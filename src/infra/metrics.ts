/**
 * A tiny, dependency-free Prometheus registry (counters, gauges, histograms) with text exposition.
 * Metrics are per-process, so the API and the runner each expose their own `/metrics`. Kept minimal
 * on purpose — swap for prom-client if you outgrow it; the call sites (inc/observe/set) are stable.
 */
type Labels = Record<string, string>;
const keyOf = (l?: Labels) => (l ? Object.keys(l).sort().map((k) => `${k}=${JSON.stringify(l[k])}`).join(",") : "");
const lbl = (l?: Labels) => (l && Object.keys(l).length ? `{${Object.keys(l).sort().map((k) => `${k}="${String(l[k]).replace(/["\\\n]/g, "_")}"`).join(",")}}` : "");

interface Metric { render(name: string): string[] }

class Counter implements Metric {
  private v = new Map<string, { labels?: Labels; n: number }>();
  inc(labels?: Labels, by = 1) { const k = keyOf(labels); const c = this.v.get(k) ?? { labels, n: 0 }; c.n += by; this.v.set(k, c); }
  render(name: string) { return [...this.v.values()].map((c) => `${name}${lbl(c.labels)} ${c.n}`); }
}
class Gauge implements Metric {
  private v = new Map<string, { labels?: Labels; n: number }>();
  set(n: number, labels?: Labels) { this.v.set(keyOf(labels), { labels, n }); }
  render(name: string) { return [...this.v.values()].map((g) => `${name}${lbl(g.labels)} ${g.n}`); }
}
const DEFAULT_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300];
class Histogram implements Metric {
  private v = new Map<string, { labels?: Labels; counts: number[]; sum: number; n: number }>();
  constructor(private buckets = DEFAULT_BUCKETS) {}
  observe(value: number, labels?: Labels) {
    const k = keyOf(labels); const h = this.v.get(k) ?? { labels, counts: this.buckets.map(() => 0), sum: 0, n: 0 };
    this.buckets.forEach((b, i) => { if (value <= b) h.counts[i]!++; });
    h.sum += value; h.n++; this.v.set(k, h);
  }
  render(name: string) {
    const out: string[] = [];
    for (const h of this.v.values()) {
      const base = h.labels ? { ...h.labels } : {};
      this.buckets.forEach((b, i) => out.push(`${name}_bucket${lbl({ ...base, le: String(b) })} ${h.counts[i]}`));
      out.push(`${name}_bucket${lbl({ ...base, le: "+Inf" })} ${h.n}`);
      out.push(`${name}_sum${lbl(h.labels)} ${h.sum}`);
      out.push(`${name}_count${lbl(h.labels)} ${h.n}`);
    }
    return out;
  }
}

type Kind = "counter" | "gauge" | "histogram";
const registry = new Map<string, { kind: Kind; help: string; metric: Metric }>();
function reg<T extends Metric>(name: string, kind: Kind, help: string, make: () => T): T {
  const existing = registry.get(name); if (existing) return existing.metric as T;
  const metric = make(); registry.set(name, { kind, help, metric }); return metric;
}

export const counter = (name: string, help = "") => reg(name, "counter", help, () => new Counter());
export const gauge = (name: string, help = "") => reg(name, "gauge", help, () => new Gauge());
export const histogram = (name: string, help = "", buckets?: number[]) => reg(name, "histogram", help, () => new Histogram(buckets));

/** Callbacks run at scrape time to refresh gauges (e.g. queue depth) without a background timer. */
const scrapers: Array<() => void | Promise<void>> = [];
export const onScrape = (fn: () => void | Promise<void>) => { scrapers.push(fn); };

export async function render(): Promise<string> {
  for (const s of scrapers) { try { await s(); } catch { /* a failing scraper must not break /metrics */ } }
  const lines: string[] = [];
  for (const [name, { kind, help, metric }] of registry) {
    if (help) lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${kind}`);
    lines.push(...metric.render(name));
  }
  return lines.join("\n") + "\n";
}
