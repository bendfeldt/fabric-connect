/**
 * Local-first write policy: the extension never deploys. Every non-GET
 * Fabric API request must match an explicit allowlist entry, checked in the
 * API client before any token is acquired or any network call is made.
 * Anything else — item create/update/delete, definition updates, job runs,
 * git or deployment-pipeline APIs, and creating any item (Lakehouses
 * included, decision D3) — throws `LocalFirstViolationError`.
 *
 * Changing this list is a plan change: update docs/plan-local-first.md in
 * the same commit.
 */

import { LocalFirstViolationError } from "./errors";
import type { FabricRequestOptions } from "./types";

/**
 * One path segment holding an ID (GUID or Livy numeric ID). Deliberately
 * excludes `.`, `%`, `/`, `?` and `#`, so traversal, encoded separators and
 * query strings can never satisfy a rule.
 */
const ID = "[0-9A-Za-z-]+";
const LIVY = `/workspaces/${ID}/lakehouses/${ID}/livyapi/versions/${ID}`;

interface WriteRule {
  readonly method: FabricRequestOptions["method"];
  readonly pattern: RegExp;
  /** What this rule permits, for errors and review. */
  readonly purpose: string;
}

export const WRITE_ALLOWLIST: readonly WriteRule[] = [
  {
    method: "POST",
    pattern: new RegExp(`^${LIVY}/sessions$`),
    purpose: "start a Livy session",
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^${LIVY}/sessions/${ID}$`),
    purpose: "stop a Livy session",
  },
  {
    method: "POST",
    pattern: new RegExp(`^${LIVY}/sessions/${ID}/statements$`),
    purpose: "run a Livy statement",
  },
  {
    method: "POST",
    pattern: new RegExp(`^${LIVY}/sessions/${ID}/statements/${ID}/cancel$`),
    purpose: "cancel a Livy statement",
  },
  {
    method: "POST",
    pattern: new RegExp(`^${LIVY}/batches$`),
    purpose: "submit a Livy batch (a Spark job from local files)",
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^${LIVY}/batches/${ID}$`),
    purpose: "cancel a Livy batch",
  },
];

/**
 * Throws `LocalFirstViolationError` unless the request is a GET or matches
 * an allowlist rule. `describe` is the caller's already redacted
 * "METHOD path" label, so no IDs reach the error message.
 */
export function assertWriteAllowed(
  options: FabricRequestOptions,
  describe: string,
): void {
  if (options.method === "GET") {
    return;
  }
  const allowed = WRITE_ALLOWLIST.some(
    (r) => r.method === options.method && r.pattern.test(options.path),
  );
  if (!allowed) {
    throw new LocalFirstViolationError(
      `Blocked '${options.method}' request: Fabric Connect is local-first and never creates, updates, deletes or runs items in a workspace.`,
      {
        operation: "enforce local-first write policy",
        entity: describe,
        remediation:
          "Keep code in your local repo and run it through a Livy session. If this write is genuinely needed, change the allowlist in src/core/writePolicy.ts together with docs/plan-local-first.md.",
      },
    );
  }
}

/** The only OneLake folder the extension writes to, inside a Lakehouse. */
export const ONELAKE_SCRATCH_PREFIX = "Files/.fabric-connect/";

const SCRATCH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * OneLake writes (upload, delete) are staging, not deployment: they are
 * allowed only below `Files/.fabric-connect/` of a Lakehouse, with plain
 * path segments (no traversal, no encoded separators).
 */
export function assertOneLakeWriteAllowed(
  method: string,
  relPath: string,
): void {
  const segments = relPath.slice(ONELAKE_SCRATCH_PREFIX.length).split("/");
  const allowed =
    relPath.startsWith(ONELAKE_SCRATCH_PREFIX) &&
    segments.length > 0 &&
    segments.every((segment) => SCRATCH_SEGMENT.test(segment));
  if (!allowed) {
    throw new LocalFirstViolationError(
      `Blocked OneLake '${method}': Fabric Connect only writes to its own scratch folder '${ONELAKE_SCRATCH_PREFIX}' when staging code for a run.`,
      {
        operation: "enforce local-first write policy",
        entity: `OneLake path ${relPath}`,
        remediation:
          "Keep data writes inside your Spark code. If this write is genuinely needed, change src/core/writePolicy.ts together with docs/plan-local-first.md.",
      },
    );
  }
}
