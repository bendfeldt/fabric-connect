/**
 * Local `%run`: `%run OtherNotebook { "p": 1 }` is resolved against the
 * notebooks in this working tree (via the local item index) and inlined
 * into the statement sent to Livy — never against a copy deployed in a
 * workspace. Parameters are assigned right after the referenced notebook's
 * parameters cell, the way Fabric applies them.
 *
 * Only Python code cells can be inlined into a Python statement; any other
 * language is refused with the cell named, rather than silently dropped.
 */

import * as path from "node:path";
import { NotebookFidelityError } from "./errors";
import type { LocalItemIndex } from "./localItemIndex";
import { parseNotebook } from "./notebookCodec";
import { parseNotebookSource } from "./notebookSourceCodec";

/** Where the notebook content lives inside an item folder, in lookup order. */
const CONTENT_FILES = [
  "notebook-content.ipynb",
  "notebook-content.py",
  "notebook-content.scala",
  "notebook-content.sql",
  "notebook-content.r",
];

const MAX_DEPTH = 10;
const RUN_LINE = /^[ \t]*%run[ \t]+(.*)$/;

export interface RunExpansionFileSystem {
  readFile(filePath: string): Promise<string | undefined>;
}

export class RunExpansionError extends NotebookFidelityError {}

interface CodeCell {
  readonly index: number;
  readonly language: string;
  readonly source: string;
  readonly isParameters: boolean;
}

/** True when the code contains at least one `%run` line. */
export function hasRunMagic(code: string): boolean {
  return code.split("\n").some((line) => RUN_LINE.test(line));
}

/**
 * Returns `code` with every `%run` line replaced by the referenced
 * notebook's Python cells (recursively). Code without `%run` is returned
 * unchanged.
 */
export async function expandRunMagics(
  code: string,
  index: LocalItemIndex,
  fs: RunExpansionFileSystem,
): Promise<string> {
  return expand(code, index, fs, []);
}

async function expand(
  code: string,
  index: LocalItemIndex,
  fs: RunExpansionFileSystem,
  stack: string[],
): Promise<string> {
  if (!hasRunMagic(code)) {
    return code;
  }
  const out: string[] = [];
  for (const line of code.split("\n")) {
    const match = RUN_LINE.exec(line);
    if (match === null) {
      out.push(line);
      continue;
    }
    const { name, params } = parseRunArguments(match[1], line);
    if (stack.map((s) => s.toLowerCase()).includes(name.toLowerCase())) {
      throw new RunExpansionError(
        `Cannot expand '%run ${name}': it runs itself through ${[...stack, name].join(" → ")}.`,
        {
          operation: "expand %run",
          entity: `notebook ${name}`,
          remediation: "Remove the circular %run.",
        },
      );
    }
    if (stack.length >= MAX_DEPTH) {
      throw new RunExpansionError(
        `Cannot expand '%run ${name}': %run is nested more than ${MAX_DEPTH} levels deep.`,
        {
          operation: "expand %run",
          entity: `notebook ${name}`,
          remediation: "Flatten the %run chain.",
        },
      );
    }
    const cells = await loadCodeCells(name, index, fs);
    const parts = [`# --- %run ${name} (local) ---`];
    for (const cell of cells) {
      const python = asPython(cell, name);
      parts.push(await expand(python, index, fs, [...stack, name]));
      if (cell.isParameters && params !== undefined) {
        parts.push(parameterAssignments(params));
      }
    }
    if (params !== undefined && !cells.some((c) => c.isParameters)) {
      // No parameters cell: Fabric injects the values before the first cell.
      parts.splice(1, 0, parameterAssignments(params));
    }
    parts.push(`# --- end %run ${name} ---`);
    out.push(parts.join("\n"));
  }
  return out.join("\n");
}

function parseRunArguments(
  args: string,
  line: string,
): { name: string; params?: Record<string, unknown> } {
  const trimmed = args.trim();
  const brace = trimmed.indexOf("{");
  const rawName = (brace === -1 ? trimmed : trimmed.slice(0, brace)).trim();
  const name = path.posix.basename(rawName.replace(/^["']|["']$/g, ""));
  if (name.length === 0) {
    throw new RunExpansionError(
      `Cannot expand '${line.trim()}': no notebook name was given.`,
      {
        operation: "expand %run",
        remediation:
          "Write it as %run NotebookName, optionally followed by a JSON object of parameters.",
      },
    );
  }
  if (brace === -1) {
    return { name };
  }
  let params: unknown;
  try {
    params = JSON.parse(trimmed.slice(brace));
  } catch (cause) {
    throw new RunExpansionError(
      `Cannot expand '%run ${name}': its parameters are not valid JSON.`,
      {
        operation: "expand %run",
        entity: `notebook ${name}`,
        remediation:
          'Pass parameters as a JSON object, e.g. %run Loader {"date": "2026-01-01"}.',
        cause,
      },
    );
  }
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new RunExpansionError(
      `Cannot expand '%run ${name}': its parameters must be a JSON object.`,
      {
        operation: "expand %run",
        entity: `notebook ${name}`,
        remediation:
          'Pass parameters as a JSON object, e.g. %run Loader {"date": "2026-01-01"}.',
      },
    );
  }
  return { name, params: params as Record<string, unknown> };
}

async function loadCodeCells(
  name: string,
  index: LocalItemIndex,
  fs: RunExpansionFileSystem,
): Promise<CodeCell[]> {
  const matches = index.findByName("Notebook", name);
  if (matches.length === 0) {
    throw new RunExpansionError(
      `Cannot expand '%run ${name}': no notebook with that name exists in this repo.`,
      {
        operation: "expand %run",
        entity: `notebook ${name}`,
        remediation:
          "Check the name against the displayName in the notebook's .platform file, or pull the notebook into the repo first.",
      },
    );
  }
  if (matches.length > 1) {
    throw new RunExpansionError(
      `Cannot expand '%run ${name}': ${matches.length} notebooks in this repo have that name.`,
      {
        operation: "expand %run",
        entity: `notebook ${name}`,
        remediation: `Rename one of: ${matches.map((m) => m.folder).join(", ")}.`,
      },
    );
  }
  const folder = matches[0].folder;
  for (const file of CONTENT_FILES) {
    const text = await fs.readFile(path.join(folder, file));
    if (text === undefined) {
      continue;
    }
    if (file.endsWith(".ipynb")) {
      return parseNotebook(text, file).cells.flatMap((cell, i) =>
        cell.cellType === "code"
          ? [
              {
                index: i,
                language: cell.language ?? "python",
                source: cell.source,
                isParameters: hasParametersTag(cell.raw),
              },
            ]
          : [],
      );
    }
    return parseNotebookSource(text, file).cells.flatMap((cell, i) =>
      cell.kind === "markdown"
        ? []
        : [
            {
              index: i,
              language: cell.language,
              source: cell.source,
              isParameters: cell.kind === "parameters",
            },
          ],
    );
  }
  throw new RunExpansionError(
    `Cannot expand '%run ${name}': its folder has no notebook-content file.`,
    {
      operation: "expand %run",
      entity: `notebook ${name}`,
      remediation: `Expected one of ${CONTENT_FILES.join(", ")} in ${folder}.`,
    },
  );
}

/** Python source for an inlined cell, or a named error for other languages. */
function asPython(cell: CodeCell, notebook: string): string {
  const firstLine = cell.source.split("\n", 1)[0].trim();
  if (firstLine === "%%pyspark" || firstLine === "%%python") {
    return cell.source.slice(cell.source.indexOf("\n") + 1);
  }
  if (cell.language === "python" && !firstLine.startsWith("%%")) {
    return cell.source;
  }
  const language = firstLine.startsWith("%%") ? firstLine : cell.language;
  throw new RunExpansionError(
    `Cannot expand '%run ${notebook}': cell ${cell.index} is ${language}, and only Python cells can be inlined into a Python statement.`,
    {
      operation: "expand %run",
      entity: `notebook ${notebook}, cell ${cell.index}`,
      remediation:
        "Move that logic into a Python cell (e.g. spark.sql(...)), or run the referenced notebook's cells directly.",
    },
  );
}

function hasParametersTag(raw: Record<string, unknown>): boolean {
  const metadata = raw["metadata"];
  if (typeof metadata !== "object" || metadata === null) {
    return false;
  }
  const tags = (metadata as Record<string, unknown>)["tags"];
  return Array.isArray(tags) && tags.includes("parameters");
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parameterAssignments(params: Record<string, unknown>): string {
  return Object.entries(params)
    .map(([key, value]) => {
      if (!IDENTIFIER.test(key)) {
        throw new RunExpansionError(
          `Cannot pass %run parameter '${key}': it is not a valid Python name.`,
          {
            operation: "expand %run",
            remediation:
              "Use parameter names made of letters, digits and underscores.",
          },
        );
      }
      return `${key} = ${toPythonLiteral(value)}`;
    })
    .join("\n");
}

/** JSON value → equivalent Python literal. */
export function toPythonLiteral(value: unknown): string {
  if (value === null) {
    return "None";
  }
  if (value === true) {
    return "True";
  }
  if (value === false) {
    return "False";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "None";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(toPythonLiteral).join(", ")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${JSON.stringify(k)}: ${toPythonLiteral(v)}`)
      .join(", ")}}`;
  }
  return "None";
}
