/**
 * "Connect to a SKU": connecting picks only the capacity (the SKU that is
 * billed) and saves it as the compute profile in the gitignored
 * `.fabric/local.json`, shown in the status bar — the way Databricks
 * Connect shows the cluster a project is attached to.
 *
 * Code without a Lakehouse of its own still needs a host Lakehouse for its
 * Livy session (Livy only starts sessions on a Lakehouse). That host is a
 * Lakehouse in one of the capacity's workspaces, asked the first time such
 * code runs (`runWithHost`) or changed with 'Change Host Lakehouse…', and
 * saved with the profile.
 *
 * Capacities come from the user's workspaces (see
 * `capacitiesFromWorkspaces`), so workspace members who cannot list
 * capacities can still connect. Every pick comes from the API, never from
 * free text, and a capacity that is known not to be running is refused
 * loudly rather than saved and failing later.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  type ComputeProfile,
  type HostedCompute,
  capacityDisplayName,
  describeCompute,
  hostOf,
  isValidCapacityLabel,
  readComputeProfile,
  withoutHost,
  writeComputeProfile,
} from "../core/computeProfile";
import { ComputeError, HostLakehouseNeededError } from "../core/errors";
import {
  type CapacityInfo,
  type NamedItem,
  type WorkspaceInfo,
  listEnvironments,
  listLakehouses,
  isPlaceholderName,
  listUsableCapacities,
  listWorkspaces,
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

  /** The connected capacity's ID, if any. */
  async connectedCapacityId(): Promise<string | undefined> {
    return (await this.current())?.capacityId;
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
        "Not connected to a Fabric capacity. Click to pick one.";
    } else {
      this.statusBar.text = `$(server-environment) Fabric: ${describeCompute(profile)}`;
      const hosted = hostOf(profile);
      const environment =
        hosted?.environmentId === undefined
          ? "starter pool (no Environment)"
          : `Environment ${hosted.environmentName ?? ""}`.trim();
      this.statusBar.tooltip =
        hosted === undefined
          ? "Connected to this capacity. Code without its own Lakehouse asks for a host Lakehouse the first time it runs. Click to change the capacity."
          : `Code without its own Lakehouse runs on this host Lakehouse, billed to this capacity, using the ${environment}. Click to change the capacity.`;
    }
    this.statusBar.show();
  }

  /**
   * Connects the repo to a capacity (picked when not given). A host
   * Lakehouse already saved on the same capacity is kept; one on another
   * capacity is dropped. `true` once saved.
   */
  async connect(capacity?: CapacityInfo): Promise<boolean> {
    const root = this.requireRoot();
    const tenantId = await this.promptTenantId();
    if (tenantId === undefined) {
      return false;
    }
    if (capacity === undefined) {
      const { capacities, listError } = await listUsableCapacities(
        this.api,
        tenantId,
      );
      this.listError = listError;
      capacity = await this.pickCapacity(capacities, tenantId);
      if (capacity === undefined) {
        return false;
      }
    }
    // "Unknown" means the user may not see the state, not that it is paused.
    if (capacity.state !== "Active" && capacity.state !== "Unknown") {
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

    let previous: ComputeProfile | undefined;
    try {
      previous = await this.current();
    } catch {
      // An invalid section is replaced by the new connection.
    }
    const sameCapacity =
      previous !== undefined &&
      previous.tenantId.toLowerCase() === tenantId.toLowerCase() &&
      previous.capacityId.toLowerCase() === capacity.id.toLowerCase();
    const keptHost =
      sameCapacity && previous !== undefined ? hostOf(previous) : undefined;
    const profile: ComputeProfile = {
      tenantId,
      capacityId: capacity.id,
      capacityName: capacity.displayName,
      ...(capacity.sku === "" ? {} : { sku: capacity.sku }),
      // A name the user gave this capacity survives reconnecting to it.
      ...(sameCapacity && previous?.capacityLabel !== undefined
        ? { capacityLabel: previous.capacityLabel }
        : {}),
      ...(keptHost === undefined ? {} : hostFields(keptHost)),
    };
    await this.save(root, profile);
    const droppedHost =
      previous !== undefined && !sameCapacity && hostOf(previous) !== undefined;
    void vscode.window.showInformationMessage(
      droppedHost
        ? `Connected to capacity ${describeCompute(profile)}. The host Lakehouse of the previous capacity was dropped; code without its own Lakehouse asks for one on this capacity.`
        : `Connected to capacity ${describeCompute(profile)}.`,
    );
    await warnIfLocalFileNotIgnored(root);
    return true;
  }

  /** Explorer's Fabric view: connect to the clicked capacity. */
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
   * Why the connected capacity's real name may be missing: the error from
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
   * Gives the connected capacity a name of your choosing, saved in the
   * gitignored local.json and shown instead of `Capacity <id prefix>`.
   * An empty name removes it.
   */
  async nameCapacity(): Promise<void> {
    const root = this.requireRoot("name the capacity");
    const profile = await this.current();
    if (profile === undefined) {
      void vscode.window.showInformationMessage(
        "Connect to a capacity first, then name it.",
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

  /** The profile with its host Lakehouse, asking for one when missing. */
  async requireHost(): Promise<HostedCompute> {
    let profile = await this.current();
    if (profile === undefined) {
      if (!(await this.connect())) {
        throw hostNotPicked("no capacity was connected");
      }
      profile = await this.current();
    }
    const hosted = profile === undefined ? undefined : hostOf(profile);
    if (hosted !== undefined) {
      return hosted;
    }
    const picked = profile === undefined ? false : await this.pickHost(profile);
    const now = picked ? await this.current() : undefined;
    const result = now === undefined ? undefined : hostOf(now);
    if (result === undefined) {
      throw hostNotPicked("no host Lakehouse was picked");
    }
    return result;
  }

  /** Picks (or re-picks) the host Lakehouse of the connected capacity. */
  async changeHost(): Promise<void> {
    let profile = await this.current();
    if (profile === undefined) {
      if (!(await this.connect())) {
        return;
      }
      profile = await this.current();
    }
    if (profile !== undefined && (await this.pickHost(profile))) {
      const now = await this.current();
      if (now !== undefined) {
        void vscode.window.showInformationMessage(
          `Host Lakehouse set: ${describeCompute(now)}.`,
        );
      }
    }
  }

  /**
   * Asks for a Lakehouse in one of the capacity's workspaces (grouped by
   * workspace), then an optional Environment, and saves them as the host.
   * Never creates a Lakehouse (decision D3). `false` when cancelled.
   */
  private async pickHost(profile: ComputeProfile): Promise<boolean> {
    const root = this.requireRoot("pick a host Lakehouse");
    const capacityName =
      capacityDisplayName(profile) ?? "the connected capacity";
    const workspaces = await listWorkspaces(
      this.api,
      profile.tenantId,
      profile.capacityId,
    );
    if (workspaces.length === 0) {
      throw new ComputeError(
        `No workspaces you can access are assigned to capacity '${capacityName}'.`,
        {
          operation: "pick host Lakehouse",
          entity: `capacity ${capacityName}`,
          remediation:
            "Assign a workspace to this capacity in the Fabric portal (workspace settings → License info), or connect another capacity.",
        },
      );
    }
    const choices = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Listing Lakehouses on ${capacityName}…`,
      },
      () => this.lakehouseChoices(profile.tenantId, workspaces),
    );
    if (!choices.some((c) => c.value !== undefined)) {
      throw new ComputeError(
        `No workspace on capacity '${capacityName}' has a Lakehouse to host Spark sessions.`,
        {
          operation: "pick host Lakehouse",
          entity: `capacity ${capacityName}`,
          remediation:
            "Create a Lakehouse in one of its workspaces in the Fabric portal (or through your infrastructure tooling), then try again — Fabric Connect never creates items.",
        },
      );
    }
    const chosen = await vscode.window.showQuickPick(choices, {
      title: `Host Lakehouse on ${capacityName}`,
      placeHolder:
        "Code without its own Lakehouse runs on this Lakehouse's Spark session",
      matchOnDescription: true,
      ignoreFocusOut: true,
    });
    if (chosen?.value === undefined) {
      return false;
    }
    const { workspace, lakehouse } = chosen.value;

    const environments = await listEnvironments(
      this.api,
      profile.tenantId,
      workspace.id,
    );
    let environment: NamedItem | undefined;
    if (environments.length > 0) {
      const none = { id: "", displayName: "" };
      const env = await pick(
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
      if (env === undefined) {
        return false;
      }
      environment = env.id === "" ? undefined : env;
    }

    await this.save(root, {
      ...withoutHost(profile),
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
    });
    return true;
  }

  /** Quick-pick rows: a separator per workspace, then its Lakehouses. */
  private async lakehouseChoices(
    tenantId: string,
    workspaces: WorkspaceInfo[],
  ): Promise<
    Array<
      vscode.QuickPickItem & {
        value?: { workspace: WorkspaceInfo; lakehouse: NamedItem };
      }
    >
  > {
    const sorted = [...workspaces].sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
    const lists = await Promise.all(
      sorted.map((w) => listLakehouses(this.api, tenantId, w.id)),
    );
    return sorted.flatMap((workspace, i) =>
      lists[i].length === 0
        ? []
        : [
            {
              label: workspace.displayName,
              kind: vscode.QuickPickItemKind.Separator,
            },
            ...lists[i]
              .sort((a, b) => a.displayName.localeCompare(b.displayName))
              .map((lakehouse) => ({
                label: lakehouse.displayName,
                description: workspace.displayName,
                value: { workspace, lakehouse },
              })),
          ],
    );
  }

  /** The connected capacity is listed first; "Unknown" ones say why. */
  private async pickCapacity(
    capacities: CapacityInfo[],
    tenantId: string,
  ): Promise<CapacityInfo | undefined> {
    if (capacities.length === 0) {
      throw new ComputeError(
        "None of the workspaces your account can access in this tenant runs on a Fabric capacity.",
        {
          operation: "connect to compute",
          entity: `tenant ${tenantId}`,
          remediation:
            "Ask a workspace admin to give you access to a workspace on a Fabric capacity, or sign in to the tenant that owns it.",
        },
      );
    }
    let connected: string | undefined;
    try {
      connected = (await this.connectedCapacityId())?.toLowerCase();
    } catch {
      // An invalid section marks nothing as connected.
    }
    const isConnected = (c: CapacityInfo) => c.id.toLowerCase() === connected;
    const ordered = [
      ...capacities.filter(isConnected),
      ...capacities.filter((c) => !isConnected(c)),
    ];
    return pick(
      ordered.map((c) => ({
        label: isConnected(c) ? `$(check) ${c.displayName}` : c.displayName,
        description: [c.sku, c.region, isConnected(c) ? "connected" : ""]
          .filter(Boolean)
          .join(" · "),
        detail:
          c.state === "Active"
            ? undefined
            : c.state === "Unknown"
              ? "SKU and state not visible to you (no rights on the capacity itself)"
              : `State: ${c.state}`,
        value: c,
      })),
      "Pick the capacity (SKU) to run on",
    );
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

  private requireRoot(operation = "connect to compute"): string {
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

/** Only the host Lakehouse (and Environment) keys of a hosted profile. */
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

function hostFields(hosted: HostedCompute): Partial<ComputeProfile> {
  const keys = [
    "workspaceId",
    "workspaceName",
    "lakehouseId",
    "lakehouseName",
    "environmentId",
    "environmentName",
  ] as const;
  return Object.fromEntries(
    keys.flatMap((key) =>
      hosted[key] === undefined ? [] : [[key, hosted[key]]],
    ),
  );
}

function hostNotPicked(why: string): ComputeError {
  return new ComputeError(
    `Cannot run code without its own Lakehouse: ${why}.`,
    {
      operation: "pick host Lakehouse",
      remediation:
        "Run it again and pick a host Lakehouse, use 'Change Host Lakehouse…' in the Fabric side bar's Configuration, or (for a notebook) set a default Lakehouse in the Lakehouses view.",
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

/** Lets the walkthrough tick its "connect compute" step on success. */
function setConnectedContext(connected: boolean): void {
  void vscode.commands.executeCommand(
    "setContext",
    "fabricConnect.computeConnected",
    connected,
  );
}
