/**
 * Notebook Fidelity Module, source format: the `notebook-content.py`
 * (or `.scala` / `.sql` / `.r`) files Fabric's git integration writes by
 * default, e.g.
 *
 *     # Fabric notebook source
 *
 *     # METADATA ********************
 *
 *     # META { ...notebook metadata as commented JSON... }
 *
 *     # CELL ********************
 *
 *     print("hi")
 *
 *     # METADATA ********************
 *
 *     # META { "language": "python", "language_group": "synapse_pyspark" }
 *
 * Code cells in another language than the file carry `# MAGIC ` prefixes;
 * markdown cells are commented with `# `.
 *
 * The same fidelity rules as the .ipynb codec hold, as tested properties:
 *  - an unmodified notebook serializes byte-for-byte;
 *  - unknown metadata (notebook- or cell-level) survives round-trips;
 *  - an edit to one cell rewrites only that cell's block, so git diffs stay
 *    as small as the change.
 *
 * `root` is `{ metadata: <notebook META object> }`, the same shape the
 * .ipynb root has, so the Lakehouse/Environment helpers work on both.
 */

import { NotebookFidelityError } from "./errors";

export type SourceCellKind = "code" | "markdown" | "parameters";

export interface SourceCellRaw {
  readonly kind: SourceCellKind;
  /** Cell-level META object, or undefined when the cell had none. */
  readonly meta?: Record<string, unknown>;
  /** The cell's source as parsed; compared to detect edits. */
  readonly source: string;
  /** The cell's exact original text (marker to next cell marker). */
  readonly blockText: string;
}

export interface ParsedSourceCell {
  readonly kind: SourceCellKind;
  readonly language: string;
  readonly source: string;
  readonly raw: SourceCellRaw;
}

export interface ParsedSourceNotebook {
  readonly fileName: string;
  /** Comment prefix of this file: `#`, `--` or `//`. */
  readonly prefix: string;
  /** The notebook's main language: cells in it carry no `MAGIC` prefix. */
  readonly fileLanguage: string;
  readonly root: Record<string, unknown>;
  readonly originalText: string;
  readonly cells: ParsedSourceCell[];
}

export interface SourceSerializeCell {
  readonly kind: SourceCellKind;
  readonly language: string;
  readonly source: string;
  /** Present for cells that came from the file; absent for new cells. */
  readonly raw?: SourceCellRaw;
}

export interface SourceSerializeInput {
  readonly fileName: string;
  readonly prefix: string;
  readonly root: Record<string, unknown>;
  readonly originalText: string;
  readonly cells: readonly SourceSerializeCell[];
}

const HEADER = "Fabric notebook source";
const MARKER_STARS = "********************";

/** Fabric META "language" ↔ VS Code language ID. */
const META_TO_LANGUAGE: Record<string, string> = {
  python: "python",
  sparksql: "sql",
  scala: "scala",
  r: "r",
};
const LANGUAGE_TO_META: Record<string, string> = {
  python: "python",
  sql: "sparksql",
  scala: "scala",
  r: "r",
};
/** Cell magic for a cell whose language differs from the file's. */
const LANGUAGE_TO_MAGIC: Record<string, string> = {
  python: "%%pyspark",
  sql: "%%sql",
  scala: "%%spark",
  r: "%%sparkr",
};

/** True when the text starts like a Fabric notebook source file. */
export function isNotebookSource(text: string): boolean {
  return detectPrefix(text) !== undefined;
}

export function parseNotebookSource(
  text: string,
  fileName: string,
): ParsedSourceNotebook {
  const prefix = detectPrefix(text);
  if (prefix === undefined) {
    throw fail(
      fileName,
      "parse",
      `the first line is not '# ${HEADER}' (or its '--' / '//' form)`,
      "Restore the file from git, or re-sync it from the Fabric workspace.",
    );
  }
  const markers = findMarkers(text, prefix);
  const fileLanguage =
    languageFromFileName(fileName) ??
    inferFileLanguage(text, markers, prefix) ??
    languageOfPrefix(prefix);

  // Notebook-level METADATA: the METADATA block before the first cell.
  let root: Record<string, unknown> = { metadata: {} };
  const firstCell = markers.findIndex((m) => m.kind !== "metadata");
  const headerMarkers =
    firstCell === -1 ? markers : markers.slice(0, firstCell);
  if (headerMarkers.length > 1) {
    throw fail(
      fileName,
      "parse",
      "more than one notebook-level METADATA block before the first cell",
      "Remove the duplicate METADATA block, or re-sync the file from Fabric.",
    );
  }
  if (headerMarkers.length === 1) {
    const end = firstCell === -1 ? text.length : markers[firstCell].start;
    root = {
      metadata: parseMeta(
        text.slice(headerMarkers[0].end, end),
        prefix,
        fileName,
        "notebook metadata",
      ),
    };
  }

  const cells: ParsedSourceCell[] = [];
  if (firstCell !== -1) {
    const cellMarkers = markers.slice(firstCell);
    for (let i = 0; i < cellMarkers.length; i++) {
      const marker = cellMarkers[i];
      if (marker.kind === "metadata") {
        continue; // consumed by the preceding cell
      }
      const next = cellMarkers[i + 1];
      const hasMeta = next?.kind === "metadata";
      const bodyEnd = next === undefined ? text.length : next.start;
      const nextCell = cellMarkers
        .slice(i + 1)
        .find((m) => m.kind !== "metadata");
      const blockEnd = nextCell === undefined ? text.length : nextCell.start;
      if (
        hasMeta &&
        cellMarkers[i + 2] !== undefined &&
        cellMarkers[i + 2].kind === "metadata"
      ) {
        throw fail(
          fileName,
          "parse",
          `cell ${cells.length} has more than one METADATA block`,
          "Remove the duplicate METADATA block, or re-sync the file from Fabric.",
        );
      }
      const meta = hasMeta
        ? parseMeta(
            text.slice(next.end, nextCell?.start ?? text.length),
            prefix,
            fileName,
            `cell ${cells.length} metadata`,
          )
        : undefined;
      const body = trimBody(text.slice(marker.end, bodyEnd));
      const kind = marker.kind;
      const language =
        kind === "markdown"
          ? "markdown"
          : (META_TO_LANGUAGE[String(meta?.["language"])] ?? fileLanguage);
      const source =
        kind === "markdown"
          ? uncomment(body, prefix)
          : language === fileLanguage
            ? body
            : unmagic(body, prefix);
      cells.push({
        kind,
        language,
        source,
        raw: {
          kind,
          ...(meta === undefined ? {} : { meta }),
          source,
          blockText: text.slice(marker.start, blockEnd),
        },
      });
    }
  }

  return { fileName, prefix, fileLanguage, root, originalText: text, cells };
}

export function serializeNotebookSource(input: SourceSerializeInput): string {
  const { prefix, originalText } = input;
  try {
    const markers = findMarkers(originalText, prefix);
    const firstCell = markers.findIndex((m) => m.kind !== "metadata");
    const cellsStart =
      firstCell === -1 ? originalText.length : markers[firstCell].start;
    const original = parseNotebookSource(originalText, input.fileName);

    // Rendered text follows the file's own line endings.
    const eol = originalText.includes("\r\n") ? "\r\n" : "\n";
    const withEol = (text: string): string =>
      eol === "\n" ? text : text.replace(/\r?\n/g, eol);
    const header = deepEqual(input.root, original.root)
      ? originalText.slice(0, cellsStart)
      : withEol(renderHeader(input.root, prefix));
    const fileLanguage = original.fileLanguage;
    const blocks = input.cells.map((cell) =>
      cell.raw !== undefined && cellUnchanged(cell, cell.raw)
        ? { text: cell.raw.blockText, rendered: false }
        : {
            text: withEol(renderCell(cell, prefix, fileLanguage)),
            rendered: true,
          },
    );

    let out = ensureBlankLineAfter(header, blocks.length > 0, eol);
    for (let i = 0; i < blocks.length; i++) {
      const isLast = i === blocks.length - 1;
      const text = blocks[i].text;
      out += isLast ? text : ensureBlankLineAfter(text, true, eol);
    }
    const last = blocks[blocks.length - 1];
    if ((blocks.length === 0 && header !== originalText) || last?.rendered) {
      out = out.replace(/(\r?\n)*$/, eol);
    }
    return out;
  } catch (cause) {
    if (cause instanceof NotebookFidelityError) {
      throw cause;
    }
    throw new NotebookFidelityError(
      `Failed to write notebook '${input.fileName}': serialization failed.`,
      {
        operation: "serialize notebook",
        entity: `file ${input.fileName}`,
        remediation:
          "Undo the last change, or restore the file from git, then retry saving.",
        cause,
      },
    );
  }
}

/** Raw data for a cell created in the editor (no file counterpart yet). */
export function newSourceCell(
  kind: SourceCellKind,
  language: string,
  source: string,
): SourceSerializeCell {
  return { kind, language, source };
}

// --- internals ---------------------------------------------------------------

type MarkerKind = "metadata" | SourceCellKind;

interface Marker {
  readonly kind: MarkerKind;
  /** Offset of the marker line's first character. */
  readonly start: number;
  /** Offset just past the marker line's newline. */
  readonly end: number;
}

function detectPrefix(text: string): string | undefined {
  const firstLine = text.split("\n", 1)[0].replace(/\r$/, "");
  for (const prefix of ["#", "--", "//"]) {
    if (firstLine === `${prefix} ${HEADER}`) {
      return prefix;
    }
  }
  return undefined;
}

function languageOfPrefix(prefix: string): string {
  return prefix === "--" ? "sql" : prefix === "//" ? "scala" : "python";
}

function languageFromFileName(fileName: string): string | undefined {
  const match = /\.([A-Za-z]+)$/.exec(fileName);
  switch (match?.[1].toLowerCase()) {
    case "py":
      return "python";
    case "sql":
      return "sql";
    case "scala":
      return "scala";
    case "r":
      return "r";
    default:
      return undefined;
  }
}

/**
 * Without a file extension (VS Code's serializer never sees the file name),
 * the main language is the META language of the first code cell whose body
 * is not `MAGIC`-prefixed.
 */
function inferFileLanguage(
  text: string,
  markers: readonly Marker[],
  prefix: string,
): string | undefined {
  for (let i = 0; i < markers.length - 1; i++) {
    const marker = markers[i];
    const next = markers[i + 1];
    if (
      (marker.kind !== "code" && marker.kind !== "parameters") ||
      next.kind !== "metadata"
    ) {
      continue;
    }
    const body = trimBody(text.slice(marker.end, next.start));
    if (body.length === 0 || body.startsWith(`${prefix} MAGIC`)) {
      continue;
    }
    const after = markers[i + 2];
    const metaText = text.slice(next.end, after?.start ?? text.length);
    const language = /"language"\s*:\s*"([A-Za-z]+)"/.exec(metaText)?.[1];
    const mapped =
      language === undefined ? undefined : META_TO_LANGUAGE[language];
    if (mapped !== undefined) {
      return mapped;
    }
  }
  return undefined;
}

function findMarkers(text: string, prefix: string): Marker[] {
  const markers: Marker[] = [];
  const escaped = prefix.replace(/[/-]/g, "\\$&");
  const pattern = new RegExp(
    `^${escaped} (METADATA|CELL|MARKDOWN|PARAMETERS CELL) \\*{20}\\r?$`,
    "gm",
  );
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline + 1;
    const word = match[1];
    markers.push({
      kind:
        word === "METADATA"
          ? "metadata"
          : word === "CELL"
            ? "code"
            : word === "MARKDOWN"
              ? "markdown"
              : "parameters",
      start,
      end,
    });
  }
  return markers;
}

function parseMeta(
  segment: string,
  prefix: string,
  fileName: string,
  what: string,
): Record<string, unknown> {
  const metaPrefix = `${prefix} META`;
  const json = segment
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.startsWith(metaPrefix))
    .map((line) => line.slice(metaPrefix.length).replace(/^ /, ""))
    .join("\n");
  if (json.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw fail(
      fileName,
      "parse",
      `the ${what} is not valid JSON`,
      "Fix the '# META' lines, or re-sync the file from Fabric.",
      cause,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw fail(
      fileName,
      "parse",
      `the ${what} is not a JSON object`,
      "Fix the '# META' lines, or re-sync the file from Fabric.",
    );
  }
  return parsed as Record<string, unknown>;
}

/** Drops the blank line after the marker and the blank lines at the end. */
function trimBody(segment: string): string {
  return segment.replace(/\r\n/g, "\n").replace(/^\n/, "").replace(/\n+$/, "");
}

function uncomment(body: string, prefix: string): string {
  return body
    .split("\n")
    .map((line) =>
      line === prefix
        ? ""
        : line.startsWith(`${prefix} `)
          ? line.slice(prefix.length + 1)
          : line,
    )
    .join("\n");
}

function unmagic(body: string, prefix: string): string {
  const magic = `${prefix} MAGIC`;
  return body
    .split("\n")
    .map((line) =>
      line === magic
        ? ""
        : line.startsWith(`${magic} `)
          ? line.slice(magic.length + 1)
          : line,
    )
    .join("\n");
}

function renderHeader(root: Record<string, unknown>, prefix: string): string {
  const metadata = root["metadata"];
  let out = `${prefix} ${HEADER}\n`;
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    Object.keys(metadata).length > 0
  ) {
    out += `\n${prefix} METADATA ${MARKER_STARS}\n\n${renderMeta(metadata as Record<string, unknown>, prefix)}`;
  }
  return out;
}

function renderMeta(meta: Record<string, unknown>, prefix: string): string {
  return (
    JSON.stringify(meta, undefined, 2)
      .split("\n")
      .map((line) => `${prefix} META ${line}`)
      .join("\n") + "\n"
  );
}

function renderCell(
  cell: SourceSerializeCell,
  prefix: string,
  fileLanguage: string,
): string {
  const word =
    cell.kind === "markdown"
      ? "MARKDOWN"
      : cell.kind === "parameters"
        ? "PARAMETERS CELL"
        : "CELL";
  let body: string;
  if (cell.kind === "markdown") {
    body = cell.source
      .split("\n")
      .map((line) => (line.length === 0 ? prefix : `${prefix} ${line}`))
      .join("\n");
  } else if (cell.language === fileLanguage) {
    body = cell.source;
  } else {
    const magic = LANGUAGE_TO_MAGIC[cell.language];
    const lines = cell.source.split("\n");
    const withMagic =
      magic !== undefined && !lines[0].trim().startsWith("%%")
        ? [magic, ...lines]
        : lines;
    body = withMagic
      .map((line) =>
        line.length === 0 ? `${prefix} MAGIC` : `${prefix} MAGIC ${line}`,
      )
      .join("\n");
  }
  let out = `${prefix} ${word} ${MARKER_STARS}\n\n${body}\n`;
  if (cell.kind !== "markdown") {
    const meta: Record<string, unknown> = { ...(cell.raw?.meta ?? {}) };
    const metaLanguage = LANGUAGE_TO_META[cell.language];
    if (metaLanguage !== undefined) {
      meta["language"] = metaLanguage;
    }
    if (meta["language_group"] === undefined) {
      meta["language_group"] = "synapse_pyspark";
    }
    out += `\n${prefix} METADATA ${MARKER_STARS}\n\n${renderMeta(meta, prefix)}`;
  } else if (cell.raw?.meta !== undefined) {
    out += `\n${prefix} METADATA ${MARKER_STARS}\n\n${renderMeta(cell.raw.meta, prefix)}`;
  }
  return out;
}

function cellUnchanged(cell: SourceSerializeCell, raw: SourceCellRaw): boolean {
  if (cell.kind !== raw.kind || cell.source !== raw.source) {
    return false;
  }
  if (cell.kind === "markdown") {
    return true;
  }
  const metaLanguage = raw.meta?.["language"];
  const expected =
    typeof metaLanguage === "string"
      ? META_TO_LANGUAGE[metaLanguage]
      : undefined;
  return expected === undefined || expected === cell.language;
}

function ensureBlankLineAfter(
  text: string,
  needed: boolean,
  eol: string,
): string {
  if (!needed || text.length === 0 || /\r?\n\r?\n$/.test(text)) {
    return text;
  }
  return /\r?\n$/.test(text) ? `${text}${eol}` : `${text}${eol}${eol}`;
}

function fail(
  fileName: string,
  op: "parse" | "serialize",
  why: string,
  remediation: string,
  cause?: unknown,
): NotebookFidelityError {
  return new NotebookFidelityError(
    `Failed to ${op === "parse" ? "read" : "write"} notebook '${fileName}': ${why}.`,
    {
      operation: `${op} notebook`,
      entity: `file ${fileName}`,
      remediation,
      cause,
    },
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (
    typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    const keys = Object.keys(ra);
    return (
      keys.length === Object.keys(rb).length &&
      keys.every((k) => Object.hasOwn(rb, k) && deepEqual(ra[k], rb[k]))
    );
  }
  return false;
}
