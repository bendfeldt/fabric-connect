/**
 * Decides which Lakehouse hosts the Livy session for a piece of code, and
 * says why. The host matters beyond billing: relative paths (`Files/...`)
 * and unqualified table names resolve against it.
 *
 * Precedence (docs/plan-local-first.md, M0.4):
 *  1. A notebook's own default Lakehouse wins, in the workspace its
 *     metadata names (`default_lakehouse_workspace_id`, written when it is
 *     set as default). A mapped folder's target does not change that
 *     workspace (user feedback 2026-10-02); it only supplies the tenant.
 *  2. Anything without its own Lakehouse (a notebook with none attached, a
 *     plain .py/.sql file, a job) runs on the connected capacity's host
 *     Lakehouse; when none is picked yet, `HostLakehouseNeededError` lets
 *     the editor ask for one.
 *  3. Neither → a loud error naming both fixes. There is no silent default.
 *
 * The tenant comes from the folder's target, else the repo's sign-in, else
 * the compute profile.
 *
 * When a folder's target and the compute profile name different tenants,
 * running on compute is refused: that is the wrong-client failure mode.
 */

import { type ComputeProfile, hostOf } from "./computeProfile";
import {
  ComputeError,
  DefaultLakehouseUnboundError,
  FabricApiError,
  HostLakehouseNeededError,
} from "./errors";
import type { LivyTarget } from "./livySessionManager";
import type { LakehouseAttachment } from "./notebookCodec";
import type { IFabricApiClient, ResolvedTarget } from "./types";

export interface LivyHostInput {
  /** File or notebook name, for error messages. */
  readonly entity: string;
  readonly notebookDefault?: LakehouseAttachment;
  /**
   * The notebook declares a default Lakehouse whose IDs are placeholders
   * (not bound here; see `isUnboundId` in the notebook codec).
   */
  readonly unboundDefault?: { readonly name?: string };
  /** `notebookDefault` is this machine's binding, not the notebook's metadata. */
  readonly boundLocally?: boolean;
  /** Environment declared in the notebook's own metadata, if any. */
  readonly notebookEnvironment?: { id: string; workspaceId?: string };
  /** The folder's target, when the folder is mapped in targets.json. */
  readonly target?: ResolvedTarget;
  /** The tenant the repo is signed in to ('Fabric: Sign In'), if any. */
  readonly signedInTenant?: string;
  readonly compute?: ComputeProfile;
}

export interface LivyHost {
  readonly target: LivyTarget;
  readonly source: "notebook" | "compute";
  /** Human label: which Lakehouse, and why it was chosen. */
  readonly label: string;
}

export function resolveLivyHost(input: LivyHostInput): LivyHost {
  return checkedHost(resolveHost(input), input.entity);
}

function resolveHost(input: LivyHostInput): LivyHost {
  const { notebookDefault, target, compute } = input;

  if (notebookDefault === undefined && input.unboundDefault !== undefined) {
    // Running on the host Lakehouse instead would silently resolve the
    // notebook's Files/… paths and tables against the wrong Lakehouse.
    const name = input.unboundDefault.name;
    throw new DefaultLakehouseUnboundError(
      `Cannot run '${input.entity}': its default Lakehouse${name === undefined ? "" : ` '${name}'`} is not bound to a Lakehouse here. Fabric stores placeholder or logical IDs in git for attached Lakehouses.`,
      {
        operation: "resolve Livy host",
        entity: input.entity,
        remediation:
          name === undefined
            ? "In the Fabric side bar's Lakehouses view, attach a Lakehouse (or Set as Default) for this notebook; that writes its real IDs into the notebook."
            : `Click 'Bind Lakehouse…' to find '${name}' on the connected capacity, or Set as Default in the Lakehouses view; that writes its real IDs into the notebook.`,
        ...(name === undefined ? {} : { lakehouseName: name }),
      },
    );
  }

  if (notebookDefault !== undefined) {
    const workspaceId = notebookDefault.workspaceId;
    if (workspaceId === undefined) {
      throw new ComputeError(
        `Cannot run '${input.entity}': its default Lakehouse is known, but not which workspace it belongs to.`,
        {
          operation: "resolve Livy host",
          entity: input.entity,
          remediation:
            "In the Fabric side bar's Lakehouses view, click Set as Default on the notebook's default Lakehouse again; that writes its workspace into the notebook.",
        },
      );
    }
    const tenantId =
      target?.tenantId ?? input.signedInTenant ?? compute?.tenantId;
    if (tenantId === undefined) {
      throw new ComputeError(
        `Cannot run '${input.entity}': its default Lakehouse is known, but not which tenant it belongs to.`,
        {
          operation: "resolve Livy host",
          entity: input.entity,
          remediation:
            "Sign in with 'Fabric: Sign In' (or map this folder to a target in '.fabric/targets.json') so the tenant is known.",
        },
      );
    }
    const env = input.notebookEnvironment;
    const environmentId =
      env !== undefined &&
      (env.workspaceId === undefined ||
        env.workspaceId.toLowerCase() === workspaceId.toLowerCase())
        ? env.id
        : undefined;
    return {
      target: {
        tenantId,
        workspaceId,
        lakehouseId: notebookDefault.id,
        ...(environmentId === undefined ? {} : { environmentId }),
      },
      source: "notebook",
      label: input.boundLocally
        ? `${notebookDefault.name ?? "default Lakehouse"} (bound on this machine)`
        : `${notebookDefault.name ?? "default Lakehouse"} (notebook's default Lakehouse)`,
    };
  }

  if (compute === undefined) {
    throw new ComputeError(
      `Cannot run '${input.entity}': it has no Lakehouse of its own and this repo is not connected to Fabric compute.`,
      {
        operation: "resolve Livy host",
        entity: input.entity,
        remediation:
          "Run 'Fabric: Connect to Compute' to pick a capacity and host Lakehouse, or (for a notebook) attach a default Lakehouse with 'Fabric: Manage Lakehouses for Active Notebook'.",
      },
    );
  }
  if (
    target !== undefined &&
    target.tenantId.toLowerCase() !== compute.tenantId.toLowerCase()
  ) {
    throw new ComputeError(
      `Refusing to run '${input.entity}': its folder's target '${target.targetName}' belongs to a different tenant than the connected compute.`,
      {
        operation: "resolve Livy host",
        entity: input.entity,
        remediation:
          "Run 'Fabric: Connect to Compute' and pick compute in the target's tenant, or move the file out of that target's folder.",
      },
    );
  }
  const hosted = hostOf(compute);
  if (hosted === undefined) {
    throw new HostLakehouseNeededError(
      `Cannot run '${input.entity}': it has no Lakehouse of its own and no host Lakehouse is picked for the connected capacity.`,
      {
        operation: "resolve Livy host",
        entity: input.entity,
        remediation:
          "Pick a host Lakehouse ('Change Host Lakehouse…' in the Fabric side bar's Configuration), or (for a notebook) set a default Lakehouse in the Lakehouses view.",
      },
    );
  }
  return {
    target: {
      tenantId: hosted.tenantId,
      workspaceId: hosted.workspaceId,
      lakehouseId: hosted.lakehouseId,
      ...(hosted.environmentId === undefined
        ? {}
        : { environmentId: hosted.environmentId }),
    },
    source: "compute",
    label: `${hosted.lakehouseName ?? "host Lakehouse"} (connected capacity's host)`,
  };
}

/** What two reads found about a Livy host's workspace and Lakehouse. */
export interface HostProbe {
  readonly workspace: "found" | "missing" | "forbidden" | "unknown";
  /** The workspace's capacity, when the workspace was found. */
  readonly capacityId?: string;
  readonly lakehouse: "found" | "missing" | "unknown";
}

/**
 * Reads the host's workspace and Lakehouse (two GETs), to explain a failed
 * session start. Never throws: anything unexpected is "unknown".
 */
export async function probeLivyHost(
  api: IFabricApiClient,
  target: LivyTarget,
): Promise<HostProbe> {
  const status = (error: unknown) =>
    error instanceof FabricApiError ? error.status : undefined;
  let workspace: HostProbe["workspace"] = "unknown";
  let capacityId: string | undefined;
  try {
    const response = await api.request<{ capacityId?: unknown }>({
      method: "GET",
      path: `/workspaces/${target.workspaceId}`,
      tenantId: target.tenantId,
    });
    workspace = "found";
    if (typeof response.body?.capacityId === "string") {
      capacityId = response.body.capacityId;
    }
  } catch (error) {
    const code = status(error);
    workspace =
      code === 404
        ? "missing"
        : code === 401 || code === 403
          ? "forbidden"
          : "unknown";
  }
  let lakehouse: HostProbe["lakehouse"] = "unknown";
  if (workspace === "found") {
    try {
      await api.request({
        method: "GET",
        path: `/workspaces/${target.workspaceId}/lakehouses/${target.lakehouseId}`,
        tenantId: target.tenantId,
      });
      lakehouse = "found";
    } catch (error) {
      lakehouse = status(error) === 404 ? "missing" : "unknown";
    }
  }
  return {
    workspace,
    lakehouse,
    ...(capacityId === undefined ? {} : { capacityId }),
  };
}

/**
 * The likely reason a session could not start on this host, and the next
 * step; undefined when the probe found nothing wrong (or could not tell).
 */
export function diagnoseLivyHost(
  probe: HostProbe,
  source: LivyHost["source"],
): { readonly why: string; readonly next: string } | undefined {
  const fix =
    source === "notebook"
      ? "Set another default Lakehouse for the notebook in the Lakehouses view."
      : "Pick another host Lakehouse ('Change Host Lakehouse…' in Configuration).";
  if (probe.workspace === "missing" || probe.workspace === "forbidden") {
    return {
      why:
        source === "notebook"
          ? "the notebook's default Lakehouse is in a workspace that does not exist or that you cannot access (common for notebooks synced from another workspace)"
          : "the host Lakehouse's workspace does not exist or you cannot access it",
      next: fix,
    };
  }
  if (probe.workspace === "found" && probe.capacityId === undefined) {
    return {
      why: "the Lakehouse's workspace is not assigned to a Fabric capacity, so it cannot run Spark",
      next: `Assign the workspace to a capacity in the Fabric portal (workspace settings → License info), or: ${fix}`,
    };
  }
  if (probe.lakehouse === "missing") {
    return {
      why: "the Lakehouse no longer exists in that workspace",
      next: fix,
    };
  }
  return undefined;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_GUID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;

/** Last guard: never send a placeholder or malformed ID to Livy. */
function checkedHost(host: LivyHost, entity: string): LivyHost {
  for (const [field, id] of [
    ["workspace", host.target.workspaceId],
    ["Lakehouse", host.target.lakehouseId],
  ] as const) {
    if (!GUID.test(id) || NIL_GUID.test(id)) {
      throw new ComputeError(
        `Cannot run '${entity}': the ${field} ID of its Lakehouse (${host.label}) is a placeholder or not a GUID.`,
        {
          operation: "resolve Livy host",
          entity,
          remediation:
            host.source === "notebook"
              ? "Set a default Lakehouse for the notebook in the Lakehouses view."
              : "Pick a host Lakehouse again ('Change Host Lakehouse…' in Configuration).",
        },
      );
    }
  }
  return host;
}
