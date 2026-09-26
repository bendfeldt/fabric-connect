/**
 * Fabric API Client (shared): the single typed HTTP client used by the
 * Fidelity, Lakehouse Panel, and Livy modules. Owns retries, backoff,
 * normalization of every failure into `FabricApiError`, and enforcement of
 * the local-first write allowlist (`writePolicy.ts`). Requests and
 * responses are logged (redacted) when debug logging is on — retries are
 * visible, never silently swallowed.
 */

import {
  FABRIC_API_BASE_URL,
  FABRIC_SCOPES,
  KUSTO_SCOPES,
  POWERBI_API_BASE_URL,
  POWERBI_SCOPES,
} from "./constants";
import { FabricApiError } from "./errors";
import type {
  FabricRequestOptions,
  FabricResponse,
  IAuthProvider,
  IFabricApiClient,
} from "./types";
import { assertWriteAllowed, serviceOrigin } from "./writePolicy";

export interface ApiClientLogger {
  debug(message: string): void;
}

export interface FabricApiClientOptions {
  readonly baseUrl?: string;
  readonly fetchFn?: typeof fetch;
  readonly logger?: ApiClientLogger;
  readonly maxAttempts?: number;
  /** Injected for tests so retries do not actually sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const GUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Workspace/item GUIDs must never appear in logs; redact them from paths. */
export function redactPath(p: string): string {
  return p.replace(GUID_PATTERN, "<redacted-id>");
}

export class FabricApiClient implements IFabricApiClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly logger?: ApiClientLogger;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly auth: IAuthProvider,
    options: FabricApiClientOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? FABRIC_API_BASE_URL;
    this.fetchFn = options.fetchFn ?? fetch;
    this.logger = options.logger;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async request<T>(options: FabricRequestOptions): Promise<FabricResponse<T>> {
    const logPath = `${options.method} ${redactPath(options.path)}`;
    // Local-first: refuse non-allowlisted writes (and unknown hosts) before
    // touching auth or network.
    assertWriteAllowed(options, logPath);
    const service = options.service ?? { kind: "fabric" };
    const scopes =
      options.scopes ??
      (service.kind === "powerbi"
        ? POWERBI_SCOPES
        : service.kind === "kusto"
          ? KUSTO_SCOPES
          : FABRIC_SCOPES);
    const base =
      service.kind === "fabric"
        ? this.baseUrl
        : service.kind === "powerbi"
          ? POWERBI_API_BASE_URL
          : serviceOrigin(service);
    const url = base + options.path;

    let lastError: FabricApiError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const token = await this.auth.getToken(options.tenantId, scopes);
      let response: Response;
      try {
        this.logger?.debug(
          `→ ${logPath} (attempt ${attempt}/${this.maxAttempts})`,
        );
        response = await this.fetchFn(url, {
          method: options.method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
        });
      } catch (cause) {
        lastError = new FabricApiError(
          `The Fabric API request '${logPath}' failed at the network level.`,
          {
            operation: "call Fabric API",
            entity: logPath,
            remediation:
              "Check your network connection and proxy settings, then retry.",
            cause,
          },
        );
        this.logger?.debug(`✗ ${logPath} network error (attempt ${attempt})`);
        await this.backoff(attempt, undefined);
        continue;
      }

      const correlationId =
        response.headers.get("x-ms-request-id") ??
        response.headers.get("requestid") ??
        undefined;
      this.logger?.debug(`← ${logPath} ${response.status}`);

      if (response.ok) {
        const body = await this.parseBody<T>(response, logPath, correlationId);
        const operationId =
          response.headers.get("x-ms-operation-id") ?? undefined;
        const retryAfter = Number(response.headers.get("retry-after"));
        return {
          status: response.status,
          body,
          correlationId,
          ...(operationId === undefined ? {} : { operationId }),
          ...(Number.isFinite(retryAfter) && retryAfter > 0
            ? { retryAfterSeconds: retryAfter }
            : {}),
        };
      }

      lastError = await this.toApiError(response, logPath, correlationId);
      if (
        !RETRYABLE_STATUS.has(response.status) ||
        attempt === this.maxAttempts
      ) {
        throw lastError;
      }
      const retryAfter = response.headers.get("retry-after");
      this.logger?.debug(
        `↻ ${logPath} ${response.status} is retryable, backing off (attempt ${attempt})`,
      );
      await this.backoff(attempt, retryAfter);
    }
    // Only reachable via repeated network-level failures.
    throw (
      lastError ??
      new FabricApiError(`The Fabric API request '${logPath}' failed.`, {
        operation: "call Fabric API",
        entity: logPath,
      })
    );
  }

  private async parseBody<T>(
    response: Response,
    logPath: string,
    correlationId: string | undefined,
  ): Promise<T> {
    const text = await response.text();
    if (text.length === 0) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new FabricApiError(
        `The Fabric API returned a malformed (non-JSON) response for '${logPath}'.`,
        {
          operation: "call Fabric API",
          entity: logPath,
          status: response.status,
          correlationId,
          remediation:
            "Retry the operation; if it persists, open a support case citing the correlation ID.",
          cause,
        },
      );
    }
  }

  private async toApiError(
    response: Response,
    logPath: string,
    correlationId: string | undefined,
  ): Promise<FabricApiError> {
    let detail = "";
    try {
      const body = (await response.json()) as {
        message?: string;
        error?: { message?: string };
      };
      detail = body.error?.message ?? body.message ?? "";
    } catch {
      // Non-JSON error body: the status-based message below is sufficient.
    }
    const explanations: Record<number, { why: string; next: string }> = {
      401: {
        why: "the request was not authenticated",
        next: "Run 'Fabric: Sign In' to re-authenticate the tenant.",
      },
      403: {
        why: "the signed-in identity lacks permission on this resource",
        next: "Ask a workspace admin to grant your account access, or switch tenants.",
      },
      404: {
        why: "the resource does not exist (or is not visible to this identity)",
        next: "Verify the workspace ID in .fabric/local.json points at the intended workspace.",
      },
      429: {
        why: "the API throttled the request",
        next: "Wait for the throttling window to pass; the client already retried with backoff.",
      },
    };
    const known = explanations[response.status];
    const why =
      known?.why ??
      (response.status >= 500
        ? "the Fabric service reported an internal error"
        : "the request was rejected");
    const next =
      known?.next ??
      "Retry the operation; if it persists, open a support case citing the correlation ID.";
    return new FabricApiError(
      `The Fabric API request '${logPath}' failed with HTTP ${response.status} because ${why}.` +
        (detail ? ` Service message: ${detail}` : ""),
      {
        operation: "call Fabric API",
        entity: logPath,
        status: response.status,
        correlationId,
        remediation: next,
      },
    );
  }

  private async backoff(
    attempt: number,
    retryAfter: string | null | undefined,
  ): Promise<void> {
    if (attempt >= this.maxAttempts) {
      return;
    }
    const fromHeader =
      retryAfter !== null && retryAfter !== undefined
        ? Number(retryAfter) * 1000
        : Number.NaN;
    const ms = Number.isFinite(fromHeader)
      ? fromHeader
      : Math.min(8000, 500 * 2 ** (attempt - 1));
    await this.sleep(ms);
  }
}
