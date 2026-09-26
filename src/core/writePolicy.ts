/**
 * Local-first write policy: the extension never deploys. Every non-GET
 * Fabric API request must match an explicit allowlist entry, checked in the
 * API client before any token is acquired or any network call is made.
 * Anything else — item create/update/delete, definition updates, job runs,
 * git or deployment-pipeline APIs — throws `LocalFirstViolationError`.
 *
 * The single exception is creating a Lakehouse (infrastructure, decision D3
 * in docs/plan-local-first.md), and only with a `UserConfirmation` minted by
 * the VS Code layer after an explicit modal confirm. Changing this list is a
 * plan change: update docs/plan-local-first.md in the same commit.
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
  readonly requiresConfirmation?: UserConfirmation["action"];
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
    pattern: new RegExp(`^/workspaces/(${ID})/lakehouses$`),
    purpose: "create a Lakehouse (infrastructure, confirmed by the user)",
    requiresConfirmation: "create-lakehouse",
  },
];

const brand: unique symbol = Symbol("UserConfirmation");

/**
 * Proof that the user explicitly confirmed one infrastructure action. Only
 * `mintUserConfirmation` can produce one, and only `src/vscode/` may call
 * it, right after a modal confirm (enforced by test). Single-use, and bound
 * to the exact workspace and Lakehouse name the user saw.
 */
export interface UserConfirmation {
  readonly [brand]: true;
  readonly action: "create-lakehouse";
  readonly workspaceId: string;
  readonly displayName: string;
}

const consumed = new WeakSet<UserConfirmation>();

/** Call only from src/vscode/, immediately after the user confirmed a modal. */
export function mintUserConfirmation(
  action: UserConfirmation["action"],
  workspaceId: string,
  displayName: string,
): UserConfirmation {
  return Object.freeze({
    [brand]: true as const,
    action,
    workspaceId,
    displayName,
  });
}

/**
 * Throws `LocalFirstViolationError` unless the request is a GET or matches
 * an allowlist rule (with a valid, unused confirmation where required).
 * Consumes the confirmation on success. `describe` is the caller's already
 * redacted "METHOD path" label, so no IDs reach the error message.
 */
export function assertWriteAllowed(
  options: FabricRequestOptions,
  describe: string,
): void {
  if (options.method === "GET") {
    return;
  }
  const rule = WRITE_ALLOWLIST.find(
    (r) => r.method === options.method && r.pattern.test(options.path),
  );
  if (rule === undefined) {
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
  if (rule.requiresConfirmation === undefined) {
    return;
  }
  const confirmation = options.confirmation;
  const workspaceId = rule.pattern.exec(options.path)?.[1];
  const displayName = (options.body as { displayName?: unknown } | undefined)
    ?.displayName;
  const valid =
    confirmation !== undefined &&
    confirmation[brand] === true &&
    !consumed.has(confirmation) &&
    confirmation.action === rule.requiresConfirmation &&
    confirmation.workspaceId === workspaceId &&
    confirmation.displayName === displayName;
  if (!valid) {
    throw new LocalFirstViolationError(
      `Blocked request to ${rule.purpose}: it needs your explicit confirmation for this exact workspace and name, and none (or a mismatched or already-used one) was given.`,
      {
        operation: "enforce local-first write policy",
        entity: describe,
        remediation:
          "Start the action again from the Fabric Connect command and confirm the dialog; infrastructure is never created without it.",
      },
    );
  }
  consumed.add(confirmation);
}
