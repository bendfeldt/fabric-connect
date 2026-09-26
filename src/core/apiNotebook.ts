/**
 * API notebooks (`.fabnb`): cells that call the Fabric REST API, in the
 * style of Fabric Studio's API notebooks.
 *
 *     %api
 *     GET /workspaces
 *
 *     %cmd
 *     SET API_PATH = /workspaces/$(_cells[-1].value[0].id)
 *
 *     GET ./items
 *
 * - `%api` (or no magic) runs `METHOD path` with an optional JSON body on
 *   the following lines. Paths are absolute Fabric API URLs, relative to
 *   the API root (`/…`), or relative to the `API_PATH` variable (`./…`).
 * - `%cmd` sets (`SET NAME = value` or `NAME = value`) and shows
 *   (`SET NAME`) notebook variables; names are case-insensitive.
 * - `$(name)` substitutes a variable; `$(_cells[-1]…)` reads a previous
 *   cell's JSON output with a path like `[2].id` or `.value[0].name`.
 *
 * Requests go through the shared API client, so the local-first write
 * policy applies: reads work, and writes that are not on the allowlist are
 * refused before anything is sent.
 */

import { FABRIC_API_BASE_URL } from "./constants";
import type { DisplayTable } from "./displayProtocol";
import { ApiNotebookError } from "./errors";
import type { FabricRequestOptions } from "./types";

export type ApiCell =
  | {
      readonly type: "api";
      readonly method: FabricRequestOptions["method"];
      readonly path: string;
      readonly body?: unknown;
    }
  | {
      readonly type: "cmd";
      readonly sets: ReadonlyArray<{ name: string; value: string }>;
      readonly gets: readonly string[];
    };

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const PATH_ALIASES = ["API_PATH", "ROOT_PATH", "API_ROOT_PATH"];

/** Notebook state carried from cell to cell. */
export class ApiNotebookState {
  private readonly variables = new Map<string, string>();
  /** Outputs by cell index (JSON values), for `_cells[...]`. */
  private readonly outputs = new Map<number, unknown>();

  set(name: string, value: string): void {
    this.variables.set(name.toUpperCase(), value);
  }

  get(name: string): string | undefined {
    return this.variables.get(name.toUpperCase());
  }

  recordOutput(cellIndex: number, value: unknown): void {
    this.outputs.set(cellIndex, value);
  }

  output(cellIndex: number): unknown {
    return this.outputs.get(cellIndex);
  }

  apiPath(): string | undefined {
    for (const alias of PATH_ALIASES) {
      const value = this.get(alias);
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  }
}

/** Replaces `$(…)` references using the state; `cellIndex` anchors `_cells[-n]`. */
export function substitute(
  text: string,
  state: ApiNotebookState,
  cellIndex: number,
): string {
  return text.replace(/\$\(([^()]+)\)/g, (_whole, expr: string) => {
    const trimmed = expr.trim();
    const cells = /^_cells\[(-?\d+)\](.*)$/i.exec(trimmed);
    if (cells !== null) {
      const offset = Number(cells[1]);
      const target = offset < 0 ? cellIndex + offset : offset;
      const value = selectPath(state.output(target), cells[2], trimmed);
      return typeof value === "string" ? value : JSON.stringify(value);
    }
    const value = state.get(trimmed);
    if (value === undefined) {
      throw new ApiNotebookError(`Unknown variable '${trimmed}'.`, {
        operation: "run API cell",
        entity: `variable ${trimmed}`,
        remediation: `Set it first in a %cmd cell: SET ${trimmed} = value.`,
      });
    }
    return value;
  });
}

/** Follows a path like `[2].id` or `.value[0].name` into a JSON value. */
export function selectPath(
  root: unknown,
  pathText: string,
  expr: string,
): unknown {
  let current = root;
  const pattern = /\.([A-Za-z_$][\w$]*)|\[(-?\d+)\]|\[["']([^"']+)["']\]/gy;
  let consumed = 0;
  for (const match of pathText.matchAll(pattern)) {
    consumed += match[0].length;
    const key = match[1] ?? match[3];
    if (key !== undefined) {
      current =
        typeof current === "object" && current !== null
          ? (current as Record<string, unknown>)[key]
          : undefined;
    } else {
      const index = Number(match[2]);
      current = Array.isArray(current)
        ? current[index < 0 ? current.length + index : index]
        : undefined;
    }
  }
  if (consumed !== pathText.length) {
    throw new ApiNotebookError(
      `Cannot read '${expr}': the path is not understood.`,
      {
        operation: "run API cell",
        entity: `reference ${expr}`,
        remediation:
          "Use a path like $(_cells[-1].value[0].id) or $(_cells[-1][2].name).",
      },
    );
  }
  if (current === undefined) {
    throw new ApiNotebookError(
      `Cannot read '${expr}': there is no value at that path.`,
      {
        operation: "run API cell",
        entity: `reference ${expr}`,
        remediation:
          "Run the referenced cell first, and check the path against its output.",
      },
    );
  }
  return current;
}

/** Parses a cell (after substitution) into an API call or a %cmd block. */
export function parseApiCell(text: string): ApiCell {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let first = 0;
  while (first < lines.length && lines[first].trim().length === 0) {
    first++;
  }
  const magic = lines[first]?.trim().toLowerCase();
  if (magic === "%cmd") {
    return parseCmd(lines.slice(first + 1));
  }
  const rest = magic?.startsWith("%api")
    ? lines.slice(first + 1)
    : lines.slice(first);
  const requestLine = rest.findIndex(
    (line) => line.trim().length > 0 && !line.trim().startsWith("#"),
  );
  if (requestLine === -1) {
    throw bad(
      "the cell has no request line",
      "Write a request like: GET /workspaces",
    );
  }
  const match = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(rest[requestLine]);
  if (match === null || !METHODS.has(match[1].toUpperCase())) {
    throw bad(
      `'${rest[requestLine].trim()}' is not a request line`,
      "Write METHOD path, e.g. GET /workspaces (methods: GET, POST, PUT, PATCH, DELETE).",
    );
  }
  const bodyText = rest
    .slice(requestLine + 1)
    .join("\n")
    .trim();
  let body: unknown;
  if (bodyText.length > 0) {
    try {
      body = JSON.parse(bodyText);
    } catch (cause) {
      throw bad(
        "the request body is not valid JSON",
        "Fix the JSON below the request line.",
        cause,
      );
    }
  }
  return {
    type: "api",
    method: match[1].toUpperCase() as FabricRequestOptions["method"],
    path: match[2],
    ...(body === undefined ? {} : { body }),
  };
}

/**
 * Resolves a cell path to one relative to the Fabric API base. Absolute
 * URLs must point at the Fabric API; other hosts are refused (no token is
 * ever sent elsewhere).
 */
export function resolveApiPath(
  rawPath: string,
  state: ApiNotebookState,
): string {
  if (/^https?:\/\//i.test(rawPath)) {
    if (
      !rawPath.toLowerCase().startsWith(FABRIC_API_BASE_URL.toLowerCase() + "/")
    ) {
      throw bad(
        `'${rawPath}' is not a Fabric REST API URL`,
        `Use a path relative to ${FABRIC_API_BASE_URL}, e.g. /workspaces.`,
      );
    }
    return rawPath.slice(FABRIC_API_BASE_URL.length);
  }
  if (rawPath.startsWith("./")) {
    const base = state.apiPath();
    if (base === undefined) {
      throw bad(
        `'${rawPath}' is relative to API_PATH, which is not set`,
        "Set it in a %cmd cell first: SET API_PATH = /workspaces/<id>.",
      );
    }
    return `${base.replace(/\/+$/, "")}/${rawPath.slice(2)}`;
  }
  if (rawPath.startsWith("/")) {
    return rawPath;
  }
  return `/${rawPath}`;
}

/**
 * A table for list responses (`{ value: [ {…} ] }` or a bare array of
 * objects); undefined for anything else.
 */
export function responseTable(value: unknown): DisplayTable | undefined {
  const list = Array.isArray(value)
    ? value
    : typeof value === "object" &&
        value !== null &&
        Array.isArray((value as { value?: unknown }).value)
      ? (value as { value: unknown[] }).value
      : undefined;
  if (list === undefined || list.length === 0) {
    return undefined;
  }
  const records = list.filter(
    (r): r is Record<string, unknown> =>
      typeof r === "object" && r !== null && !Array.isArray(r),
  );
  if (records.length !== list.length) {
    return undefined;
  }
  const columns: string[] = [];
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!columns.includes(key)) {
        columns.push(key);
      }
    }
  }
  return {
    columns,
    rows: records.map((r) => columns.map((c) => r[c] ?? null)),
    truncated: false,
  };
}

function parseCmd(lines: string[]): ApiCell {
  const sets: Array<{ name: string; value: string }> = [];
  const gets: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const assignment = /^(?:SET\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)$/i.exec(line);
    if (assignment !== null) {
      sets.push({
        name: assignment[1].toUpperCase(),
        value: assignment[2].trim(),
      });
      continue;
    }
    const show = /^SET\s+([A-Za-z_][\w]*)$/i.exec(line);
    if (show !== null) {
      gets.push(show[1].toUpperCase());
      continue;
    }
    throw bad(
      `'${line}' is not a %cmd statement`,
      "Use SET NAME = value to set a variable, or SET NAME to show it.",
    );
  }
  return { type: "cmd", sets, gets };
}

function bad(
  why: string,
  remediation: string,
  cause?: unknown,
): ApiNotebookError {
  return new ApiNotebookError(`Cannot run the API cell: ${why}.`, {
    operation: "run API cell",
    remediation,
    cause,
  });
}
