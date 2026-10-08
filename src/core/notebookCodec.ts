/**
 * Notebook Fidelity Module: reads/writes the Fabric notebook (.ipynb) file
 * format 1:1 with the portal.
 *
 * Fidelity rules that make "100% compatible" a property, not a goal:
 *  - Unknown fields anywhere in the document survive parse → serialize
 *    unchanged. Parsing keeps every cell's raw JSON object and the root
 *    object; serialization mutates only the specific paths this extension
 *    understands.
 *  - A parse → serialize round-trip of an unmodified notebook returns the
 *    original text byte-for-byte.
 *
 * The module is a set of pure functions over plain JSON records — no
 * document state lives here. The vscode serializer stores `root` (with a
 * `cells: []` placeholder) and the original text in the notebook document's
 * own metadata, and each cell's raw object in that cell's metadata, so the
 * fidelity payload travels with the document through open/revert/save and
 * can never be associated with the wrong file.
 */

import { NotebookFidelityError } from "./errors";

export interface LakehouseAttachment {
  readonly id: string;
  readonly name?: string;
  readonly workspaceId?: string;
}

export interface ParsedCell {
  readonly cellType: string;
  readonly language: string | undefined;
  readonly source: string;
  /** The cell's full raw JSON object; unknown fields live here untouched. */
  readonly raw: Record<string, unknown>;
}

export interface ParsedNotebook {
  readonly fileName: string;
  /** Root object with `cells` replaced by an empty placeholder array, so
   *  the `cells` key keeps its position for re-serialization. */
  readonly root: Record<string, unknown>;
  readonly originalText: string;
  readonly cells: ParsedCell[];
}

export interface SerializeCell {
  readonly source: string;
  readonly raw: Record<string, unknown>;
}

export interface SerializeInput {
  readonly fileName: string;
  readonly root: Record<string, unknown>;
  readonly originalText: string;
  readonly cells: readonly SerializeCell[];
}

/** Jupyter serializes with 1-space indent; the Fabric portal matches it. */
const IPYNB_INDENT = 1;

export function parseNotebook(text: string, fileName: string): ParsedNotebook {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (cause) {
    throw new NotebookFidelityError(
      `Failed to read notebook '${fileName}': the file is not valid JSON (corrupt or not an .ipynb file).`,
      {
        operation: "parse notebook",
        entity: `file ${fileName}`,
        remediation:
          "Restore the file from git or re-export it from the Fabric portal.",
        cause,
      },
    );
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new NotebookFidelityError(
      `Failed to read notebook '${fileName}': the top-level value is not an object.`,
      {
        operation: "parse notebook",
        entity: `file ${fileName}`,
        remediation: "Re-export the notebook from the Fabric portal.",
      },
    );
  }
  const record = root as Record<string, unknown>;
  const nbformat = record["nbformat"];
  if (nbformat !== undefined && nbformat !== 4) {
    throw new NotebookFidelityError(
      `Failed to read notebook '${fileName}': unsupported notebook schema version (nbformat ${String(nbformat)}); only nbformat 4 is supported.`,
      {
        operation: "parse notebook",
        entity: `file ${fileName}`,
        remediation:
          "Convert the notebook to nbformat 4, or re-export it from the Fabric portal.",
      },
    );
  }
  const rawCells = record["cells"];
  if (!Array.isArray(rawCells)) {
    throw new NotebookFidelityError(
      `Failed to read notebook '${fileName}': the 'cells' section is missing or not a list.`,
      {
        operation: "parse notebook",
        entity: `file ${fileName}, section 'cells'`,
        remediation: "Re-export the notebook from the Fabric portal.",
      },
    );
  }

  const defaultLanguage = readDefaultLanguage(record);
  const cells: ParsedCell[] = rawCells.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new NotebookFidelityError(
        `Failed to read notebook '${fileName}': cell ${index} is not an object.`,
        {
          operation: "parse notebook",
          entity: `file ${fileName}, cell ${index}`,
          remediation: "Re-export the notebook from the Fabric portal.",
        },
      );
    }
    const cell = raw as Record<string, unknown>;
    const cellType = asString(cell["cell_type"]);
    if (cellType === undefined) {
      throw new NotebookFidelityError(
        `Failed to read notebook '${fileName}': cell ${index} has no 'cell_type' field.`,
        {
          operation: "parse notebook",
          entity: `file ${fileName}, cell ${index}`,
          remediation: "Re-export the notebook from the Fabric portal.",
        },
      );
    }
    return {
      cellType,
      language:
        cellType === "markdown"
          ? "markdown"
          : (cellLanguage(cell) ?? defaultLanguage),
      source: joinSource(cell["source"]),
      raw: cell,
    };
  });

  record["cells"] = [];
  return { fileName, root: record, originalText: text, cells };
}

export function serializeNotebook(input: SerializeInput): string {
  try {
    if (notebookUnchanged(input)) {
      // Byte-for-byte fidelity for unmodified notebooks.
      return input.originalText;
    }
    const rebuiltCells = input.cells.map((cell) => {
      const raw = deepClone(cell.raw);
      raw["source"] = splitSource(cell.source);
      return raw;
    });
    const root = deepClone(input.root);
    root["cells"] = rebuiltCells;
    return JSON.stringify(root, undefined, IPYNB_INDENT) + "\n";
  } catch (cause) {
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

/**
 * True when the notebook's content matches the original text: same root
 * (cells aside), same cells with the same raw fields and the same *joined*
 * source. Comparing joined sources (not the string-vs-line-array encoding)
 * keeps untouched notebooks byte-for-byte even when their sources use the
 * non-canonical string form.
 */
function notebookUnchanged(input: SerializeInput): boolean {
  let original: unknown;
  try {
    original = JSON.parse(input.originalText);
  } catch {
    return false;
  }
  if (!isRecord(original)) {
    return false;
  }
  const originalCells = original["cells"];
  if (
    !Array.isArray(originalCells) ||
    originalCells.length !== input.cells.length
  ) {
    return false;
  }
  if (!deepEqual(omitKey(input.root, "cells"), omitKey(original, "cells"))) {
    return false;
  }
  for (let i = 0; i < input.cells.length; i++) {
    const originalCell = originalCells[i];
    if (!isRecord(originalCell)) {
      return false;
    }
    if (
      !deepEqual(
        omitKey(input.cells[i].raw, "source"),
        omitKey(originalCell, "source"),
      )
    ) {
      return false;
    }
    if (input.cells[i].source !== joinSource(originalCell["source"])) {
      return false;
    }
  }
  return true;
}

/**
 * True for an ID that does not name a real item: missing, empty, or the
 * all-zero GUID that Fabric's git integration and deployment tools leave
 * in notebook metadata when a Lakehouse is not bound to the workspace.
 */
export function isUnboundId(id: string | undefined): boolean {
  return id === undefined || id.trim() === "" || NIL_GUID.test(id.trim());
}

const NIL_GUID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;

/** The ID when it names a real item, else undefined (see `isUnboundId`). */
export function boundId(id: string | undefined): string | undefined {
  return isUnboundId(id) ? undefined : id;
}

/**
 * Default + attached lakehouses, from the same metadata Fabric writes.
 * A default whose ID is a placeholder (see `isUnboundId`) is reported as
 * `unboundDefault`, not as a default: it names no Lakehouse Livy can use
 * until one is attached. Placeholder workspace IDs read as unknown and
 * placeholder entries in `known_lakehouses` are skipped.
 */
export function getLakehouseAttachments(root: Record<string, unknown>): {
  defaultLakehouse?: LakehouseAttachment;
  unboundDefault?: { readonly name?: string };
  known: LakehouseAttachment[];
} {
  const dep = lakehouseMetadata(root);
  if (dep === undefined) {
    return { known: [] };
  }
  const defaultId = asString(dep["default_lakehouse"]);
  const defaultName = asString(dep["default_lakehouse_name"]);
  const defaultWorkspace = asString(dep["default_lakehouse_workspace_id"]);
  const defaultLakehouse: LakehouseAttachment | undefined = isUnboundId(
    defaultId,
  )
    ? undefined
    : {
        id: defaultId as string,
        name: defaultName,
        workspaceId: isUnboundId(defaultWorkspace)
          ? undefined
          : defaultWorkspace,
      };
  const unboundDefault =
    defaultId !== undefined && defaultLakehouse === undefined
      ? { ...(defaultName === undefined ? {} : { name: defaultName }) }
      : undefined;
  const knownRaw = dep["known_lakehouses"];
  const known: LakehouseAttachment[] = [];
  if (Array.isArray(knownRaw)) {
    for (const entry of knownRaw) {
      if (isRecord(entry)) {
        const id = asString(entry["id"]);
        if (!isUnboundId(id)) {
          known.push({ id: id as string });
        }
      }
    }
  }
  return {
    ...(defaultLakehouse === undefined ? {} : { defaultLakehouse }),
    ...(unboundDefault === undefined ? {} : { unboundDefault }),
    known,
  };
}

/** What `getLakehouseAttachments` returns. */
export interface LakehouseAttachments {
  readonly defaultLakehouse?: LakehouseAttachment;
  readonly unboundDefault?: { readonly name?: string };
  readonly known: LakehouseAttachment[];
}

/**
 * Treats a default Lakehouse whose ID is a logical ID from git (the
 * `logicalId` of a Lakehouse item in the repo, not a deployed item) as
 * unbound, named from that item; attached Lakehouses with logical IDs are
 * dropped. `logicalLakehouseName` returns the repo item's display name for
 * a logical ID, or undefined for anything else.
 */
export function withLogicalIdsUnbound(
  attachments: LakehouseAttachments,
  logicalLakehouseName: (id: string) => string | undefined,
): LakehouseAttachments {
  const known = attachments.known.filter(
    (k) => logicalLakehouseName(k.id) === undefined,
  );
  const current = attachments.defaultLakehouse;
  const logicalName =
    current === undefined ? undefined : logicalLakehouseName(current.id);
  if (current === undefined || logicalName === undefined) {
    return { ...attachments, known };
  }
  return {
    unboundDefault: { name: current.name ?? logicalName },
    known,
  };
}

/** Environment declared in the notebook's metadata, as Fabric writes it. */
export function getEnvironmentAttachment(
  root: Record<string, unknown>,
): { id: string; workspaceId?: string } | undefined {
  const metadata = root["metadata"];
  if (!isRecord(metadata)) {
    return undefined;
  }
  const dependencies = metadata["dependencies"];
  if (!isRecord(dependencies)) {
    return undefined;
  }
  const environment = dependencies["environment"];
  if (!isRecord(environment)) {
    return undefined;
  }
  const id = asString(environment["environmentId"]);
  if (id === undefined || isUnboundId(id)) {
    return undefined;
  }
  return { id, workspaceId: asString(environment["workspaceId"]) };
}

/**
 * Returns a new root with the lakehouse attached; the input root is never
 * mutated, so callers can pass a document's (frozen) metadata directly and
 * hand the result to a notebook metadata edit.
 */
export function attachLakehouse(
  root: Record<string, unknown>,
  lakehouse: LakehouseAttachment,
  makeDefault: boolean,
): Record<string, unknown> {
  const clone = deepClone(root);
  const metadata = ensureObject(clone, "metadata");
  const dependencies = ensureObject(metadata, "dependencies");
  const dep = ensureObject(dependencies, "lakehouse");
  // Placeholder entries (see `isUnboundId`) are replaced by real ones.
  const known = knownList(dep).filter((k) => !isUnboundId(asString(k["id"])));
  dep["known_lakehouses"] = known;
  if (!known.some((k) => asString(k["id"]) === lakehouse.id)) {
    known.push({ id: lakehouse.id });
  }
  // An unbound (placeholder) default counts as none, so attaching binds it.
  if (makeDefault || isUnboundId(asString(dep["default_lakehouse"]))) {
    dep["default_lakehouse"] = lakehouse.id;
    if (lakehouse.name !== undefined) {
      dep["default_lakehouse_name"] = lakehouse.name;
    }
    if (lakehouse.workspaceId !== undefined) {
      dep["default_lakehouse_workspace_id"] = lakehouse.workspaceId;
    }
  }
  return clone;
}

/** Returns a new root with the lakehouse detached; the input is not mutated. */
export function detachLakehouse(
  root: Record<string, unknown>,
  lakehouseId: string,
): Record<string, unknown> {
  const clone = deepClone(root);
  const dep = lakehouseMetadata(clone);
  if (dep === undefined) {
    return clone;
  }
  dep["known_lakehouses"] = knownList(dep).filter(
    (k) => asString(k["id"]) !== lakehouseId,
  );
  if (dep["default_lakehouse"] === lakehouseId) {
    delete dep["default_lakehouse"];
    delete dep["default_lakehouse_name"];
    delete dep["default_lakehouse_workspace_id"];
  }
  return clone;
}

/** Raw object for a cell created in the editor (no portal counterpart yet). */
export function defaultRawCell(isMarkdown: boolean): Record<string, unknown> {
  return {
    cell_type: isMarkdown ? "markdown" : "code",
    ...(isMarkdown ? {} : { execution_count: null, outputs: [] }),
    metadata: {},
    source: [],
  };
}

function knownList(dep: Record<string, unknown>): Record<string, unknown>[] {
  let known = dep["known_lakehouses"];
  if (!Array.isArray(known)) {
    known = [];
    dep["known_lakehouses"] = known;
  }
  return known as Record<string, unknown>[];
}

function lakehouseMetadata(
  root: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const metadata = root["metadata"];
  if (!isRecord(metadata)) {
    return undefined;
  }
  const dependencies = metadata["dependencies"];
  if (!isRecord(dependencies)) {
    return undefined;
  }
  const lakehouse = dependencies["lakehouse"];
  return isRecord(lakehouse) ? lakehouse : undefined;
}

function ensureObject(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = parent[key];
  if (isRecord(value)) {
    return value;
  }
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => deepClone(entry)) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = deepClone(entry);
    }
    return out as T;
  }
  return value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) {
      return false;
    }
    return keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function omitKey(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const { [key]: _omitted, ...rest } = record;
  return rest;
}

function readDefaultLanguage(root: Record<string, unknown>): string {
  const metadata = root["metadata"];
  if (isRecord(metadata)) {
    const languageInfo = metadata["language_info"];
    if (isRecord(languageInfo)) {
      const name = asString(languageInfo["name"]);
      if (name !== undefined) {
        return name;
      }
    }
  }
  return "python";
}

function cellLanguage(cell: Record<string, unknown>): string | undefined {
  const metadata = cell["metadata"];
  return isRecord(metadata) ? asString(metadata["language"]) : undefined;
}

/** ipynb sources are string-or-line-array; normalize to one string. */
function joinSource(source: unknown): string {
  if (typeof source === "string") {
    return source;
  }
  if (Array.isArray(source)) {
    return source.filter((line) => typeof line === "string").join("");
  }
  return "";
}

/** Write back in Jupyter's canonical line-array form. */
function splitSource(source: string): string[] {
  if (source.length === 0) {
    return [];
  }
  const lines = source.split("\n");
  return lines
    .map((line, i) => (i < lines.length - 1 ? line + "\n" : line))
    .filter((line, i, all) => !(i === all.length - 1 && line === ""));
}
