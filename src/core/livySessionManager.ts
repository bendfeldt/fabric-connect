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
  /** Fabric Environment (libraries, Spark settings); starter pool if absent. */
  readonly environmentId?: string;
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
  /** Starts (or reattaches to) the session now, e.g. right after a restart. */
  startSession(target: LivyTarget, token: CancelToken): Promise<void>;
  stopSession(target: LivyTarget): Promise<void>;
  /** Stops a session by its Livy ID (e.g. an orphan from the session list). */
  stopSessionById(target: LivyTarget, livyId: string): Promise<void>;
  dispose(): Promise<void>;
}

/** A Livy session or batch as listed by the Fabric monitoring API. */
export interface LivySessionSummary {
  readonly livyId: string;
  readonly state: string;
  readonly jobType?: string;
  readonly name?: string;
  readonly itemName?: string;
  readonly submittedDateTime?: string;
}

/** Lists Livy sessions and batches recorded for a Lakehouse (GET only). */
export async function listLivySessions(
  api: IFabricApiClient,
  target: LivyTarget,
): Promise<LivySessionSummary[]> {
  let response;
  try {
    response = await api.request<{ value?: Array<Record<string, unknown>> }>({
      method: "GET",
      path: `/workspaces/${target.workspaceId}/lakehouses/${target.lakehouseId}/livySessions`,
      tenantId: target.tenantId,
    });
  } catch (cause) {
    throw new LivyError("Failed to list the Livy sessions of the Lakehouse.", {
      operation: "list Livy sessions",
      entity: "host Lakehouse",
      kind: "protocol",
      remediation:
        "Check that you have at least Viewer access to the workspace, then retry.",
      cause,
    });
  }
  return (response.body?.value ?? []).flatMap((s) => {
    const livyId = s["livyId"];
    if (typeof livyId !== "string") {
      return [];
    }
    const text = (key: string) =>
      typeof s[key] === "string" ? (s[key] as string) : undefined;
    return [
      {
        livyId,
        state: text("state") ?? "Unknown",
        jobType: text("jobType"),
        name: text("livyName"),
        itemName: text("itemName"),
        submittedDateTime: text("submittedDateTime"),
      },
    ];
  });
}

/** Persists session IDs across VS Code reloads (backed by workspaceState). */
export interface SessionStore {
  get(key: string): string | undefined;
  set(key: string, value: string | undefined): void;
}

/**
 * Fabric's Livy returns session IDs as GUID strings (open-source Livy uses
 * numbers); statement IDs are numbers. Both are only ever used in paths,
 * so they are normalized to strings with `livyId`.
 */
type RawLivyId = string | number;

interface LivySessionInfo {
  id?: RawLivyId;
  state: string;
  /** Livy's own diagnostics; Fabric fills these when a session dies. */
  log?: unknown;
  errorInfo?: unknown;
  livyInfo?: unknown;
}

interface LivyStatement {
  id?: RawLivyId;
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
  /**
   * Code run once on every session this manager starts or reattaches to,
   * before any other statement (e.g. defining `display()`). A failing
   * bootstrap does not fail the user's statement.
   */
  readonly bootstrap?: { readonly code: string; readonly kind: string };
}

export class LivySessionManager implements ILivySessionManager {
  private readonly sessions = new Map<string, Promise<string>>();
  /** Per-session promise chain: executions queue instead of racing. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly pollIntervalMs: number;
  private readonly sessionStartTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly bootstrap?: { readonly code: string; readonly kind: string };

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
    this.bootstrap = options.bootstrap;
  }

  async startSession(target: LivyTarget, token: CancelToken): Promise<void> {
    await this.getOrCreateSession(target, token);
  }

  async stopSessionById(target: LivyTarget, livyId: string): Promise<void> {
    const key = sessionKey(target);
    if (this.store.get(key) === livyId) {
      await this.stopSession(target);
      return;
    }
    try {
      await this.api.request({
        method: "DELETE",
        path: `${livyBase(target)}/sessions/${livyId}`,
        tenantId: target.tenantId,
      });
    } catch (cause) {
      if (cause instanceof FabricApiError && cause.status === 404) {
        return; // already gone — nothing to stop
      }
      throw cause;
    }
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
    const statementId = livyId(statement?.id);
    if (statementId === undefined) {
      throw new LivyError(
        `The Livy API accepted the statement but returned no statement ID, so its result cannot be polled.${responseKeys(statement)}`,
        {
          operation: "execute cell",
          entity: `session ${sessionId}`,
          kind: "protocol",
          remediation:
            "Run the cell again; if it persists, stop the Livy session and retry.",
        },
      );
    }

    return this.pollStatement(target, sessionId, statementId, token);
  }

  private async pollStatement(
    target: LivyTarget,
    sessionId: string,
    statementId: string,
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
    sessionId: string,
    statementId: string,
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
  ): Promise<string> {
    const key = sessionKey(target);
    const existing = this.sessions.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = this.attachOrStartSession(target, token)
      .then(async (sessionId) => {
        await this.runBootstrap(target, sessionId, token);
        return sessionId;
      })
      .catch((error) => {
        this.sessions.delete(key); // allow retry after a failed start
        throw error;
      });
    this.sessions.set(key, created);
    return created;
  }

  private async runBootstrap(
    target: LivyTarget,
    sessionId: string,
    token: CancelToken,
  ): Promise<void> {
    if (this.bootstrap === undefined) {
      return;
    }
    try {
      const response = await this.api.request<LivyStatement>({
        method: "POST",
        path: `${livyBase(target)}/sessions/${sessionId}/statements`,
        tenantId: target.tenantId,
        body: { code: this.bootstrap.code, kind: this.bootstrap.kind },
      });
      const statementId = livyId(response.body?.id);
      if (statementId !== undefined) {
        await this.pollStatement(target, sessionId, statementId, token);
      }
    } catch {
      // Best effort: without the bootstrap, display() output stays plain
      // text; the user's own statement still runs (and reports real errors).
    }
  }

  private async attachOrStartSession(
    target: LivyTarget,
    token: CancelToken,
  ): Promise<string> {
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
          return persisted;
        }
        if (!SESSION_DEAD_STATES.has(response.body.state)) {
          return this.waitForSessionReady(target, persisted, token);
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
        body: sessionRequestBody(target),
      });
      session = response.body;
    } catch (cause) {
      throw this.sessionStartError(cause, target);
    }
    const sessionId = livyId(session?.id);
    if (sessionId === undefined) {
      throw new LivyError(
        `The Livy API accepted the session request but returned no session ID.${responseKeys(session)}`,
        {
          operation: "start Livy session",
          entity: hostEntity(target),
          kind: "protocol",
          remediation:
            "Run the cell again; if it persists, check the workspace capacity in the Fabric portal.",
        },
      );
    }
    this.store.set(key, sessionId);
    return this.waitForSessionReady(target, sessionId, token);
  }

  private async waitForSessionReady(
    target: LivyTarget,
    sessionId: string,
    token: CancelToken,
  ): Promise<string> {
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
        return sessionId;
      }
      if (SESSION_DEAD_STATES.has(session.state)) {
        this.store.set(sessionKey(target), undefined);
        const reason = sessionDiagnostics(session);
        throw new LivyError(
          `The Livy session for this notebook entered state '${session.state}' before becoming ready.` +
            (reason === undefined ? "" : ` Livy said: ${reason}`),
          {
            operation: "start Livy session",
            entity: `session ${sessionId} on ${hostEntity(target)}`,
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
      "Check the Fabric portal for the workspace and its capacity, then run the cell again.";
    if (cause instanceof FabricApiError) {
      if (cause.status === 400) {
        why = "Fabric rejected the session request";
        next =
          "Check that the Lakehouse and its workspace exist and the workspace is on a running Fabric capacity, then run the cell again.";
      } else if (cause.status === 401) {
        why = "the sign-in was not accepted (expired or wrong tenant)";
        next = "Sign in again with 'Fabric: Sign In', then run the cell again.";
      } else if (cause.status === 403) {
        why =
          "the signed-in identity lacks permission to run Spark in this workspace";
        next = "Ask a workspace admin for Contributor (or higher) access.";
      } else if (cause.status === 404) {
        why =
          "the workspace or Lakehouse was not found (wrong workspace ID, or no Spark pool)";
        next =
          "Check the notebook's default Lakehouse in the Lakehouses view (or the host Lakehouse in Configuration).";
      } else if (cause.status === 429) {
        why = "the capacity is throttling Spark requests";
        next = "Wait a moment, then run the cell again.";
      } else if (cause.status !== undefined && cause.status >= 500) {
        why =
          "the Fabric service failed to start the session (capacity may be paused)";
        next =
          "Resume the capacity in the Fabric portal, then run the cell again.";
      }
    }
    // The service's own words (status, message, correlation ID) are kept in
    // the surfaced text, not only in `cause`.
    const detail =
      cause instanceof Error
        ? ` Details: ${cause.message.split(" Next step:")[0]}`
        : "";
    return new LivyError(`Failed to start a Livy session: ${why}.${detail}`, {
      operation: "start Livy session",
      entity: hostEntity(target),
      kind: "session-start",
      remediation: next,
      cause,
    });
  }

  private classifySessionLoss(
    cause: unknown,
    target: LivyTarget,
    sessionId: string,
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
        entity: hostEntity(target),
        kind: "cancelled",
      });
    }
  }
}

function sessionKey(target: LivyTarget): string {
  const environment =
    target.environmentId === undefined ? "" : `/${target.environmentId}`;
  return `livy-session/${target.tenantId}/${target.workspaceId}/${target.lakehouseId}${environment}`;
}

/** Attaches the Environment the way Fabric documents it for Livy sessions. */
function sessionRequestBody(target: LivyTarget): Record<string, unknown> {
  if (target.environmentId === undefined) {
    return {};
  }
  return {
    conf: {
      "spark.fabric.environmentDetails": JSON.stringify({
        id: target.environmentId,
      }),
    },
  };
}

/**
 * A Livy session or statement ID as a URL path segment: a non-negative
 * integer or a GUID-like token (letters, digits, dashes, as for batch IDs).
 * Undefined when absent or unsafe to put in a path.
 */
export function livyId(value: unknown): string | undefined {
  const text =
    typeof value === "number" && Number.isInteger(value) && value >= 0
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  return /^[0-9A-Za-z-]+$/.test(text) ? text : undefined;
}

/** " Response fields: a, b." — names only, never values (they may hold IDs). */
function responseKeys(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    return " The response had no JSON body.";
  }
  const keys = Object.keys(body);
  return keys.length === 0
    ? " The response body was empty."
    : ` Response fields: ${keys.slice(0, 20).join(", ")}.`;
}

/** Which Lakehouse a session runs on, for error messages (never logs). */
function hostEntity(target: LivyTarget): string {
  return `Lakehouse ${target.lakehouseId} in workspace ${target.workspaceId}`;
}

/** Livy's own reason a session died, from whichever field carries it. */
export function sessionDiagnostics(session: {
  log?: unknown;
  errorInfo?: unknown;
  livyInfo?: unknown;
}): string | undefined {
  const texts: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string" && value.trim().length > 0) {
      texts.push(value.trim());
    } else if (Array.isArray(value)) {
      value.forEach(collect);
    } else if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      for (const key of ["message", "errorMessage", "currentState", "source"]) {
        collect(record[key]);
      }
    }
  };
  collect(session.errorInfo);
  collect(session.livyInfo);
  if (texts.length === 0 && Array.isArray(session.log)) {
    // The last log lines usually hold the failure.
    collect(session.log.slice(-3));
  }
  const text = [...new Set(texts)].join(" | ");
  return text.length === 0 ? undefined : text.slice(0, 500);
}

function livyBase(target: LivyTarget): string {
  return `/workspaces/${target.workspaceId}/lakehouses/${target.lakehouseId}/livyapi/versions/${LIVY_API_VERSION}`;
}
