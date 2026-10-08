/**
 * Lakehouse attachments of a Fabric notebook, shared by the Lakehouse panel,
 * the Lakehouses view and the Repo view. Attachments live in the notebook
 * file's own metadata (`metadata.dependencies.lakehouse`, as the Fabric
 * portal writes it): many Lakehouses can be attached, one is the default.
 *
 * Edits go through the open document as a notebook metadata edit, so they
 * are undoable and saving persists them through the fidelity codecs.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { LakehouseError } from "../core/errors";
import type { LakehouseBinding } from "../core/lakehouseBindings";
import {
  type LakehouseAttachments,
  getLakehouseAttachments,
  parseNotebook,
  withLogicalIdsUnbound,
} from "../core/notebookCodec";
import { parseNotebookSource } from "../core/notebookSourceCodec";
import {
  NOTEBOOK_SOURCE_TYPE,
  NOTEBOOK_TYPE,
  fabricRootOf,
  isFabricNotebook,
  withFabricRoot,
} from "./notebookSerializer";

export interface NotebookAttachments extends LakehouseAttachments {
  /** This machine's binding for the notebook; it is what runs. */
  readonly localBinding?: LakehouseBinding;
}

/** The Fabric notebook type that edits this file. */
export function notebookTypeOf(uri: vscode.Uri): string {
  return uri.fsPath.toLowerCase().endsWith(".ipynb")
    ? NOTEBOOK_TYPE
    : NOTEBOOK_SOURCE_TYPE;
}

/** The notebook open as a Fabric notebook for this URI, if any. */
export function openFabricNotebook(
  uri: vscode.Uri,
): vscode.NotebookDocument | undefined {
  return vscode.workspace.notebookDocuments.find(
    (doc) =>
      doc.uri.toString() === uri.toString() &&
      isFabricNotebook(doc) &&
      fabricRootOf(doc) !== undefined,
  );
}

/** The open Fabric notebook for this URI, or a loud, actionable error. */
export function requireFabricNotebook(
  uri: vscode.Uri,
  operation: string,
): vscode.NotebookDocument {
  const notebook = openFabricNotebook(uri);
  if (notebook === undefined) {
    throw new LakehouseError(
      `Cannot manage lakehouses: notebook '${path.basename(uri.fsPath)}' is not open as a Fabric notebook.`,
      {
        operation,
        entity: `notebook ${path.basename(uri.fsPath)}`,
        remediation:
          "Open the file with 'Fabric: Open File as Fabric Notebook', then retry.",
      },
    );
  }
  return notebook;
}

/**
 * Attachments of a notebook: from the open document (unsaved edits
 * included), else from the file on disk. Undefined when the file cannot be
 * read or parsed.
 */
/**
 * Where a notebook's Lakehouses come from besides its own metadata: repo
 * Lakehouse items by `logicalId` (logical IDs from git count as unbound)
 * and this machine's binding for the notebook (`.fabric/local.json`).
 */
export interface AttachmentSources {
  /** Resolves to a lookup: a repo Lakehouse's display name by logicalId. */
  readonly logicalNames: () => Promise<(id: string) => string | undefined>;
  readonly localBinding: (
    notebook: vscode.Uri,
  ) => Promise<LakehouseBinding | undefined>;
}

export async function readAttachments(
  uri: vscode.Uri,
  sources?: AttachmentSources,
): Promise<NotebookAttachments | undefined> {
  const raw = await readRawAttachments(uri);
  return raw === undefined ? undefined : withSources(uri, raw, sources);
}

/** Applies logical-ID and local-binding sources to a notebook's metadata. */
export async function withSources(
  uri: vscode.Uri,
  raw: LakehouseAttachments,
  sources: AttachmentSources | undefined,
): Promise<NotebookAttachments> {
  if (sources === undefined) {
    return raw;
  }
  const attachments = withLogicalIdsUnbound(raw, await sources.logicalNames());
  const localBinding = await sources.localBinding(uri);
  return localBinding === undefined
    ? attachments
    : { ...attachments, localBinding };
}

async function readRawAttachments(
  uri: vscode.Uri,
): Promise<NotebookAttachments | undefined> {
  const open = openFabricNotebook(uri);
  const openRoot = open === undefined ? undefined : fabricRootOf(open);
  if (openRoot !== undefined) {
    return getLakehouseAttachments(openRoot);
  }
  try {
    const text = await fs.readFile(uri.fsPath, "utf8");
    const name = path.basename(uri.fsPath);
    const root =
      notebookTypeOf(uri) === NOTEBOOK_TYPE
        ? parseNotebook(text, name).root
        : parseNotebookSource(text, name).root;
    return getLakehouseAttachments(root);
  } catch {
    // An unreadable notebook shows no attachments; opening it reports why.
    return undefined;
  }
}

/** Applies a metadata edit to the live document, marking it dirty. */
export async function applyAttachmentEdit(
  notebook: vscode.NotebookDocument,
  update: (root: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const name = path.basename(notebook.uri.fsPath);
  const root = fabricRootOf(notebook);
  if (root === undefined) {
    throw new LakehouseError(
      `Failed to update lakehouse attachments: '${name}' has no Fabric metadata loaded.`,
      {
        operation: "update lakehouse attachment",
        entity: `notebook ${name}`,
        remediation: "Reopen the notebook as a Fabric notebook, then retry.",
      },
    );
  }
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [
    vscode.NotebookEdit.updateNotebookMetadata(
      withFabricRoot(notebook.metadata, update(root)),
    ),
  ]);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new LakehouseError(
      `Failed to update lakehouse attachments: VS Code rejected the metadata edit on '${name}'.`,
      {
        operation: "update lakehouse attachment",
        entity: `notebook ${name}`,
        remediation: "Retry; if it persists, reopen the notebook first.",
      },
    );
  }
}

/**
 * Loads the notebook (without showing an editor when it is not open yet),
 * applies the edit and saves, so the notebook file's metadata changes the
 * way attaching in the Fabric portal does. Refuses while the file has
 * unsaved edits in a text editor: two editors must not write one file.
 */
export async function editAndSaveAttachments(
  uri: vscode.Uri,
  update: (root: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const name = path.basename(path.dirname(uri.fsPath));
  const dirtyText = vscode.workspace.textDocuments.some(
    (doc) => doc.uri.toString() === uri.toString() && doc.isDirty,
  );
  if (dirtyText) {
    throw new LakehouseError(
      `Cannot change the lakehouses of notebook ${name}: its file has unsaved changes in the text editor.`,
      {
        operation: "update lakehouse attachment",
        entity: `notebook ${name}`,
        remediation: "Save the file (File → Save), then retry.",
      },
    );
  }
  if (openFabricNotebook(uri) === undefined) {
    await vscode.workspace.openNotebookDocument(uri);
  }
  const notebook = requireFabricNotebook(uri, "update lakehouse attachment");
  await applyAttachmentEdit(notebook, update);
  if (!(await notebook.save())) {
    throw new LakehouseError(
      `Attached lakehouses changed in notebook ${name}, but saving the notebook failed.`,
      {
        operation: "save lakehouse attachment",
        entity: `notebook ${name}`,
        remediation:
          "Save the notebook yourself (File → Save); the change is in the open editor.",
      },
    );
  }
}
