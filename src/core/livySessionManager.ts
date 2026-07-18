/**
 * Livy Session Manager: owns session lifecycle (start, reuse, reattach)
 * against the workspace resolved by Target Config, serializes executions
 * on a session instead of racing them, and supports cancellation.
 *
 * Failure classes are deliberately distinct:
 *  - infra failures (capacity paused, permissions) → LivyError with an
 *    actionable message;
 *  - mid-execution session expiry → LivyError (kind 'session-expired');
 *  - a cell's own runtime error → NOT an error here: returned as a normal
 *    result with `status: 'error'` so it renders as the notebook's own
 *    traceback, exactly as the portal shows it.
 */

import { LIVY_API_VERSION } from "./constants";
import { FabricApiError, LivyError } from "./errors";
import type { CancelToken, IFabricApiClient } from "./types";

export interface LivyTarget {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly lakehouseId: string;
}

export interface LivyStatementResult {
  readonly status: "ok" | "error" | "cancelled";
  /** MIME bundle on success, e.g. { 'text/plain': '42' }. */
  readonly data?: Record<string, unknown>;
  /** Populated when the cell itself raised: portal-style traceback. */
  readonly errorName?: string;
  readonly errorValue?: string;
  readonly traceback?: string[];
}

export interface ILivySessionManager {
  execute(
    target: LivyTarget,
    code: string,
    kind: string,
    token: CancelToken,
  ): Promise<LivyStatementResult>;
  stopSession(target: LivyTarget): Promise<void>;
  dispose(): Promise<void>;
}

/** Persists session IDs across VS Code reloads (backed by workspaceState). */
export interface SessionStore {
  get(key: string): string | undefined;
  set(key: string, value: string | undefined): void;
}

interface LivySessionInfo {
  id: number;
  state: string;
}

interface LivyStatement {
  id: number;
  state: string;
  output?: {
    status?: string;
    data?: Record<string, unknown>;
    ename?: string;
    evalue?: string;
    traceback?: string[];
  };
}

const SESSION_READY_STATES = new Set(["idle", "busy", "running"]);
const SESSION_DEAD_STATES = new Set([
  "error",
  "dead",
  "killed",
  "success",
  "shutting_down",
]);
const STATEMENT_FINAL_STATES = new Set(["available", "error", "cancelled"]);

export interface LivySessionManagerOptions {
  readonly pollIntervalMs?: number;
  readonly sessionStartTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class LivySessionManager implements ILivySessionManager {
  private readonly sessions = new Map<string, Promise<number>>();
  /** Per-session promise chain: executions queue instead of racing. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly pollIntervalMs: number;
  private readonly sessionStartTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly api: IFabricApiClient,
    private readonly store: SessionStore,
    options: LivySessionManagerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.sessionStartTimeoutMs = options.sessionStartTimeoutMs ?? 5 * 60 * 1000;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async execute(
    target: LivyTarget,
    code: string,
    kind: string,
    token: CancelToken,
  ): Promise<LivyStatementResult> {
    const key = sessionKey(target);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined) // one failed cell must not poison the queue
      .then(() => this.executeNow(target, code, kind, token));
    this.queues.set(key, run);
    return run;
  }

  async stopSession(target: LivyTarget): Promise<void> {
    const key = sessionKey(target);
    const sessionId = this.store.get(key);
    this.sessions.delete(key);
    this.store.set(key, undefined);
    if (sessionId === undefined) {
      return;
    }
    try {
      await this.api.request({
        method: "DELETE",
        path: `${livyBase(target)}/sessions/${sessionId}`,
        tenantId: target.tenantId,
      });
    } catch (cause) {
      if (cause instanceof FabricApiError && cause.status === 404) {
        return; // already gone — nothing to stop
      }
      throw cause;
    }
  }

  async dispose(): Promise<void> {
    // Sessions are intentionally left running on dispose: reattachment on
    // the next VS Code reload reuses them (matching portal behavior)
    // instead of orphaning a new session per reload.
    this.sessions.clear();
    this.queues.clear();
  }

  private async executeNow(
    target: LivyTarget,
    code: string,
    kind: string,
    token: CancelToken,
  ): Promise<LivyStatementResult> {
    this.throwIfCancelled(token, target);
    const sessionId = await this.getOrCreateSession(target, token);
    const base = livyBase(target);

    let statement: LivyStatement;
    try {
      const response = await this.api.request<LivyStatement>({
        method: "POST",
        path: `${base}/sessions/${sessionId}/statements`,
        tenantId: target.tenantId,
        body: { code, kind },
      });
      statement = response.body;
    } catch (cause) {
      throw this.classifySessionLoss(cause, target, sessionId);
    }

    return this.pollStatement(target, sessionId, statement.id, token);
  }

  private async pollStatement(
    target: LivyTarget,
    sessionId: number,
    statementId: number,
    token: CancelToken,
  ): Promise<LivyStatementResult> {
    const base = livyBase(target);
    for (;;) {
      if (token.isCancellationRequested) {
        await this.cancelStatement(target, sessionId, statementId);
        return { status: "cancelled" };
      }
      let statement: LivyStatement;
      try {
        const response = await this.api.request<LivyStatement>({
          method: "GET",
          path: `${base}/sessions/${sessionId}/statements/${statementId}`,
          tenantId: target.tenantId,
        });
        statement = response.body;
      } catch (cause) {
        throw this.classifySessionLoss(cause, target, sessionId);
      }

      if (STATEMENT_FINAL_STATES.has(statement.state)) {
        return this.toResult(statement);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private toResult(statement: LivyStatement): LivyStatementResult {
    if (statement.state === "cancelled") {
      return { status: "cancelled" };
    }
    const output = statement.output;
    if (output?.status === "error") {
      // The cell's own exception: a notebook traceback, not an extension error.
      return {
        status: "error",
        errorName: output.ename ?? "Error",
        errorValue: output.evalue ?? "",
        traceback: output.traceback ?? [],
      };
    }
    return { status: "ok", data: output?.data ?? {} };
  }

  private async cancelStatement(
    target: LivyTarget,
    sessionId: number,
    statementId: number,
  ): Promise<void> {
    try {
      await this.api.request({
        method: "POST",
        path: `${livyBase(target)}/sessions/${sessionId}/statements/${statementId}/cancel`,
        tenantId: target.tenantId,
      });
    } catch {
      // Best effort: the user asked to stop; a failed cancel call must not
      // replace the 'cancelled' outcome with an unrelated error.
    }
  }

  private async getOrCreateSession(
    target: LivyTarget,
    token: CancelToken,
  ): Promise<number> {
    const key = sessionKey(target);
    const existing = this.sessions.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = this.attachOrStartSession(target, token).catch((error) => {
      this.sessions.delete(key); // allow retry after a failed start
      throw error;
    });
    this.sessions.set(key, created);
    return created;
  }

  private async attachOrStartSession(
    target: LivyTarget,
    token: CancelToken,
  ): Promise<number> {
    const key = sessionKey(target);
    const base = livyBase(target);

    // Reattach to a session from a previous VS Code window if it's alive.
    const persisted = this.store.get(key);
    if (persisted !== undefined) {
      try {
        const response = await this.api.request<LivySessionInfo>({
          method: "GET",
          path: `${base}/sessions/${persisted}`,
          tenantId: target.tenantId,
        });
        if (SESSION_READY_STATES.has(response.body.state)) {
          return response.body.id;
        }
        if (!SESSION_DEAD_STATES.has(response.body.state)) {
          return this.waitForSessionReady(target, response.body.id, token);
        }
      } catch {
        // Persisted session is gone; fall through and start a fresh one.
      }
      this.store.set(key, undefined);
    }

    let session: LivySessionInfo;
    try {
      const response = await this.api.request<LivySessionInfo>({
        method: "POST",
        path: `${base}/sessions`,
        tenantId: target.tenantId,
        body: {},
      });
      session = response.body;
    } catch (cause) {
      throw this.sessionStartError(cause, target);
    }
    this.store.set(key, String(session.id));
    return this.waitForSessionReady(target, session.id, token);
  }

  private async waitForSessionReady(
    target: LivyTarget,
    sessionId: number,
    token: CancelToken,
  ): Promise<number> {
    const base = livyBase(target);
    const deadline = Date.now() + this.sessionStartTimeoutMs;
    for (;;) {
      this.throwIfCancelled(token, target);
      let session: LivySessionInfo;
      try {
        const response = await this.api.request<LivySessionInfo>({
          method: "GET",
          path: `${base}/sessions/${sessionId}`,
          tenantId: target.tenantId,
        });
        session = response.body;
      } catch (cause) {
        throw this.sessionStartError(cause, target);
      }
      if (SESSION_READY_STATES.has(session.state)) {
        return session.id;
      }
      if (SESSION_DEAD_STATES.has(session.state)) {
        this.store.set(sessionKey(target), undefined);
        throw new LivyError(
          `The Livy session for this notebook entered state '${session.state}' before becoming ready.`,
          {
            operation: "start Livy session",
            entity: `session ${sessionId}`,
            kind: "session-start",
            remediation:
              "Check that the workspace capacity is running and its Spark pool exists, then run the cell again.",
          },
        );
      }
      if (Date.now() >= deadline) {
        throw new LivyError(
          "Timed out waiting for the Livy session to become ready.",
          {
            operation: "start Livy session",
            entity: `session ${sessionId}`,
            kind: "session-start",
            remediation:
              "The capacity may be under heavy load or starting cold. Wait a moment and run the cell again.",
          },
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private sessionStartError(cause: unknown, target: LivyTarget): LivyError {
    if (cause instanceof LivyError) {
      return cause;
    }
    let why = "the session could not be started";
    let next =
      "Check the Fabric portal for the workspace state, then run the cell again.";
    if (cause instanceof FabricApiError) {
      if (cause.status === 403) {
        why =
          "the signed-in identity lacks permission to run Spark in this workspace";
        next = "Ask a workspace admin for Contributor (or higher) access.";
      } else if (cause.status === 404) {
        why =
          "the workspace or Lakehouse was not found (wrong workspace ID, or no Spark pool)";
        next =
          "Verify the workspace ID in .fabric/local.json and the attached Lakehouse.";
      } else if (cause.status !== undefined && cause.status >= 500) {
        why =
          "the Fabric service failed to start the session (capacity may be paused)";
        next =
          "Resume the capacity in the Fabric portal, then run the cell again.";
      }
    }
    return new LivyError(`Failed to start a Livy session: ${why}.`, {
      operation: "start Livy session",
      entity: `workspace (target tenant ${target.tenantId})`,
      kind: "session-start",
      remediation: next,
      cause,
    });
  }

  private classifySessionLoss(
    cause: unknown,
    target: LivyTarget,
    sessionId: number,
  ): LivyError | unknown {
    if (cause instanceof FabricApiError && cause.status === 404) {
      // Session vanished mid-execution: expired or was stopped upstream.
      this.sessions.delete(sessionKey(target));
      this.store.set(sessionKey(target), undefined);
      return new LivyError(
        "The Livy session expired or was stopped while the cell was running.",
        {
          operation: "execute cell",
          entity: `session ${sessionId}`,
          kind: "session-expired",
          remediation:
            "Run the cell again — a fresh session will be started automatically.",
          cause,
        },
      );
    }
    return cause;
  }

  private throwIfCancelled(token: CancelToken, target: LivyTarget): void {
    if (token.isCancellationRequested) {
      throw new LivyError("Execution was cancelled before it started.", {
        operation: "execute cell",
        entity: `workspace (target tenant ${target.tenantId})`,
        kind: "cancelled",
      });
    }
  }
}

function sessionKey(target: LivyTarget): string {
  return `livy-session/${target.tenantId}/${target.workspaceId}/${target.lakehouseId}`;
}

function livyBase(target: LivyTarget): string {
  return `/workspaces/${target.workspaceId}/lakehouses/${target.lakehouseId}/livyapi/versions/${LIVY_API_VERSION}`;
}
