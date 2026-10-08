/**
 * "Open Changes as Text": the raw diff of a notebook file, HEAD against the
 * working tree, as read-only text — the lines you commit, metadata
 * included. "Open as Text" reopens the notebook itself as editable text.
 * See `src/core/notebookTextDiff.ts` for why the views are renamed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { FabricConnectError } from "../core/errors";
import {
  TEXT_VIEW_SCHEME,
  type TextViewRef,
  decodeTextViewQuery,
  encodeTextViewQuery,
  textViewPath,
} from "../core/notebookTextDiff";
import { activeFabricNotebookUri } from "./activeNotebook";
import { isFabricNotebook } from "./notebookSerializer";

/** The part of the built-in Git extension's API used here. */
interface GitApi {
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
  getRepository(uri: vscode.Uri): unknown;
}

interface GitExtension {
  getAPI(version: 1): GitApi;
}

export class NotebookTextDiff
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  /** Text views shown so far, by the file they show. */
  private readonly views = new Map<string, Set<string>>();
  /** Resolved by `openChanges`, before any view is rendered. */
  private git: GitApi | undefined;
  private readonly subscriptions: vscode.Disposable[];

  constructor() {
    const saved = (uri: vscode.Uri) => {
      for (const view of this.views.get(uri.fsPath) ?? []) {
        this.changed.fire(vscode.Uri.parse(view));
      }
    };
    this.subscriptions = [
      this.changed,
      vscode.workspace.onDidSaveTextDocument((doc) => saved(doc.uri)),
      vscode.workspace.onDidSaveNotebookDocument((doc) => saved(doc.uri)),
    ];
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const query = decodeTextViewQuery(uri.query);
    if (query === undefined) {
      return "";
    }
    const file = vscode.Uri.file(query.path);
    if (query.ref === "working") {
      try {
        return await fs.readFile(file.fsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return ""; // deleted in the working tree
        }
        throw error;
      }
    }
    // Read through the git extension's file system provider, which reports
    // a file that is not in HEAD (a new notebook, or a repository without
    // commits) as FileNotFound: that side is empty. Other errors surface.
    const git = this.git ?? (await gitApi(file));
    try {
      const bytes = await vscode.workspace.fs.readFile(
        git.toGitUri(file, "HEAD"),
      );
      return new TextDecoder("utf-8").decode(bytes);
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return "";
      }
      throw error;
    }
  }

  /** Opens the HEAD ↔ working tree text diff of a notebook file. */
  async openChanges(arg?: unknown): Promise<void> {
    const file = notebookUriOf(arg);
    if (file === undefined) {
      throw new FabricConnectError(
        "Cannot open the text diff: no Fabric notebook is selected.",
        {
          operation: "open changes as text",
          remediation:
            "Right-click a notebook-content file in Source Control, or open the notebook and use the compare icon in its toolbar.",
        },
      );
    }
    const name = path.basename(path.dirname(file.fsPath));
    // Resolve git here, so its errors reach you instead of an empty view.
    this.git = await gitApi(file);
    if (this.git.getRepository(file) === null) {
      throw new FabricConnectError(
        `Cannot open the text diff of notebook ${name}: its file is not in a git repository that VS Code has open.`,
        {
          operation: "open changes as text",
          entity: `notebook ${name}`,
          remediation:
            "Open the repository's folder in VS Code (Source Control should list it), then retry.",
        },
      );
    }
    await vscode.commands.executeCommand(
      "vscode.diff",
      this.view(file, "HEAD"),
      this.view(file, "working"),
      `${name} (HEAD ↔ working tree, text)`,
    );
  }

  private view(file: vscode.Uri, ref: TextViewRef): vscode.Uri {
    const view = vscode.Uri.from({
      scheme: TEXT_VIEW_SCHEME,
      path: textViewPath(file.path, ref),
      query: encodeTextViewQuery({ path: file.fsPath, ref }),
    });
    const shown = this.views.get(file.fsPath) ?? new Set<string>();
    shown.add(view.toString());
    this.views.set(file.fsPath, shown);
    return view;
  }
}

/** Reopens the active Fabric notebook as editable text. */
export async function openAsText(arg?: unknown): Promise<void> {
  const file = notebookUriOf(arg);
  if (file === undefined) {
    throw new FabricConnectError(
      "Cannot open the notebook as text: no Fabric notebook is open.",
      {
        operation: "open notebook as text",
        remediation: "Open a Fabric notebook first, then run this command.",
      },
    );
  }
  await vscode.commands.executeCommand("vscode.openWith", file, "default");
}

/**
 * The notebook file a command was invoked on: a Source Control row, a URI,
 * the notebook toolbar's editor, else the active Fabric notebook.
 */
function notebookUriOf(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  if (typeof arg === "object" && arg !== null) {
    const record = arg as {
      resourceUri?: unknown;
      notebookEditor?: { notebookUri?: unknown };
    };
    if (record.resourceUri instanceof vscode.Uri) {
      return record.resourceUri;
    }
    if (record.notebookEditor?.notebookUri instanceof vscode.Uri) {
      return record.notebookEditor.notebookUri;
    }
  }
  const notebook = vscode.window.activeNotebookEditor?.notebook;
  if (notebook !== undefined && isFabricNotebook(notebook)) {
    return notebook.uri;
  }
  return activeFabricNotebookUri();
}

async function gitApi(file: vscode.Uri): Promise<GitApi> {
  const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (extension === undefined) {
    throw new FabricConnectError(
      "Cannot open the text diff: VS Code's built-in Git extension is not available.",
      {
        operation: "open changes as text",
        entity: `notebook ${path.basename(path.dirname(file.fsPath))}`,
        remediation:
          "Enable the built-in 'Git' extension (Extensions → @builtin git), then retry.",
      },
    );
  }
  try {
    const exports = extension.isActive
      ? extension.exports
      : await extension.activate();
    return exports.getAPI(1);
  } catch (cause) {
    throw new FabricConnectError(
      "Cannot open the text diff: VS Code's Git extension is not ready.",
      {
        operation: "open changes as text",
        entity: `notebook ${path.basename(path.dirname(file.fsPath))}`,
        remediation:
          "Check that Git is enabled ('git.enabled' setting) and installed, then retry.",
        cause,
      },
    );
  }
}
