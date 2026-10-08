/**
 * Run cells from the text view: a Fabric notebook in the git source format
 * (`*.Notebook/notebook-content.py` / `.sql` / `.scala` / `.r`) reopened
 * with Open as Text gets **Run Cell | Run All Above** on each runnable
 * cell's marker line, and **Run All** on line 0. The cells come from the
 * same parse as the notebook editor.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import {
  type SourceCellRange,
  sourceCellRanges,
} from "../core/notebookSourceCodec";

const NOTEBOOK_SOURCE = /\.Notebook[\\/]notebook-content\.(py|sql|scala|r)$/;

/** True for a source-format Fabric notebook file. */
export function isNotebookSourcePath(fsPath: string): boolean {
  return NOTEBOOK_SOURCE.test(fsPath);
}

/** The runnable cells of a notebook text document; [] when it does not parse. */
export function runnableCells(
  document: vscode.TextDocument,
): SourceCellRange[] {
  try {
    return sourceCellRanges(
      document.getText(),
      path.basename(document.uri.fsPath),
    ).filter((cell) => cell.kind !== "markdown");
  } catch {
    // Not (yet) a valid notebook source: no lenses; running says why.
    return [];
  }
}

export class NotebookCellLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isNotebookSourcePath(document.uri.fsPath)) {
      return [];
    }
    const cells = runnableCells(document);
    if (cells.length === 0) {
      return [];
    }
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses = [
      new vscode.CodeLens(top, {
        title: "$(run-all) Run All",
        command: "fabric-connect.runNotebookAll",
        arguments: [document.uri],
      }),
    ];
    for (const cell of cells) {
      const range = new vscode.Range(cell.markerLine, 0, cell.markerLine, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(play) Run Cell",
          command: "fabric-connect.runNotebookCell",
          arguments: [document.uri, cell.index],
        }),
        new vscode.CodeLens(range, {
          title: "Run All Above",
          command: "fabric-connect.runNotebookCellsAbove",
          arguments: [document.uri, cell.index],
        }),
      );
    }
    return lenses;
  }
}
