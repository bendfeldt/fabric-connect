/**
 * `display()` over Livy. Fabric's `display()` is a notebook-service feature
 * that Livy sessions do not have (neither Fabric Studio nor the portal's
 * Livy API renders it). We define a small `display()` in every Python
 * session: it prints DataFrames (Spark or pandas) as a tagged JSON payload,
 * which the editor turns back into a table. Everything else falls through
 * to `print`, as in plain Python.
 *
 * The payload is a line of its own: the tag, then single-line JSON, framed
 * by ASCII record separators (U+001E). Parsing does not rely on the
 * framing, because Fabric's Livy endpoint trims the end of the output and
 * so drops the trailing separator. Only whole lines that start with the tag
 * are taken, so ordinary prints around a payload survive.
 */

const TAG = "FABRIC_CONNECT_DISPLAY";
const RS = "\u001e";

/** Row limit per displayed DataFrame, like the portal's default preview. */
export const DISPLAY_ROW_LIMIT = 1000;

/** Python run once per session (kind `pyspark`) to define `display()`. */
export const DISPLAY_BOOTSTRAP_CODE = `
def display(obj=None, *args, **kwargs):
    import json as _fc_json
    try:
        from pyspark.sql import DataFrame as _FcSparkDF
    except Exception:
        _FcSparkDF = ()
    try:
        import pandas as _fc_pd
        _FcPandasDF = _fc_pd.DataFrame
    except Exception:
        _FcPandasDF = ()
    if isinstance(obj, _FcSparkDF):
        _rows = obj.limit(${DISPLAY_ROW_LIMIT} + 1).collect()
        _columns = list(obj.columns)
        _data = [list(r) for r in _rows[:${DISPLAY_ROW_LIMIT}]]
        _truncated = len(_rows) > ${DISPLAY_ROW_LIMIT}
    elif isinstance(obj, _FcPandasDF):
        _columns = [str(c) for c in obj.columns]
        _data = obj.head(${DISPLAY_ROW_LIMIT}).values.tolist()
        _truncated = len(obj) > ${DISPLAY_ROW_LIMIT}
    else:
        print(obj)
        return
    print("\\x1e${TAG}" + _fc_json.dumps({"columns": _columns, "rows": _data, "truncated": _truncated}, default=str) + "\\x1e")
`.trimStart();

export interface DisplayTable {
  readonly columns: string[];
  readonly rows: unknown[][];
  readonly truncated: boolean;
}

export interface ExtractedOutput {
  /** Plain text with every display payload removed. */
  readonly text: string;
  readonly tables: DisplayTable[];
}

/** Splits `display()` payloads out of a statement's text/plain output. */
export function extractDisplays(text: string): ExtractedOutput {
  const tables: DisplayTable[] = [];
  const chunks: string[] = [];
  const markers = new RegExp(`${RS}?${TAG}`, "g");
  let consumed = 0;
  for (let marker = markers.exec(text); marker; marker = markers.exec(text)) {
    const start = marker.index;
    const framed = marker[0].startsWith(RS);
    const lineStart = start === 0 || text.charAt(start - 1) === "\n";
    if (!framed && !lineStart) {
      continue;
    }
    const contentStart = start + marker[0].length;
    const payload = displayPayloadAt(text, contentStart);
    if (payload === undefined) {
      continue;
    }
    const closing = skipJsonWhitespace(text, payload.end);
    // A line-start separator introducing another table opens that next record.
    const nextRecord =
      (closing === 0 || text.charAt(closing - 1) === "\n") &&
      text.startsWith(`${RS}${TAG}`, closing) &&
      displayPayloadAt(text, closing + RS.length + TAG.length) !== undefined;
    let end: number | undefined;
    if (framed && text.charAt(closing) === RS && !nextRecord) {
      end = lineEnd(text, closing + 1) ?? closing + 1;
    } else if (
      lineStart &&
      payload.start === contentStart &&
      !/[\r\n]/.test(text.slice(payload.start, payload.end))
    ) {
      const bareEnd =
        text.charAt(payload.end) === RS ? payload.end + 1 : payload.end;
      end = lineEnd(text, bareEnd);
    }
    if (end === undefined) {
      continue;
    }
    chunks.push(text.slice(consumed, start));
    tables.push(payload.table);
    consumed = end;
    markers.lastIndex = end;
  }
  chunks.push(text.slice(consumed));
  return { text: chunks.join(""), tables };
}

/**
 * Livy `sql` statements return `application/json` shaped as
 * `{ schema: { fields: [{ name }] }, data: [[...]] }`; turn that into a table.
 */
export function livySqlResultToTable(value: unknown): DisplayTable | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const schema = value["schema"];
  const data = value["data"];
  if (
    !isRecord(schema) ||
    !Array.isArray(schema["fields"]) ||
    !Array.isArray(data)
  ) {
    return undefined;
  }
  const columns = schema["fields"].map((f) =>
    isRecord(f) && typeof f["name"] === "string" ? f["name"] : "",
  );
  const rows = data.filter(Array.isArray) as unknown[][];
  return { columns, rows, truncated: false };
}

/** Renders a table as self-contained, fully escaped HTML. */
export function renderTableHtml(table: DisplayTable): string {
  const head = table.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const body = table.rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(formatCell(cell))}</td>`).join("")}</tr>`,
    )
    .join("");
  const note = table.truncated
    ? `<p><em>Showing the first ${table.rows.length} rows.</em></p>`
    : `<p><em>${table.rows.length} row${table.rows.length === 1 ? "" : "s"}</em></p>`;
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${note}`;
}

/** Renders a table as aligned plain text (for output channels). */
export function renderTableText(table: DisplayTable): string {
  const cells = [table.columns, ...table.rows.map((r) => r.map(formatCell))];
  const widths = table.columns.map((_, i) =>
    Math.min(40, Math.max(...cells.map((row) => String(row[i] ?? "").length))),
  );
  const line = (row: unknown[]) =>
    row
      .map((cell, i) =>
        String(cell ?? "")
          .slice(0, 40)
          .padEnd(widths[i]),
      )
      .join(" | ")
      .trimEnd();
  const out = [
    line(table.columns),
    widths.map((w) => "-".repeat(w)).join("-+-"),
    ...table.rows.map((r) => line(r.map(formatCell))),
  ];
  out.push(
    table.truncated
      ? `(first ${table.rows.length} rows)`
      : `(${table.rows.length} row${table.rows.length === 1 ? "" : "s"})`,
  );
  return out.join("\n");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function displayPayloadAt(
  text: string,
  position: number,
): { start: number; end: number; table: DisplayTable } | undefined {
  const start = skipJsonWhitespace(text, position);
  const end = jsonObjectEnd(text, start);
  if (end === undefined) {
    return undefined;
  }
  const table = parseTable(text.slice(start, end));
  return table === undefined ? undefined : { start, end, table };
}

function skipJsonWhitespace(text: string, position: number): number {
  while (position < text.length && " \t\r\n".includes(text.charAt(position))) {
    position++;
  }
  return position;
}

function lineEnd(text: string, position: number): number | undefined {
  if (position === text.length) {
    return position;
  }
  if (text.startsWith("\r\n", position)) {
    return position + 2;
  }
  return text.charAt(position) === "\n" ? position + 1 : undefined;
}

function jsonObjectEnd(text: string, start: number): number | undefined {
  if (text.charAt(start) !== "{") {
    return undefined;
  }
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let position = start; position < text.length; position++) {
    const character = text.charAt(position);
    if (
      character === RS ||
      (character === "\n" && text.startsWith(TAG, position + 1))
    ) {
      return undefined;
    }
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === "{") {
      depth++;
    } else if (character === "}" && --depth === 0) {
      return position + 1;
    }
  }
  return undefined;
}

function parseTable(json: string): DisplayTable | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed["columns"]) ||
    !Array.isArray(parsed["rows"])
  ) {
    return undefined;
  }
  return {
    columns: parsed["columns"].map(String),
    rows: (parsed["rows"] as unknown[]).filter(Array.isArray) as unknown[][],
    truncated: parsed["truncated"] === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
