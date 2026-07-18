/**
 * Bridges the Notebook Fidelity Module to VS Code's stable notebook API.
 * The parsed NotebookModel (which carries every unknown field and the
 * original bytes) is kept per open document so saving goes back through
 * the codec, preserving portal compatibility.
 *
 * VS Code's NotebookSerializer interface deliberately does not pass the
 * document URI, so association is explicit: `deserializeNotebook` queues
 * the parsed model and the extension calls `associate(uri)` from
 * `onDidOpenNotebookDocument`, which fires immediately after.
 */

import * as vscode from "vscode";
import type { INotebookCodec, NotebookModel } from "../core/notebookCodec";

export const NOTEBOOK_TYPE = "fabric-notebook";

export class FabricNotebookSerializer implements vscode.NotebookSerializer {
  /** Fidelity models for open documents, keyed by document URI. */
  private readonly models = new Map<string, NotebookModel>();
  /** Models parsed but not yet claimed by onDidOpenNotebookDocument. */
  private readonly unclaimed: NotebookModel[] = [];
  private activeModel: NotebookModel | undefined;

  constructor(private readonly codec: INotebookCodec) {}

  getModel(uri: vscode.Uri): NotebookModel | undefined {
    return this.models.get(uri.toString());
  }

  /** Called by the panel after mutating metadata so the doc saves dirty. */
  markDirty(uri: vscode.Uri): void {
    this.models.get(uri.toString())?.markDirty();
  }

  /** Pairs the most recently parsed model with its document. */
  associate(uri: vscode.Uri): void {
    const model = this.unclaimed.shift();
    if (model !== undefined) {
      this.models.set(uri.toString(), model);
      this.activeModel = model;
    }
  }

  setActiveModel(uri: vscode.Uri): void {
    const model = this.models.get(uri.toString());
    if (model !== undefined) {
      this.activeModel = model;
    }
  }

  handleDocumentClosed(uri: vscode.Uri): void {
    const model = this.models.get(uri.toString());
    this.models.delete(uri.toString());
    if (this.activeModel === model) {
      this.activeModel = undefined;
    }
  }

  deserializeNotebook(
    content: Uint8Array,
    _token: vscode.CancellationToken,
  ): vscode.NotebookData {
    const text = new TextDecoder().decode(content);
    const model = this.codec.parse(text, "notebook");
    this.unclaimed.push(model);

    const cells = model.cells.map((cell) => {
      const kind =
        cell.cellType === "markdown"
          ? vscode.NotebookCellKind.Markup
          : vscode.NotebookCellKind.Code;
      return new vscode.NotebookCellData(
        kind,
        cell.source,
        cell.language ?? "python",
      );
    });
    return new vscode.NotebookData(cells);
  }

  serializeNotebook(
    data: vscode.NotebookData,
    _token: vscode.CancellationToken,
  ): Uint8Array {
    const model = this.findModelFor(data);
    if (model === undefined) {
      // Refuse to write a lossy file silently: without the fidelity model,
      // portal metadata (including unknown fields) would be dropped.
      throw new Error(
        "Cannot save: this notebook has no Fabric fidelity model attached, so saving would lose portal metadata. Reopen the file and try again.",
      );
    }
    syncCells(model, data);
    return new TextEncoder().encode(this.codec.serialize(model));
  }

  /**
   * The serializer API gives us NotebookData without a URI. Prefer an open
   * model whose cell sources match; otherwise fall back to the active one.
   */
  private findModelFor(data: vscode.NotebookData): NotebookModel | undefined {
    for (const model of this.models.values()) {
      if (
        model.cells.length === data.cells.length &&
        model.cells.every((cell, i) => cell.source === data.cells[i].value)
      ) {
        return model;
      }
    }
    if (this.activeModel !== undefined) {
      return this.activeModel;
    }
    // Single open model: unambiguous even if edited.
    const all = [...this.models.values()];
    return all.length === 1 ? all[0] : undefined;
  }
}

function syncCells(model: NotebookModel, data: vscode.NotebookData): void {
  let changed = false;
  if (data.cells.length === model.cells.length) {
    for (let i = 0; i < data.cells.length; i++) {
      if (model.cells[i].source !== data.cells[i].value) {
        model.cells[i].source = data.cells[i].value;
        changed = true;
      }
    }
  } else {
    // Cells were added/removed in the editor: rebuild the cell list, keeping
    // raw objects (and their unknown fields) for cells that still line up.
    const rebuilt = data.cells.map((cell, i) => {
      const existing = model.cells[i];
      const isMarkdown = cell.kind === vscode.NotebookCellKind.Markup;
      if (
        existing !== undefined &&
        (existing.cellType === "markdown") === isMarkdown
      ) {
        existing.source = cell.value;
        return existing;
      }
      return {
        cellType: isMarkdown ? "markdown" : "code",
        language: isMarkdown ? "markdown" : cell.languageId,
        source: cell.value,
        raw: {
          cell_type: isMarkdown ? "markdown" : "code",
          ...(isMarkdown ? {} : { execution_count: null, outputs: [] }),
          metadata: {},
          source: [],
        } as Record<string, unknown>,
      };
    });
    model.cells.length = 0;
    model.cells.push(...rebuilt);
    changed = true;
  }
  if (changed) {
    model.markDirty();
  }
}
