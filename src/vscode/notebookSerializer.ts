/**
 * Bridges the Notebook Fidelity Module to VS Code's stable notebook API.
 *
 * The serializer is stateless: the fidelity payload (root object, original
 * bytes, each cell's raw JSON) is stored in the notebook document's own
 * metadata during deserialization and read back from the exact document
 * being saved. VS Code round-trips that metadata through open, revert, and
 * save, so a payload can never be paired with the wrong file — the failure
 * mode a serializer-side model registry cannot rule out, because the
 * NotebookSerializer API does not expose the document URI.
 */

import * as vscode from "vscode";
import {
  defaultRawCell,
  parseNotebook,
  serializeNotebook,
} from "../core/notebookCodec";
import {
  type SourceCellKind,
  type SourceCellRaw,
  parseNotebookSource,
  serializeNotebookSource,
} from "../core/notebookSourceCodec";

export const NOTEBOOK_TYPE = "fabric-notebook";
/** Fabric's git source format: notebook-content.py / .scala / .sql / .r. */
export const NOTEBOOK_SOURCE_TYPE = "fabric-notebook-source";

/** True for both Fabric notebook formats this extension edits. */
export function isFabricNotebook(notebook: vscode.NotebookDocument): boolean {
  return (
    notebook.notebookType === NOTEBOOK_TYPE ||
    notebook.notebookType === NOTEBOOK_SOURCE_TYPE
  );
}

/** Notebook-level metadata keys carrying the fidelity payload. */
const META_ROOT = "fabricRoot";
const META_ORIGINAL_TEXT = "fabricOriginalText";
/** Cell-level metadata key carrying the cell's raw ipynb object. */
const META_CELL_RAW = "fabricRaw";
/** Source format only: the file's comment prefix. */
const META_PREFIX = "fabricPrefix";

/** True when the cell is a Fabric parameters cell (either format). */
export function isParametersCell(cell: vscode.NotebookCell): boolean {
  const raw = cell.metadata?.[META_CELL_RAW];
  if (!isRecord(raw)) {
    return false;
  }
  if (raw["kind"] === "parameters") {
    return true;
  }
  const metadata = raw["metadata"];
  return (
    isRecord(metadata) &&
    Array.isArray(metadata["tags"]) &&
    metadata["tags"].includes("parameters")
  );
}

/** The fidelity root stored in an open document's metadata, if present. */
export function fabricRootOf(
  notebook: vscode.NotebookDocument,
): Record<string, unknown> | undefined {
  const root = notebook.metadata?.[META_ROOT];
  return isRecord(root) ? root : undefined;
}

/** Metadata for a metadata-edit that swaps in an updated fidelity root. */
export function withFabricRoot(
  metadata: { [key: string]: unknown } | undefined,
  root: Record<string, unknown>,
): { [key: string]: unknown } {
  return { ...metadata, [META_ROOT]: root };
}

export class FabricNotebookSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(
    content: Uint8Array,
    _token: vscode.CancellationToken,
  ): vscode.NotebookData {
    const text = new TextDecoder().decode(content);
    const parsed = parseNotebook(text, "notebook");

    const cells = parsed.cells.map((cell) => {
      const kind =
        cell.cellType === "markdown"
          ? vscode.NotebookCellKind.Markup
          : vscode.NotebookCellKind.Code;
      const data = new vscode.NotebookCellData(
        kind,
        cell.source,
        cell.language ?? "python",
      );
      data.metadata = { [META_CELL_RAW]: cell.raw };
      return data;
    });
    const notebook = new vscode.NotebookData(cells);
    notebook.metadata = {
      [META_ROOT]: parsed.root,
      [META_ORIGINAL_TEXT]: text,
    };
    return notebook;
  }

  serializeNotebook(
    data: vscode.NotebookData,
    _token: vscode.CancellationToken,
  ): Uint8Array {
    const root = data.metadata?.[META_ROOT];
    const originalText = data.metadata?.[META_ORIGINAL_TEXT];
    if (!isRecord(root) || typeof originalText !== "string") {
      // Refuse to write a lossy file silently: without the fidelity payload,
      // portal metadata (including unknown fields) would be dropped.
      throw new Error(
        "Cannot save: this notebook has no Fabric fidelity payload attached, so saving would lose portal metadata. Reopen the file and try again.",
      );
    }
    const cells = data.cells.map((cell) => {
      const isMarkdown = cell.kind === vscode.NotebookCellKind.Markup;
      const raw = cell.metadata?.[META_CELL_RAW];
      return {
        source: cell.value,
        raw: isCompatibleRaw(raw, isMarkdown)
          ? raw
          : defaultRawCell(isMarkdown),
      };
    });
    return new TextEncoder().encode(
      serializeNotebook({ fileName: "notebook", root, originalText, cells }),
    );
  }
}

/** A cell keeps its raw object only while its markdown/code kind matches. */
function isCompatibleRaw(
  raw: unknown,
  isMarkdown: boolean,
): raw is Record<string, unknown> {
  return isRecord(raw) && (raw["cell_type"] === "markdown") === isMarkdown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Serializer for Fabric's git source format. Same stateless design as the
 * .ipynb serializer: the fidelity payload (root, original text, prefix, each
 * cell's raw block) travels in the document's own metadata.
 */
export class FabricSourceNotebookSerializer
  implements vscode.NotebookSerializer
{
  deserializeNotebook(
    content: Uint8Array,
    _token: vscode.CancellationToken,
  ): vscode.NotebookData {
    const text = new TextDecoder().decode(content);
    // The serializer never sees the file name; the codec infers the
    // notebook's main language from its cells instead.
    const parsed = parseNotebookSource(text, "notebook-content");
    const cells = parsed.cells.map((cell) => {
      const data = new vscode.NotebookCellData(
        cell.kind === "markdown"
          ? vscode.NotebookCellKind.Markup
          : vscode.NotebookCellKind.Code,
        cell.source,
        cell.language,
      );
      data.metadata = { [META_CELL_RAW]: cell.raw };
      return data;
    });
    const notebook = new vscode.NotebookData(cells);
    notebook.metadata = {
      [META_ROOT]: parsed.root,
      [META_ORIGINAL_TEXT]: text,
      [META_PREFIX]: parsed.prefix,
    };
    return notebook;
  }

  serializeNotebook(
    data: vscode.NotebookData,
    _token: vscode.CancellationToken,
  ): Uint8Array {
    const root = data.metadata?.[META_ROOT];
    const originalText = data.metadata?.[META_ORIGINAL_TEXT];
    const prefix = data.metadata?.[META_PREFIX];
    if (
      !isRecord(root) ||
      typeof originalText !== "string" ||
      typeof prefix !== "string"
    ) {
      throw new Error(
        "Cannot save: this notebook has no Fabric fidelity payload attached, so saving would lose portal metadata. Reopen the file and try again.",
      );
    }
    const cells = data.cells.map((cell) => {
      const isMarkdown = cell.kind === vscode.NotebookCellKind.Markup;
      const raw = cell.metadata?.[META_CELL_RAW];
      const compatible =
        isSourceRaw(raw) && (raw.kind === "markdown") === isMarkdown;
      const kind: SourceCellKind = isMarkdown
        ? "markdown"
        : compatible
          ? raw.kind
          : "code";
      return {
        kind,
        language: isMarkdown ? "markdown" : cell.languageId,
        source: cell.value,
        ...(compatible ? { raw } : {}),
      };
    });
    return new TextEncoder().encode(
      serializeNotebookSource({
        fileName: "notebook-content",
        prefix,
        root,
        originalText,
        cells,
      }),
    );
  }
}

function isSourceRaw(raw: unknown): raw is SourceCellRaw {
  return (
    isRecord(raw) &&
    typeof raw["kind"] === "string" &&
    typeof raw["source"] === "string" &&
    typeof raw["blockText"] === "string"
  );
}
