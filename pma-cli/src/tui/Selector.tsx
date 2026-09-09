import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export interface SelectorItem { id: string; label: string; hint?: string }

/** ↑↓ list with type-to-filter, Enter selects, Esc cancels (qca's Selector, minus pagination). */
export function Selector({ title, items, onSelect, onCancel }: { title: string; items: SelectorItem[]; onSelect(item: SelectorItem): void; onCancel(): void }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const filtered = items.filter((it) => !q || `${it.label} ${it.hint ?? ""} ${it.id}`.toLowerCase().includes(q.toLowerCase()));
  const idx = Math.min(i, Math.max(0, filtered.length - 1));
  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return) { const it = filtered[idx]; if (it) onSelect(it); return; }
    if (key.upArrow) return setI(filtered.length ? (idx - 1 + filtered.length) % filtered.length : 0);
    if (key.downArrow) return setI(filtered.length ? (idx + 1) % filtered.length : 0);
    if (key.backspace || key.delete) return setQ((s) => s.slice(0, -1));
    if (input && !key.ctrl && !key.meta) setQ((s) => s + input);
  });
  const rows = 10;
  const start = Math.max(0, Math.min(idx - Math.floor(rows / 2), filtered.length - rows));
  const shown = filtered.slice(start, start + rows);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold>{title} <Text dimColor>{q ? `/${q}` : "(type to filter, ↑↓ Enter, Esc)"}</Text></Text>
      {shown.length === 0 && <Text dimColor>no matches</Text>}
      {shown.map((it, k) => {
        const sel = start + k === idx;
        return (
          <Text key={it.id} color={sel ? "cyan" : undefined}>
            {sel ? "❯ " : "  "}{it.label}{it.hint ? <Text dimColor>  {it.hint}</Text> : null}
          </Text>
        );
      })}
      {filtered.length > rows && <Text dimColor>{start + 1}-{start + shown.length} of {filtered.length}</Text>}
    </Box>
  );
}
