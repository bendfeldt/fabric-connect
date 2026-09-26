/**
 * Runs a local `.kql`, `.dax` or `.graphql` file against the item it is
 * bound to (picked once per file, kept in `.fabric/local.json`) and shows
 * the result tables. Executors are looked up by query kind in a registry,
 * so adding a kind is one `register` call, not an if-chain.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ComputeProfile } from "../core/computeProfile";
import { QueryError } from "../core/errors";
import { type NamedItem, listAll, listWorkspaces } from "../core/fabricCatalog";
import {
  type QueryBinding,
  queryKindOf,
  readQueryBinding,
  writeQueryBinding,
} from "../core/queryBindings";
import {
  type QueryKind,
  type QueryResult,
  runDax,
  runGraphql,
  runKql,
  splitGraphqlVariables,
} from "../core/queryExecutors";
import { LOCAL_OVERRIDE_FILE } from "../core/targetResolver";
import type { IFabricApiClient } from "../core/types";
import type { ResultsPanel } from "./resultsPanel";

type Executor = (binding: QueryBinding, text: string) => Promise<QueryResult>;

interface KindInfo {
  /** Fabric list endpoint segment for the bound item type. */
  readonly collection: string;
  readonly label: string;
}

const KINDS: Record<QueryKind, KindInfo> = {
  kql: { collection: "kqlDatabases", label: "KQL database" },
  dax: { collection: "semanticModels", label: "semantic model" },
  graphql: { collection: "graphQLApis", label: "GraphQL API" },
};

export class QueryRunner {
  private readonly executors = new Map<QueryKind, Executor>();

  constructor(
    private readonly api: IFabricApiClient,
    private readonly workspaceRoot: string | undefined,
    private readonly compute: () => Promise<ComputeProfile | undefined>,
    private readonly promptTenantId: () => Promise<string | undefined>,
    private readonly results: ResultsPanel,
  ) {
    this.register("kql", (b, text) =>
      runKql(api, b.tenantId, b.queryServiceUri ?? "", b.displayName, text),
    );
    this.register("dax", (b, text) =>
      runDax(api, b.tenantId, b.workspaceId, b.itemId, text),
    );
    this.register("graphql", (b, text) => {
      const { query, variables } = splitGraphqlVariables(text);
      return runGraphql(
        api,
        b.tenantId,
        b.workspaceId,
        b.itemId,
        query,
        variables,
      );
    });
  }

  register(kind: QueryKind, executor: Executor): void {
    this.executors.set(kind, executor);
  }

  async runActiveFile(): Promise<void> {
    const document = vscode.window.activeTextEditor?.document;
    const kind =
      document === undefined ? undefined : queryKindOf(document.fileName);
    if (document === undefined || kind === undefined) {
      throw new QueryError(
        "Cannot run a query: the active file is not a query file.",
        {
          operation: "run query",
          remediation:
            "Open a .kql, .dax or .graphql file, then run 'Fabric: Run Query File'.",
        },
      );
    }
    const relPath = this.relPath(document.uri.fsPath);
    const binding =
      readQueryBinding(await this.readLocal(), relPath) ??
      (await this.pickBinding(kind, relPath));
    if (binding === undefined) {
      return;
    }
    const executor = this.executors.get(kind);
    if (executor === undefined) {
      throw new QueryError(`No executor is registered for '${kind}' files.`, {
        operation: "run query",
        entity: relPath,
        remediation: "Report this as a bug in Fabric Connect.",
      });
    }
    const editor = vscode.window.activeTextEditor;
    const text =
      editor !== undefined && !editor.selection.isEmpty
        ? editor.document.getText(editor.selection)
        : document.getText();
    const started = Date.now();
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Running ${path.basename(relPath)} on ${binding.displayName}…`,
      },
      () => executor(binding, text),
    );
    this.results.show(
      path.basename(relPath),
      `${KINDS[kind].label} ${binding.displayName} · ${((Date.now() - started) / 1000).toFixed(1)}s`,
      result.tables,
    );
  }

  async changeTarget(): Promise<void> {
    const document = vscode.window.activeTextEditor?.document;
    const kind =
      document === undefined ? undefined : queryKindOf(document.fileName);
    if (document === undefined || kind === undefined) {
      throw new QueryError(
        "Cannot change the query target: the active file is not a query file.",
        {
          operation: "change query target",
          remediation: "Open a .kql, .dax or .graphql file first.",
        },
      );
    }
    await this.pickBinding(kind, this.relPath(document.uri.fsPath));
  }

  private async pickBinding(
    kind: QueryKind,
    relPath: string,
  ): Promise<QueryBinding | undefined> {
    const profile = await this.compute();
    const tenantId = profile?.tenantId ?? (await this.promptTenantId());
    if (tenantId === undefined) {
      return undefined;
    }
    const workspaces = await listWorkspaces(this.api, tenantId);
    const workspace = await vscode.window.showQuickPick(
      workspaces
        .map((w) => ({
          label: w.displayName,
          description:
            w.id === profile?.workspaceId ? "connected compute" : undefined,
          w,
        }))
        .sort((a, b) => (a.description ? -1 : b.description ? 1 : 0)),
      {
        placeHolder: `Workspace of the ${KINDS[kind].label} for ${relPath}`,
        ignoreFocusOut: true,
      },
    );
    if (workspace === undefined) {
      return undefined;
    }
    const items = await listAll<Record<string, unknown>>(
      this.api,
      tenantId,
      `/workspaces/${workspace.w.id}/${KINDS[kind].collection}`,
    );
    const choices = items.flatMap((item) =>
      typeof item["id"] === "string"
        ? [
            {
              label:
                typeof item["displayName"] === "string"
                  ? item["displayName"]
                  : item["id"],
              item,
            },
          ]
        : [],
    );
    if (choices.length === 0) {
      throw new QueryError(
        `Workspace '${workspace.w.displayName}' has no ${KINDS[kind].label}.`,
        {
          operation: "change query target",
          entity: `workspace ${workspace.w.displayName}`,
          remediation: `Pick a workspace that contains a ${KINDS[kind].label}.`,
        },
      );
    }
    const chosen = await vscode.window.showQuickPick(choices, {
      placeHolder: `${KINDS[kind].label} to run ${relPath} against`,
      ignoreFocusOut: true,
    });
    if (chosen === undefined) {
      return undefined;
    }
    const properties = chosen.item["properties"];
    const queryServiceUri =
      typeof properties === "object" && properties !== null
        ? (properties as Record<string, unknown>)["queryServiceUri"]
        : undefined;
    const named: NamedItem = {
      id: chosen.item["id"] as string,
      displayName: chosen.label,
    };
    const binding: QueryBinding = {
      kind,
      tenantId,
      workspaceId: workspace.w.id,
      itemId: named.id,
      displayName: named.displayName,
      ...(typeof queryServiceUri === "string" ? { queryServiceUri } : {}),
    };
    await this.writeLocal(
      writeQueryBinding(await this.readLocal(), relPath, binding),
    );
    return binding;
  }

  private relPath(filePath: string): string {
    if (this.workspaceRoot === undefined) {
      throw new QueryError("Cannot run a query: no folder is open.", {
        operation: "run query",
        remediation: "Open your repo folder, then try again.",
      });
    }
    return path.relative(this.workspaceRoot, filePath);
  }

  private async readLocal(): Promise<string | undefined> {
    if (this.workspaceRoot === undefined) {
      return undefined;
    }
    try {
      return await fs.readFile(
        path.join(this.workspaceRoot, LOCAL_OVERRIDE_FILE),
        "utf8",
      );
    } catch {
      return undefined;
    }
  }

  private async writeLocal(text: string): Promise<void> {
    if (this.workspaceRoot === undefined) {
      return;
    }
    const file = path.join(this.workspaceRoot, LOCAL_OVERRIDE_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, "utf8");
  }
}
