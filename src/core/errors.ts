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
    super(parts.join(' '), { cause: details.cause });
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

export type LivyErrorKind = 'session-start' | 'session-expired' | 'cancelled';

export class FabricApiError extends FabricConnectError {
  readonly status?: number;
  /** Correlation ID from the response, for support cases. */
  readonly correlationId?: string;

  constructor(
    message: string,
    details: ErrorDetails & { status?: number; correlationId?: string },
  ) {
    const suffix =
      details.correlationId === undefined
        ? message
        : `${message} [correlation ID: ${details.correlationId}]`;
    super(suffix, details);
    this.status = details.status;
    this.correlationId = details.correlationId;
  }
}
