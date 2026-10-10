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

import { LIVY_API_VERSION, NETWORK_OUTAGE_GRACE_MS } from "./constants";
import { FabricApiError, LivyError } from "./errors";
import {
  ExecutionDiagnostics,
  executionFailureOutcome,
  type ExecutionOutcome,
  type StatementRole,
} from "./executionDiagnostics";
import { type ApiClientLogger, isNetworkFailure } from "./fabricApiClient";
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
  /** Static guidance for a narrowly recognized runtime-context failure. */
  readonly hint?: string;
}

export interface ILivySessionManager {
  execute(
    target: LivyTarget,
    code: string,
    kind: string,
    token: CancelToken,
    diagnostics?: ExecutionDiagnostics,
    role?: StatementRole,
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
  readonly logger?: ApiClientLogger;
  readonly now?: () => number;
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
  private readonly logger?: ApiClientLogger;
  private readonly now?: () => number;

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
    this.logger = options.logger;
    this.now = options.now;
  }

  async startSession(target: LivyTarget, token: CancelToken): Promise<void> {
    const diagnostics = new ExecutionDiagnostics(this.logger, this.now);
    let outcome: ExecutionOutcome = "error";
    try {
      await diagnostics.measure("session.acquire", () =>
        this.getOrCreateSession(target, token, diagnostics),
      );
      outcome = "ok";
    } catch (error) {
      outcome = executionFailureOutcome(error);
      throw error;
    } finally {
      diagnostics.finish(outcome);
    }
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
    diagnostics?: ExecutionDiagnostics,
    role: StatementRole = "user",
  ): Promise<LivyStatementResult> {
    const trace =
      diagnostics ?? new ExecutionDiagnostics(this.logger, this.now);
    const endQueue = trace.begin(`queue.${role}`);
    const key = sessionKey(target);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined) // one failed cell must not poison the queue
      .then(async () => {
        endQueue(token.isCancellationRequested ? "cancelled" : "ok");
        let outcome: ExecutionOutcome = "error";
        try {
          const result = await this.executeNow(
            target,
            code,
            kind,
            token,
            trace,
            role,
          );
          outcome = result.status;
          return result;
        } catch (error) {
          outcome = executionFailureOutcome(error);
          throw error;
        } finally {
          if (diagnostics === undefined) {
            trace.finish(outcome);
          }
        }
      });
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
    diagnostics: ExecutionDiagnostics,
    role: StatementRole,
  ): Promise<LivyStatementResult> {
    this.throwIfCancelled(token, target);
    let session: Promise<string> | undefined;
    const sessionId = await diagnostics.measure("session.acquire", () => {
      session = this.getOrCreateSession(target, token, diagnostics);
      return session;
    });
    const base = livyBase(target);

    let statement: LivyStatement;
    try {
      const response = await diagnostics.measure(
        `statement.submit.${role}`,
        () =>
          this.api.request<LivyStatement>({
            method: "POST",
            path: `${base}/sessions/${sessionId}/statements`,
            tenantId: target.tenantId,
            body: { code, kind },
          }),
      );
      statement = response.body;
    } catch (cause) {
      throw this.classifySessionLoss(
        cause,
        target,
        sessionId,
        session,
        "submit",
      );
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

    return diagnostics.measure(
      `statement.wait.${role}`,
      () => this.pollStatement(target, sessionId, statementId, token, session),
      (result) => result.status,
    );
  }

  private async pollStatement(
    target: LivyTarget,
    sessionId: string,
    statementId: string,
    token: CancelToken,
    session: Promise<string> | undefined,
  ): Promise<LivyStatementResult> {
    const base = livyBase(target);
    const now = this.now ?? Date.now;
    let outageSince: number | undefined;
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
        outageSince = undefined;
      } catch (cause) {
        // The statement keeps running remotely: ride out a short outage.
        if (isNetworkFailure(cause)) {
          outageSince ??= now();
          if (now() - outageSince < NETWORK_OUTAGE_GRACE_MS) {
            await this.sleep(this.pollIntervalMs);
            continue;
          }
        }
        throw this.classifySessionLoss(
          cause,
          target,
          sessionId,
          session,
          "poll",
        );
      }

      if (STATEMENT_FINAL_STATES.has(statement.state)) {
        return this.toResult(statement, sessionId, statementId);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private toResult(
    statement: LivyStatement,
    sessionId: string,
    statementId: string,
  ): LivyStatementResult {
    if (statement.state === "cancelled") {
      return { status: "cancelled" };
    }
    const output = statement.output;
    // Livy can report a failed statement by its state alone, without output.
    if (output?.status === "error" || statement.state === "error") {
      const hint = variableLibraryHint(output?.evalue, output?.traceback);
      // The cell's own exception: a notebook traceback, not an extension error.
      return {
        status: "error",
        errorName: output?.ename ?? "Error",
        errorValue:
          output?.status === "error"
            ? (output.evalue ?? "")
            : `Livy reported statement ${statementId} in session ${sessionId} as failed without error details. Check the session's log in the Fabric monitoring hub, then run the code again.`,
        traceback: output?.traceback ?? [],
        ...(hint === undefined ? {} : { hint }),
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

  private getOrCreateSession(
    target: LivyTarget,
    token: CancelToken,
    diagnostics: ExecutionDiagnostics,
  ): Promise<string> {
    const key = sessionKey(target);
    const existing = this.sessions.get(key);
    if (existing !== undefined) {
      return existing;
    }
    // Register this generation before acquisition can write persisted state.
    const created: Promise<string> = Promise.resolve()
      .then(() =>
        this.attachOrStartSession(target, token, diagnostics, created),
      )
      .then(async (sessionId) => {
        this.throwIfSuperseded(target, created);
        await this.runBootstrap(target, sessionId, token, diagnostics, created);
        return sessionId;
      })
      .catch((error) => {
        if (this.sessions.get(key) === created) {
          this.sessions.delete(key); // allow retry after a failed start
        }
        throw error;
      });
    this.sessions.set(key, created);
    return created;
  }

  private async runBootstrap(
    target: LivyTarget,
    sessionId: string,
    token: CancelToken,
    diagnostics: ExecutionDiagnostics,
    session: Promise<string>,
  ): Promise<void> {
    const bootstrap = this.bootstrap;
    if (bootstrap === undefined) {
      return;
    }
    try {
      const response = await diagnostics.measure("bootstrap.submit", () =>
        this.api.request<LivyStatement>({
          method: "POST",
          path: `${livyBase(target)}/sessions/${sessionId}/statements`,
          tenantId: target.tenantId,
          body: { code: bootstrap.code, kind: bootstrap.kind },
        }),
      );
      const statementId = livyId(response.body?.id);
      if (statementId !== undefined) {
        await diagnostics.measure(
          "bootstrap.wait",
          () =>
            this.pollStatement(target, sessionId, statementId, token, session),
          (result) => result.status,
        );
      }
    } catch {
      // Best effort: without the bootstrap, display() output stays plain
      // text; the user's own statement still runs (and reports real errors).
      // Its wait rides out network outages like any statement, so a cell
      // on a new session may wait up to NETWORK_OUTAGE_GRACE_MS here.
    }
  }

  private async attachOrStartSession(
    target: LivyTarget,
    token: CancelToken,
    diagnostics: ExecutionDiagnostics,
    acquisition: Promise<string>,
  ): Promise<string> {
    this.throwIfSuperseded(target, acquisition);
    const key = sessionKey(target);
    const base = livyBase(target);

    // Reattach to a session from a previous VS Code window if it's alive.
    const persisted = this.store.get(key);
    if (persisted !== undefined) {
      const reattached = await diagnostics.measure(
        "session.reattach",
        async () => {
          try {
            const response = await this.api.request<LivySessionInfo>({
              method: "GET",
              path: `${base}/sessions/${persisted}`,
              tenantId: target.tenantId,
            });
            if (response.body === undefined || response.body === null) {
              return undefined; // an empty answer: treat the session as gone
            }
            if (SESSION_READY_STATES.has(response.body.state)) {
              return persisted;
            }
            if (!SESSION_DEAD_STATES.has(response.body.state)) {
              // Return, don't await: readiness failures must not trigger a replacement.
              return this.waitForSessionReady(
                target,
                persisted,
                token,
                acquisition,
              );
            }
          } catch (cause) {
            // Only a session that is gone (404) is replaced; any other
            // failure would leave a live session running untracked.
            if (!(cause instanceof FabricApiError && cause.status === 404)) {
              throw this.sessionStartError(cause, target);
            }
          }
          return undefined;
        },
        (id) => (id === undefined ? "error" : "ok"),
      );
      if (reattached !== undefined) {
        return reattached;
      }
      this.throwIfSuperseded(target, acquisition);
      if (this.store.get(key) === persisted) {
        this.store.set(key, undefined);
      }
    }

    return diagnostics.measure("session.start", async () => {
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
      this.throwIfSuperseded(target, acquisition);
      this.store.set(key, sessionId);
      return this.waitForSessionReady(target, sessionId, token, acquisition);
    });
  }

  private async waitForSessionReady(
    target: LivyTarget,
    sessionId: string,
    token: CancelToken,
    acquisition: Promise<string>,
  ): Promise<string> {
    const base = livyBase(target);
    const deadline = Date.now() + this.sessionStartTimeoutMs;
    for (;;) {
      this.throwIfCancelled(token, target);
      this.throwIfSuperseded(target, acquisition);
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
        const key = sessionKey(target);
        if (
          this.sessions.get(key) === acquisition &&
          this.store.get(key) === sessionId
        ) {
          this.store.set(key, undefined);
        }
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
          "Resume the capacity in the Fabric portal, then run the cell again. A session may already have started: stop extra ones from the Lakehouse's session list.";
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
    session: Promise<string> | undefined,
    phase: "submit" | "poll",
  ): LivyError | unknown {
    if (
      cause instanceof FabricApiError &&
      (cause.status === 404 ||
        (phase === "submit" &&
          cause.status === 400 &&
          isTerminalSessionRejection(cause, target, sessionId)))
    ) {
      const key = sessionKey(target);
      if (session !== undefined && this.sessions.get(key) === session) {
        this.sessions.delete(key);
        if (this.store.get(key) === sessionId) {
          this.store.set(key, undefined);
        }
      }
      const detail = cause.message.split(" Next step:")[0];
      return new LivyError(
        `The Livy session expired or was stopped while the cell was running. Details: ${detail}`,
        {
          operation: "execute cell",
          entity: `session ${sessionId}`,
          kind: "session-expired",
          remediation:
            "Run the setup code again, then retry the failed code; the next run starts a fresh session.",
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

  private throwIfSuperseded(
    target: LivyTarget,
    acquisition: Promise<string>,
  ): void {
    if (this.sessions.get(sessionKey(target)) !== acquisition) {
      throw new LivyError(
        "Livy session startup was superseded by a stop, restart or reload.",
        {
          operation: "start Livy session",
          entity: hostEntity(target),
          kind: "cancelled",
          remediation: "Run the code again to use the current session.",
        },
      );
    }
  }
}

function isTerminalSessionRejection(
  cause: FabricApiError,
  target: LivyTarget,
  sessionId: string,
): boolean {
  if (cause.serviceMessage === undefined) {
    return false;
  }
  const match =
    /^Session ([a-z0-9-]+) of workspace ([a-z0-9-]+) is in a terminal state\.\s+Scheduler state\s*:\s*Ended\.\s+Plugin state\s*:\s*Ended\.\s+Livy state\s*:\s*dead\s*$/i.exec(
      cause.serviceMessage,
    );
  return (
    match !== null &&
    match[1].toLowerCase() === sessionId.toLowerCase() &&
    match[2].toLowerCase() === target.workspaceId.toLowerCase()
  );
}

function variableLibraryHint(
  errorValue: string | undefined,
  traceback: readonly string[] | undefined,
): string | undefined {
  const text = [errorValue ?? "", ...(traceback ?? [])].join("\n");
  if (
    !/variableLibrary/i.test(text) ||
    !/Failed to resolve variable reference/i.test(text) ||
    !/\bThe notebook [^\r\n"]+ state was not found\b/i.test(text)
  ) {
    return undefined;
  }
  return "Fabric Connect runs local code in a Lakehouse Livy session, not a deployed Fabric notebook. Variable Library resolution reported missing notebook runtime state; this may be a runtime-context limitation or stale Fabric state. Compare the same call in a deployed notebook in the intended workspace. If it only fails over Livy, report the compatibility issue; if it also fails in Fabric, check the notebook state, library workspace and active value set. No configuration fallback was applied.";
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
