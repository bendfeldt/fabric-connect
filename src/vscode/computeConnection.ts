/**
 * Selects the workspace, Lakehouse and optional Environment that host code
 * without a Lakehouse of its own. Capacity metadata is derived from the
 * workspace for display and validation; it is never an execution target.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  type ComputeProfile,
  type HostedCompute,
  describeCompute,
  hostOf,
  isValidCapacityLabel,
  readComputeProfile,
  writeComputeProfile,
} from "../core/computeProfile";
import { ComputeError, HostLakehouseNeededError } from "../core/errors";
import {
  type CapacityInfo,
  type NamedItem,
  listEnvironments,
  listLakehouses,
  isPlaceholderName,
  listUsableCapacities,
} from "../core/fabricCatalog";
import { LOCAL_OVERRIDE_FILE } from "../core/targetResolver";
import type { IFabricApiClient } from "../core/types";

export class ComputeConnection implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  /** Why listing capacities failed in this window, if it did. */
  private listError: string | undefined;
  private pendingSave: Promise<void> = Promise.resolve();
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
    this.statusBar.name = "Fabric Execution Host";
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

  /** The execution host's derived capacity ID, if a complete host is saved. */
  async connectedCapacityId(): Promise<string | undefined> {
    const profile = await this.current();
    return profile === undefined ? undefined : hostOf(profile)?.capacityId;
  }

  /** Shows the saved execution host or a prompt to select one. */
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
      this.statusBar.text = "$(warning) Fabric: invalid execution host";
      this.statusBar.tooltip =
        error instanceof Error ? error.message : String(error);
      this.statusBar.show();
      return;
    }
    const hosted = profile === undefined ? undefined : hostOf(profile);
    setConnectedContext(hosted !== undefined);
    if (hosted === undefined) {
      this.statusBar.text = "$(plug) Fabric: select execution host";
      this.statusBar.tooltip =
        "Code without its own Lakehouse needs an execution host. Click to select a workspace and Lakehouse.";
    } else {
      this.statusBar.text = `$(server-environment) Fabric: ${describeCompute(hosted)}`;
      const environment =
        hosted.environmentId === undefined
          ? "starter pool (no Environment)"
          : `Environment ${hosted.environmentName ?? ""}`.trim();
      this.statusBar.tooltip = `Code without its own Lakehouse runs on this host Lakehouse, billed to its workspace capacity, using the ${environment}. Click to change the execution host.`;
    }
    this.statusBar.show();
  }

  /** Selects and saves a complete execution host. */
  async connect(_capacity?: CapacityInfo): Promise<boolean> {
    const root = this.requireRoot();
    const tenantId = await this.promptTenantId();
    if (tenantId === undefined) {
      return false;
    }
    const profile = await this.pickHost(tenantId);
    if (profile === undefined) {
      return false;
    }
    await this.save(root, profile);
    void vscode.window.showInformationMessage(
      `Execution host set: ${describeCompute(profile)}.`,
    );
    await warnIfLocalFileNotIgnored(root);
    return true;
  }

  /** Compatibility alias: a capacity argument no longer constrains the host. */
  async selectCapacity(capacity?: CapacityInfo): Promise<void> {
    await this.connect(capacity);
  }

  /**
   * Replaces a saved `Capacity <id prefix>` name with the real one when a
   * capacity listing now has it (e.g. via Power BI). Quiet: does nothing
   * when the user named the capacity, when nothing better is found, or on
   * any error (the reason is kept for the Configuration tooltip).
   */
  async refreshCapacityName(tenantId: string | undefined): Promise<void> {
    if (this.workspaceRoot === undefined || tenantId === undefined) {
      return;
    }
    let profile: ComputeProfile | undefined;
    try {
      profile = await this.current();
    } catch {
      return;
    }
    if (
      profile === undefined ||
      profile.capacityLabel !== undefined ||
      profile.tenantId.toLowerCase() !== tenantId.toLowerCase() ||
      (profile.capacityName !== undefined &&
        !isPlaceholderName({
          id: profile.capacityId,
          displayName: profile.capacityName,
        }))
    ) {
      return;
    }
    const connectedTenantId = profile.tenantId.toLowerCase();
    const connectedCapacityId = profile.capacityId.toLowerCase();
    try {
      const { capacities, listError } = await listUsableCapacities(
        this.api,
        tenantId,
      );
      const found = capacities.find(
        (c) => c.id.toLowerCase() === connectedCapacityId,
      );
      await this.save(this.workspaceRoot, (current) => {
        if (
          current === undefined ||
          current.tenantId.toLowerCase() !== connectedTenantId ||
          current.capacityId.toLowerCase() !== connectedCapacityId ||
          current.capacityLabel !== undefined ||
          (current.capacityName !== undefined &&
            !isPlaceholderName({
              id: current.capacityId,
              displayName: current.capacityName,
            }))
        ) {
          return current;
        }
        this.listError = listError;
        if (found === undefined || isPlaceholderName(found)) {
          this.changed.fire(current); // the tooltip can now say why
          return current;
        }
        return {
          ...current,
          capacityName: found.displayName,
          ...(found.sku === "" ? {} : { sku: found.sku }),
        };
      });
    } catch {
      // Offline or signed out: keep the saved name.
    }
  }

  /**
   * Why the execution host capacity's real name may be missing: the error from
   * listing capacities in this window, else the usual reason.
   */
  nameHiddenReason(profile: ComputeProfile): string | undefined {
    if (
      profile.capacityName === undefined ||
      !isPlaceholderName({
        id: profile.capacityId,
        displayName: profile.capacityName,
      })
    ) {
      return undefined;
    }
    return this.listError === undefined
      ? "Its name is only visible with rights on the capacity itself (admin or contributor); workspace members do not get it from Fabric's APIs."
      : `Listing capacities failed: ${this.listError.split(" Next step:")[0]}`;
  }

  /**
   * Gives the execution host capacity a name of your choosing, saved in the
   * gitignored local.json and shown instead of `Capacity <id prefix>`.
   * An empty name removes it.
   */
  async nameCapacity(): Promise<void> {
    const root = this.requireRoot("name the capacity");
    const profile = await this.current();
    if (profile === undefined || hostOf(profile) === undefined) {
      void vscode.window.showInformationMessage(
        "Select an execution host first, then name its capacity.",
      );
      return;
    }
    const value = await vscode.window.showInputBox({
      title: "Name this capacity",
      prompt:
        "Shown instead of the capacity's ID prefix (saved in your gitignored .fabric/local.json). Leave empty to remove.",
      value: profile.capacityLabel ?? "",
      ignoreFocusOut: true,
      validateInput: (text) =>
        text.trim().length === 0 || isValidCapacityLabel(text)
          ? undefined
          : "At most 100 characters",
    });
    if (value === undefined) {
      return;
    }
    const { capacityLabel: _old, ...rest } = profile;
    await this.save(
      root,
      value.trim().length === 0
        ? rest
        : { ...rest, capacityLabel: value.trim() },
    );
  }

  async disconnect(): Promise<void> {
    const root = this.requireRoot();
    if ((await this.current()) === undefined) {
      void vscode.window.showInformationMessage(
        "This repo has no Fabric execution host.",
      );
      return;
    }
    await this.save(root, undefined);
    void vscode.window.showInformationMessage(
      "Disconnected the Fabric execution host. Running Livy sessions keep running until stopped or idle.",
    );
  }

  /**
   * Resolves something that may need the host Lakehouse; when it does and
   * none is picked yet, asks for one (connecting first if needed) and
   * resolves again.
   */
  async runWithHost<T>(resolve: () => Promise<T>): Promise<T> {
    try {
      return await resolve();
    } catch (error) {
      if (!(error instanceof HostLakehouseNeededError)) {
        throw error;
      }
      await this.requireHost();
      return resolve();
    }
  }

  /** The saved execution host, asking for one when missing. */
  async requireHost(): Promise<HostedCompute> {
    const current = await this.current();
    const hosted = current === undefined ? undefined : hostOf(current);
    if (hosted !== undefined) {
      return hosted;
    }
    if (!(await this.connect())) {
      throw hostNotPicked("no execution host was picked");
    }
    const selected = await this.current();
    const result = selected === undefined ? undefined : hostOf(selected);
    if (result === undefined) {
      throw hostNotPicked("no execution host was picked");
    }
    return result;
  }

  /** Compatibility alias for selecting a complete execution host. */
  async changeHost(): Promise<void> {
    await this.connect();
  }

  /**
   * Selects a workspace, Lakehouse and optional Environment, then returns a
   * complete profile with capacity metadata derived from the workspace.
   */
  private async pickHost(
    tenantId: string,
  ): Promise<ComputeProfile | undefined> {
    const { capacities, workspaces, listError } = await listUsableCapacities(
      this.api,
      tenantId,
    );
    this.listError = listError;
    if (workspaces.length === 0) {
      throw new ComputeError(
        "No Fabric workspaces are accessible in this tenant.",
        {
          operation: "pick host Lakehouse",
          entity: `tenant ${tenantId}`,
          remediation:
            "Ask a workspace admin for access, or sign in to the tenant that owns the workspace.",
        },
      );
    }

    const workspace = await pick(
      [...workspaces]
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .map((value) => {
          const capacity = capacities.find(
            (item) =>
              value.capacityId !== undefined &&
              item.id.toLowerCase() === value.capacityId.toLowerCase(),
          );
          return {
            label: value.displayName,
            description:
              capacity === undefined
                ? "no capacity"
                : [capacity.displayName, capacity.sku, capacity.state]
                    .filter(Boolean)
                    .join(" · "),
            value,
          };
        }),
      "Pick the workspace that contains the host Lakehouse",
    );
    if (workspace === undefined) {
      return undefined;
    }

    const capacity = capacities.find(
      (item) =>
        workspace.capacityId !== undefined &&
        item.id.toLowerCase() === workspace.capacityId.toLowerCase(),
    );
    if (capacity === undefined) {
      throw new ComputeError(
        `Workspace '${workspace.displayName}' is not assigned to a Fabric capacity.`,
        {
          operation: "pick host Lakehouse",
          entity: `workspace ${workspace.displayName}`,
          remediation:
            "Assign the workspace to a capacity in Fabric workspace settings, then try again.",
        },
      );
    }
    if (capacity.state !== "Active" && capacity.state !== "Unknown") {
      throw new ComputeError(
        `Capacity '${capacity.displayName}' is ${capacity.state}, so it cannot run Spark.`,
        {
          operation: "pick host Lakehouse",
          entity: `capacity ${capacity.displayName}`,
          remediation:
            "Resume the capacity in the Azure portal (or ask its admin), then try again.",
        },
      );
    }

    const lakehouses = await listLakehouses(this.api, tenantId, workspace.id);
    if (lakehouses.length === 0) {
      throw new ComputeError(
        `Workspace '${workspace.displayName}' has no Lakehouse to host Spark sessions.`,
        {
          operation: "pick host Lakehouse",
          entity: `workspace ${workspace.displayName}`,
          remediation:
            "Create a Lakehouse in the Fabric portal (or through your infrastructure tooling), then try again — Fabric Connect never creates items.",
        },
      );
    }
    const lakehouse = await pick(
      [...lakehouses]
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .map((value) => ({ label: value.displayName, value })),
      `Pick a host Lakehouse in ${workspace.displayName}`,
    );
    if (lakehouse === undefined) {
      return undefined;
    }

    const environments = await listEnvironments(
      this.api,
      tenantId,
      workspace.id,
    );
    let environment: NamedItem | undefined;
    if (environments.length > 0) {
      const none = { id: "", displayName: "" };
      const selected = await pick(
        [
          {
            label: "No Environment",
            description: "workspace starter pool",
            value: none,
          },
          ...environments.map((value) => ({
            label: value.displayName,
            value,
          })),
        ],
        "Pick an Environment (libraries and Spark settings), or none",
      );
      if (selected === undefined) {
        return undefined;
      }
      environment = selected.id === "" ? undefined : selected;
    }

    let previous: ComputeProfile | undefined;
    try {
      previous = await this.current();
    } catch {
      // A valid selection replaces an invalid legacy section.
    }
    const sameCapacity =
      previous !== undefined &&
      previous.tenantId.toLowerCase() === tenantId.toLowerCase() &&
      previous.capacityId.toLowerCase() === capacity.id.toLowerCase();
    return {
      tenantId,
      capacityId: capacity.id,
      capacityName: capacity.displayName,
      ...(capacity.sku === "" ? {} : { sku: capacity.sku }),
      ...(sameCapacity && previous?.capacityLabel !== undefined
        ? { capacityLabel: previous.capacityLabel }
        : {}),
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
  }

  private save(
    root: string,
    profile:
      | ComputeProfile
      | undefined
      | ((current: ComputeProfile | undefined) => ComputeProfile | undefined),
  ): Promise<void> {
    const write = async (): Promise<void> => {
      const local = await this.readLocal();
      const current =
        typeof profile === "function" ? readComputeProfile(local) : undefined;
      const updated =
        typeof profile === "function" ? profile(current) : profile;
      if (typeof profile === "function" && updated === current) {
        return;
      }
      const file = path.join(root, LOCAL_OVERRIDE_FILE);
      const text = writeComputeProfile(local, updated);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text, "utf8");
      this.changed.fire(updated);
      await this.refreshStatus();
    };
    // Serialize writes; each caller still receives its own save failure.
    this.pendingSave = this.pendingSave.then(write, write);
    return this.pendingSave;
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

  private requireRoot(operation = "select execution host"): string {
    if (this.workspaceRoot === undefined) {
      throw new ComputeError(
        `Cannot ${operation}: no folder is open in VS Code.`,
        {
          operation,
          remediation:
            "Open your repo folder (File → Open Folder), then try again.",
        },
      );
    }
    return this.workspaceRoot;
  }
}

/** local.json names client capacities and workspaces: it must stay out of git. */
export async function warnIfLocalFileNotIgnored(root: string): Promise<void> {
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

function hostNotPicked(why: string): ComputeError {
  return new ComputeError(
    `Cannot run code without its own Lakehouse: ${why}.`,
    {
      operation: "pick host Lakehouse",
      remediation:
        "Run it again to select an execution host, or (for a notebook) set a default Lakehouse in the Lakehouses view.",
    },
  );
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

/** Lets the walkthrough tick its execution-host step on success. */
function setConnectedContext(connected: boolean): void {
  void vscode.commands.executeCommand(
    "setContext",
    "fabricConnect.computeConnected",
    connected,
  );
}
