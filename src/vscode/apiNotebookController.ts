/**
 * `.fabnb` API notebooks: a small JSON notebook format (cells only) and a
 * controller that runs `%api` / `%cmd` cells against the Fabric REST API
 * through the shared client — so the local-first write policy applies to
 * every request a cell makes.
 */

import * as vscode from "vscode";
import {
  ApiNotebookState,
  parseApiCell,
  resolveApiPath,
  responseTable,
  substitute,
} from "../core/apiNotebook";
import { renderTableHtml } from "../core/displayProtocol";
import { ApiNotebookError, FabricConnectError } from "../core/errors";
import type { IFabricApiClient } from "../core/types";

export const API_NOTEBOOK_TYPE = "fabric-api-notebook";
const API_LANGUAGE = "fabric-api";

interface StoredCell {
  kind: "code" | "markdown";
  source: string;
}

export class ApiNotebookSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const text = new TextDecoder().decode(content);
    let cells: StoredCell[] = [];
    if (text.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (cause) {
        throw new ApiNotebookError(
          "Cannot open the API notebook: it is not valid JSON.",
          {
            operation: "open API notebook",
            remediation: "Fix the JSON, or start a new .fabnb file.",
            cause,
          },
        );
      }
      const raw = (parsed as { cells?: unknown }).cells;
      cells = Array.isArray(raw)
        ? raw.flatMap((c) =>
            typeof c === "object" &&
            c !== null &&
            typeof (c as StoredCell).source === "string"
              ? [
                  {
                    kind:
                      (c as StoredCell).kind === "markdown"
                        ? "markdown"
                        : "code",
                    source: (c as StoredCell).source,
                  } satisfies StoredCell,
                ]
              : [],
          )
        : [];
    }
    return new vscode.NotebookData(
      cells.map(
        (c) =>
          new vscode.NotebookCellData(
            c.kind === "markdown"
              ? vscode.NotebookCellKind.Markup
              : vscode.NotebookCellKind.Code,
            c.source,
            c.kind === "markdown" ? "markdown" : API_LANGUAGE,
          ),
      ),
    );
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    const cells: StoredCell[] = data.cells.map((c) => ({
      kind: c.kind === vscode.NotebookCellKind.Markup ? "markdown" : "code",
      source: c.value,
    }));
    return new TextEncoder().encode(
      JSON.stringify({ version: 1, cells }, undefined, 2) + "\n",
    );
  }
}

export class ApiNotebookController implements vscode.Disposable {
  private readonly controller: vscode.NotebookController;
  private readonly states = new WeakMap<
    vscode.NotebookDocument,
    ApiNotebookState
  >();
  private order = 0;

  constructor(
    private readonly api: IFabricApiClient,
    private readonly tenant: () => Promise<string | undefined>,
  ) {
    this.controller = vscode.notebooks.createNotebookController(
      "fabric-connect-api",
      API_NOTEBOOK_TYPE,
      "Fabric REST API",
    );
    this.controller.supportedLanguages = [API_LANGUAGE];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = async (cells, notebook) => {
      for (const cell of cells) {
        await this.run(cell, notebook);
      }
    };
  }

  dispose(): void {
    this.controller.dispose();
  }

  private state(notebook: vscode.NotebookDocument): ApiNotebookState {
    let state = this.states.get(notebook);
    if (state === undefined) {
      state = new ApiNotebookState();
      this.states.set(notebook, state);
    }
    return state;
  }

  private async run(
    cell: vscode.NotebookCell,
    notebook: vscode.NotebookDocument,
  ): Promise<void> {
    const execution = this.controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this.order;
    execution.start(Date.now());
    const state = this.state(notebook);
    try {
      const parsed = parseApiCell(
        substitute(cell.document.getText(), state, cell.index),
      );
      if (parsed.type === "cmd") {
        for (const { name, value } of parsed.sets) {
          state.set(name, value);
        }
        const shown: Record<string, string | null> = {};
        for (const name of [
          ...parsed.sets.map((s) => s.name),
          ...parsed.gets,
        ]) {
          shown[name] = state.get(name) ?? null;
        }
        state.recordOutput(cell.index, shown);
        await execution.replaceOutput(
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json(shown),
          ]),
        );
        execution.end(true, Date.now());
        return;
      }
      const tenantId = await this.tenant();
      if (tenantId === undefined) {
        throw new FabricConnectError(
          "Cannot call the Fabric API: no tenant is signed in.",
          {
            operation: "run API cell",
            remediation:
              "Run 'Fabric: Sign In' or 'Fabric: Connect to Compute' first.",
          },
        );
      }
      const started = Date.now();
      const response = await this.api.request<unknown>({
        method: parsed.method,
        path: resolveApiPath(parsed.path, state),
        tenantId,
        ...(parsed.body === undefined ? {} : { body: parsed.body }),
      });
      const value = response.body ?? null;
      state.recordOutput(cell.index, value);
      const items = [vscode.NotebookCellOutputItem.json(value)];
      const table = responseTable(value);
      if (table !== undefined) {
        items.unshift(
          vscode.NotebookCellOutputItem.text(
            renderTableHtml(table),
            "text/html",
          ),
        );
      }
      await execution.replaceOutput([
        new vscode.NotebookCellOutput(items, {
          status: response.status,
          durationMs: Date.now() - started,
        }),
      ]);
      execution.end(true, Date.now());
    } catch (error) {
      await execution.replaceOutput(
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.error(
            error instanceof Error ? error : new Error(String(error)),
          ),
        ]),
      );
      execution.end(false, Date.now());
    }
  }
}
