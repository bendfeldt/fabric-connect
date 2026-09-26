/**
 * Decides which Lakehouse hosts the Livy session for a piece of code, and
 * says why. The host matters beyond billing: relative paths (`Files/...`)
 * and unqualified table names resolve against it.
 *
 * Precedence (docs/plan-local-first.md, M0.4):
 *  1. A notebook's own default Lakehouse wins. Its workspace comes from the
 *     folder's target when mapped (so the same repo can point at dev or
 *     prod), otherwise from the notebook metadata.
 *  2. Anything without its own Lakehouse (a notebook with none attached, a
 *     plain .py/.sql file, a job) runs on the connected compute profile.
 *  3. Neither → a loud error naming both fixes. There is no silent default.
 *
 * When a folder's target and the compute profile name different tenants,
 * running on compute is refused: that is the wrong-client failure mode.
 */

import type { ComputeProfile } from "./computeProfile";
import { ComputeError } from "./errors";
import type { LivyTarget } from "./livySessionManager";
import type { LakehouseAttachment } from "./notebookCodec";
import type { ResolvedTarget } from "./types";

export interface LivyHostInput {
  /** File or notebook name, for error messages. */
  readonly entity: string;
  readonly notebookDefault?: LakehouseAttachment;
  /** Environment declared in the notebook's own metadata, if any. */
  readonly notebookEnvironment?: { id: string; workspaceId?: string };
  /** The folder's target, when the folder is mapped in targets.json. */
  readonly target?: ResolvedTarget;
  readonly compute?: ComputeProfile;
}

export interface LivyHost {
  readonly target: LivyTarget;
  readonly source: "notebook" | "compute";
  /** Human label: which Lakehouse, and why it was chosen. */
  readonly label: string;
}

export function resolveLivyHost(input: LivyHostInput): LivyHost {
  const { notebookDefault, target, compute } = input;

  if (notebookDefault !== undefined) {
    const workspaceId = target?.workspaceId ?? notebookDefault.workspaceId;
    const tenantId = target?.tenantId ?? compute?.tenantId;
    if (workspaceId === undefined || tenantId === undefined) {
      throw new ComputeError(
        `Cannot run '${input.entity}': its default Lakehouse is known, but not which ${workspaceId === undefined ? "workspace" : "tenant"} it belongs to.`,
        {
          operation: "resolve Livy host",
          entity: input.entity,
          remediation:
            "Map this folder to a target in '.fabric/targets.json' (with its workspace in '.fabric/local.json'), or run 'Fabric: Connect to Compute' so the tenant is known.",
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
      label: `${notebookDefault.name ?? "default Lakehouse"} (notebook's default Lakehouse)`,
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
  return {
    target: {
      tenantId: compute.tenantId,
      workspaceId: compute.workspaceId,
      lakehouseId: compute.lakehouseId,
      ...(compute.environmentId === undefined
        ? {}
        : { environmentId: compute.environmentId }),
    },
    source: "compute",
    label: `${compute.lakehouseName ?? "compute Lakehouse"} (connected compute)`,
  };
}
