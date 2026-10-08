/**
 * The Fabric notebook you are working on, whether it is open in the
 * notebook editor (the default) or as text (Open as Text).
 * Commands that act on "the active notebook" (Lakehouses, sessions, the
 * host status bar) use this, so both editors behave the same.
 */

import * as vscode from "vscode";
import { isNotebookSourcePath } from "./notebookCellLens";
import { openFabricNotebook } from "./lakehouseAttachments";
import { isFabricNotebook } from "./notebookSerializer";

/** The active Fabric notebook's file: notebook editor first, else text editor. */
export function activeFabricNotebookUri(): vscode.Uri | undefined {
  const notebook = vscode.window.activeNotebookEditor?.notebook;
  if (notebook !== undefined && isFabricNotebook(notebook)) {
    return notebook.uri;
  }
  const text = vscode.window.activeTextEditor?.document;
  return text !== undefined &&
    text.uri.scheme === "file" &&
    isNotebookSourcePath(text.uri.fsPath)
    ? text.uri
    : undefined;
}

/**
 * The notebook model for a Fabric notebook file: the open one, else loaded
 * from disk without showing an editor.
 */
export async function fabricNotebookFor(
  uri: vscode.Uri,
): Promise<vscode.NotebookDocument> {
  return (
    openFabricNotebook(uri) ??
    (await vscode.workspace.openNotebookDocument(uri))
  );
}
