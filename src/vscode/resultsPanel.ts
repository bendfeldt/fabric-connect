/**
 * A single reusable webview that shows query results as tables. Static
 * HTML only: strict CSP, no scripts, every value HTML-escaped by
 * `renderTableHtml`.
 */

import * as crypto from "node:crypto";
import * as vscode from "vscode";
import {
  type DisplayTable,
  escapeHtml,
  renderTableHtml,
} from "../core/displayProtocol";

export class ResultsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

  dispose(): void {
    this.panel?.dispose();
  }

  show(title: string, subtitle: string, tables: readonly DisplayTable[]): void {
    if (this.panel === undefined) {
      this.panel = vscode.window.createWebviewPanel(
        "fabricConnect.results",
        "Fabric Results",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: false, localResourceRoots: [] },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }
    this.panel.title = `Results: ${title}`;
    const nonce = crypto.randomBytes(16).toString("base64url");
    const body =
      tables.length === 0
        ? "<p>The query returned no tables.</p>"
        : tables
            .map(
              (table, i) =>
                (tables.length > 1 ? `<h3>Result ${i + 1}</h3>` : "") +
                renderTableHtml(table),
            )
            .join("\n");
    this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); padding: 0.5rem 1rem; }
  table { border-collapse: collapse; margin: 0.5rem 0; }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 0.2rem 0.5rem; text-align: left; vertical-align: top; }
  th { background: var(--vscode-editor-inactiveSelectionBackground); }
  .sub { opacity: 0.7; }
</style>
</head>
<body>
<h2>${escapeHtml(title)}</h2>
<p class="sub">${escapeHtml(subtitle)}</p>
${body}
</body>
</html>`;
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }
}
