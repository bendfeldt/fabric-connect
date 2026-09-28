/**
 * "Connect to a SKU": picks capacity → workspace on it → host Lakehouse
 * (→ optional Environment), saves the result as the compute profile in the
 * gitignored `.fabric/local.json`, and shows it in the status bar — the way
 * Databricks Connect shows the cluster a project is attached to.
 *
 * Every pick comes from the API, never from free text, and a capacity that
 * is not running is refused loudly rather than saved and failing later.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  type ComputeProfile,
  describeCompute,
  readComputeProfile,
  writeComputeProfile,
} from "../core/computeProfile";
import { ComputeError } from "../core/errors";
import {
  type NamedItem,
  listCapacities,
  listEnvironments,
  listLakehouses,
  listWorkspaces,
} from "../core/fabricCatalog";
import { LOCAL_OVERRIDE_FILE } from "../core/targetResolver";
import type { IFabricApiClient } from "../core/types";

export class ComputeConnection implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private readonly changed = new vscode.EventEmitter<
    ComputeProfile | undefined
  >();
  /** Fires after the compute profile is saved or cleared. */
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly api: IFabricApiClient,
    private readonly workspaceRoot: string | undefined,
    private readonly promptTenantId: () => Promise<string | undefined>,
  ) {
    this.statusBar = vscode.window.createStatusBarItem(
      "fabric-connect.compute",
      vscode.StatusBarAlignment.Left,
      50,
    );
    this.statusBar.name = "Fabric Compute";
    this.statusBar.command = "fabric-connect.connectCompute";
  }

  dispose(): void {
    this.statusBar.dispose();
    this.changed.dispose();
  }

  /** The saved profile, or undefined when the repo is not connected. */
  async current(): Promise<ComputeProfile | undefined> {
    return readComputeProfile(await this.readLocal());
  }

  /** Shows the saved connection (or a "connect" prompt) in the status bar. */
  async refreshStatus(): Promise<void> {
    if (this.workspaceRoot === undefined) {
      this.statusBar.hide();
      setConnectedContext(false);
      return;
    }
    let profile: ComputeProfile | undefined;
    try {
      profile = await this.current();
    } catch (error) {
      setConnectedContext(false);
      this.statusBar.text = "$(warning) Fabric: invalid compute";
      this.statusBar.tooltip =
        error instanceof Error ? error.message : String(error);
      this.statusBar.show();
      return;
    }
    setConnectedContext(profile !== undefined);
    if (profile === undefined) {
      this.statusBar.text = "$(plug) Fabric: connect compute";
      this.statusBar.tooltip =
        "Not connected to Fabric compute. Click to pick a capacity, workspace and host Lakehouse.";
    } else {
      this.statusBar.text = `$(server-environment) Fabric: ${describeCompute(profile)}`;
      const environment =
        profile.environmentId === undefined
          ? "starter pool (no Environment)"
          : `Environment ${profile.environmentName ?? ""}`.trim();
      this.statusBar.tooltip = `Livy sessions for files without their own Lakehouse run on this Lakehouse, billed to this capacity, using the ${environment}. Click to change.`;
    }
    this.statusBar.show();
  }

  /** Walks through the pickers; `true` once a connection is saved. */
  async connect(): Promise<boolean> {
    const root = this.requireRoot();
    const tenantId = await this.promptTenantId();
    if (tenantId === undefined) {
      return false;
    }

    const capacities = await listCapacities(this.api, tenantId);
    if (capacities.length === 0) {
      throw new ComputeError(
        "No Fabric capacities are visible to your account in this tenant.",
        {
          operation: "connect to compute",
          entity: `tenant ${tenantId}`,
          remediation:
            "Ask a capacity admin to grant you contributor rights on a capacity, or sign in to the tenant that owns it.",
        },
      );
    }
    const capacity = await pick(
      capacities.map((c) => ({
        label: c.displayName,
        description: [c.sku, c.region].filter(Boolean).join(" · "),
        detail: c.state === "Active" ? undefined : `State: ${c.state}`,
        value: c,
      })),
      "Pick the capacity (SKU) to run on",
    );
    if (capacity === undefined) {
      return false;
    }
    if (capacity.state !== "Active") {
      throw new ComputeError(
        `Capacity '${capacity.displayName}' is ${capacity.state}, so it cannot run Spark.`,
        {
          operation: "connect to compute",
          entity: `capacity ${capacity.displayName}`,
          remediation:
            "Resume the capacity in the Azure portal (or ask its admin), then connect again.",
        },
      );
    }

    const workspaces = await listWorkspaces(this.api, tenantId, capacity.id);
    if (workspaces.length === 0) {
      throw new ComputeError(
        `No workspaces you can access are assigned to capacity '${capacity.displayName}'.`,
        {
          operation: "connect to compute",
          entity: `capacity ${capacity.displayName}`,
          remediation:
            "Assign a workspace to this capacity in the Fabric portal (workspace settings → License info), or pick another capacity.",
        },
      );
    }
    const workspace = await pick(
      workspaces.map((w) => ({ label: w.displayName, value: w })),
      `Pick a workspace on ${capacity.displayName}`,
    );
    if (workspace === undefined) {
      return false;
    }

    const lakehouse = await this.pickLakehouse(tenantId, workspace);
    if (lakehouse === undefined) {
      return false;
    }

    const environments = await listEnvironments(
      this.api,
      tenantId,
      workspace.id,
    );
    let environment: NamedItem | undefined;
    if (environments.length > 0) {
      const none = { id: "", displayName: "" };
      const chosen = await pick(
        [
          {
            label: "No Environment",
            description: "workspace starter pool",
            value: none,
          },
          ...environments.map((e) => ({ label: e.displayName, value: e })),
        ],
        "Pick an Environment (libraries and Spark settings), or none",
      );
      if (chosen === undefined) {
        return false;
      }
      environment = chosen.id === "" ? undefined : chosen;
    }

    const profile: ComputeProfile = {
      tenantId,
      capacityId: capacity.id,
      capacityName: capacity.displayName,
      sku: capacity.sku,
      workspaceId: workspace.id,
      workspaceName: workspace.displayName,
      lakehouseId: lakehouse.id,
      lakehouseName: lakehouse.displayName,
      ...(environment === undefined
        ? {}
        : {
            environmentId: environment.id,
            environmentName: environment.displayName,
          }),
    };
    await this.save(root, profile);
    void vscode.window.showInformationMessage(
      `Connected to Fabric compute: ${describeCompute(profile)}.`,
    );
    await this.warnIfNotIgnored(root);
    return true;
  }

  async disconnect(): Promise<void> {
    const root = this.requireRoot();
    if ((await this.current()) === undefined) {
      void vscode.window.showInformationMessage(
        "This repo is not connected to Fabric compute.",
      );
      return;
    }
    await this.save(root, undefined);
    void vscode.window.showInformationMessage(
      "Disconnected from Fabric compute. Running Livy sessions keep running until stopped or idle.",
    );
  }

  /**
   * Picks an existing Lakehouse. The extension never creates one (decision
   * D3): Lakehouses are infrastructure, provisioned outside Fabric Connect.
   */
  private async pickLakehouse(
    tenantId: string,
    workspace: { id: string; displayName: string },
  ): Promise<NamedItem | undefined> {
    const lakehouses = await listLakehouses(this.api, tenantId, workspace.id);
    if (lakehouses.length === 0) {
      throw new ComputeError(
        `Workspace '${workspace.displayName}' has no Lakehouse to host Spark sessions.`,
        {
          operation: "connect to compute",
          entity: `workspace ${workspace.displayName}`,
          remediation:
            "Create a Lakehouse in the Fabric portal (or through your infrastructure tooling), then run 'Fabric: Connect to Compute' again — Fabric Connect never creates items.",
        },
      );
    }
    return pick(
      lakehouses.map((l) => ({ label: l.displayName, value: l })),
      `Pick the Lakehouse that hosts Spark sessions in ${workspace.displayName}`,
    );
  }

  private async save(
    root: string,
    profile: ComputeProfile | undefined,
  ): Promise<void> {
    const file = path.join(root, LOCAL_OVERRIDE_FILE);
    const text = writeComputeProfile(await this.readLocal(), profile);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, "utf8");
    this.changed.fire(profile);
    await this.refreshStatus();
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

  /** local.json names client capacities and workspaces: it must stay out of git. */
  private async warnIfNotIgnored(root: string): Promise<void> {
    let gitignore = "";
    try {
      gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    } catch {
      // No .gitignore at the root: warn below.
    }
    const ignored = gitignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) =>
        [
          ".fabric/local.json",
          "/.fabric/local.json",
          ".fabric/",
          ".fabric",
        ].includes(line),
      );
    if (!ignored) {
      void vscode.window.showWarningMessage(
        `'${LOCAL_OVERRIDE_FILE}' does not appear in your root .gitignore. It identifies client capacities and workspaces — add it before committing.`,
      );
    }
  }

  private requireRoot(): string {
    if (this.workspaceRoot === undefined) {
      throw new ComputeError(
        "Cannot connect to compute: no folder is open in VS Code.",
        {
          operation: "connect to compute",
          remediation:
            "Open your repo folder (File → Open Folder), then run 'Fabric: Connect to Compute' again.",
        },
      );
    }
    return this.workspaceRoot;
  }
}

async function pick<T>(
  items: Array<vscode.QuickPickItem & { value: T }>,
  placeHolder: string,
): Promise<T | undefined> {
  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder,
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
  return chosen?.value;
}

/** Lets the walkthrough tick its "connect compute" step on success. */
function setConnectedContext(connected: boolean): void {
  void vscode.commands.executeCommand(
    "setContext",
    "fabricConnect.computeConnected",
    connected,
  );
}
