/**
 * Error standard for the whole extension: every surfaced error states what
 * operation failed, why, which entity it relates to, and the next step the
 * developer should take. Raw exceptions never cross a module boundary
 * unwrapped — modules catch and re-throw one of these, preserving the
 * original as `cause`.
 */

export interface ErrorDetails {
  /** The operation that failed, e.g. "acquire token", "resolve target". */
  readonly operation: string;
  /** Entity the failure relates to: tenant, workspace, file, session, … */
  readonly entity?: string;
  /** The next step the developer should take. */
  readonly remediation?: string;
  readonly cause?: unknown;
}

export class FabricConnectError extends Error {
  readonly operation: string;
  readonly entity?: string;
  readonly remediation?: string;

  constructor(message: string, details: ErrorDetails) {
    const parts = [message];
    if (details.entity) {
      parts.push(`(${details.entity})`);
    }
    if (details.remediation) {
      parts.push(`Next step: ${details.remediation}`);
    }
    super(parts.join(" "), { cause: details.cause });
    this.name = new.target.name;
    this.operation = details.operation;
    this.entity = details.entity;
    this.remediation = details.remediation;
  }
}

export class AuthError extends FabricConnectError {}

export class TargetConfigError extends FabricConnectError {}

export class NotebookFidelityError extends FabricConnectError {}

export class LakehouseError extends FabricConnectError {}

/** Connecting to compute: capacity, workspace, host Lakehouse, environment. */
export class ComputeError extends FabricConnectError {}

/**
 * Code without a Lakehouse of its own needs the connected capacity's host
 * Lakehouse, and none is picked yet. The editor layer answers it by asking
 * for one and retrying.
 */
export class HostLakehouseNeededError extends ComputeError {}

/**
 * A notebook declares a default Lakehouse that is not bound to a deployed
 * Lakehouse (placeholder or logical IDs from git). `lakehouseName` is the
 * name its metadata keeps, for binding by name.
 */
export class DefaultLakehouseUnboundError extends ComputeError {
  constructor(
    message: string,
    details: ErrorDetails & { readonly lakehouseName?: string },
  ) {
    super(message, details);
    this.lakehouseName = details.lakehouseName;
  }
  readonly lakehouseName?: string;
}

/** OneLake file operations (browse, preview, scratch staging). */
export class OneLakeError extends FabricConnectError {}

/** Staging local modules or job files for a run. */
export class StagingError extends FabricConnectError {}

/** Reading or running a local Spark Job Definition. */
export class SparkJobError extends FabricConnectError {}

/** Running a local query file (KQL, DAX, GraphQL). */
export class QueryError extends FabricConnectError {}

/** Pulling an item's definition into the repo. */
export class PullError extends FabricConnectError {}

/** Editing an item's `.platform` metadata in the repo. */
export class ItemMetadataError extends FabricConnectError {}

/** Browsing Fabric in the explorer (listings, previews, copy actions). */
export class ExplorerError extends FabricConnectError {}

/** Running a cell of a `.fabnb` API notebook. */
export class ApiNotebookError extends FabricConnectError {}

/**
 * A request would write to Fabric outside the local-first allowlist
 * (src/core/writePolicy.ts). Thrown before any network call.
 */
export class LocalFirstViolationError extends FabricConnectError {}

/**
 * Infra-level Livy failures (session start, session expiry). A cell's own
 * runtime error is NOT one of these — it is returned as a normal statement
 * result and rendered as the notebook's traceback.
 */
export class LivyError extends FabricConnectError {
  constructor(
    message: string,
    details: ErrorDetails & { readonly kind: LivyErrorKind },
  ) {
    super(message, details);
    this.kind = details.kind;
  }
  readonly kind: LivyErrorKind;
}

export type LivyErrorKind =
  | "session-start"
  | "session-expired"
  | "cancelled"
  /** A cancel the user asked for did not take effect: work may still run. */
  | "cancel-failed"
  /** The Livy API returned a response missing required fields. */
  | "protocol";

export class FabricApiError extends FabricConnectError {
  readonly status?: number;
  /** Validated service detail, separate from formatted remediation text. */
  readonly serviceMessage?: string;
  /** Correlation ID from the response, for support cases. */
  readonly correlationId?: string;

  constructor(
    message: string,
    details: ErrorDetails & {
      status?: number;
      correlationId?: string;
      serviceMessage?: string;
    },
  ) {
    const suffix =
      details.correlationId === undefined
        ? message
        : `${message} [correlation ID: ${details.correlationId}]`;
    super(suffix, details);
    this.status = details.status;
    this.correlationId = details.correlationId;
    this.serviceMessage = details.serviceMessage;
  }
}
