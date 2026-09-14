/** `<iso>` or `<iso>|<id>` -> [iso, id?]; throws on anything else (callers validate at the edge). */
export function parseSessionCursor(cursor: string): [string, string | undefined] {
  const i = cursor.indexOf("|");
  const ts = i < 0 ? cursor : cursor.slice(0, i);
  const id = i < 0 ? undefined : cursor.slice(i + 1);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(ts) || Number.isNaN(Date.parse(ts)) || (id !== undefined && !/^sess_[A-Za-z0-9_-]+$/.test(id))) throw new Error(`invalid session cursor: ${cursor}`);
  return [ts, id];
}
