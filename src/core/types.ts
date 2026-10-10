/**
 * Shared structural types. Core modules use typed boundaries and never
 * depend on `vscode`, so their behavior is testable in plain Node.
 * Additional interfaces live beside their owning core modules.
 */

/** Auth Module boundary. No awareness of notebooks, targets, or item types. */
export interface IAuthProvider {
  getToken(tenantId: string, scopes: readonly string[]): Promise<string>;
}

/** Target Config Module boundary. */
export interface ITargetResolver {
  resolveTarget(folderPath: string): Promise<ResolvedTarget>;
  /** `undefined` when the folder is simply not configured; throws if broken. */
  resolveTargetIfMapped(
    folderPath: string,
  ): Promise<ResolvedTarget | undefined>;
}

export interface ResolvedTarget {
  readonly targetName: string;
  readonly workspaceId: string;
  readonly itemType: string;
  readonly tenantId: string;
}

/** Fabric API Client boundary. */
export interface IFabricApiClient {
  request<T>(options: FabricRequestOptions): Promise<FabricResponse<T>>;
}

/**
 * Which API a request goes to: the Fabric REST API when omitted, the Power
 * BI REST API, a Fabric Kusto endpoint (its origin validated by the write
 * policy before any token is attached), or Azure Resource Manager (only
 * `GET /tenants`, enforced by the write policy).
 */
export type ServiceTarget =
  | { readonly kind: "fabric" }
  | { readonly kind: "powerbi" }
  | { readonly kind: "kusto"; readonly origin: string }
  | { readonly kind: "arm" };

export interface FabricRequestOptions {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path relative to the API base, e.g. `/workspaces/{id}/lakehouses`. */
  readonly path: string;
  readonly tenantId: string;
  readonly body?: unknown;
  readonly scopes?: readonly string[];
  /** The API the path belongs to; the Fabric REST API when omitted. */
  readonly service?: ServiceTarget;
}

export interface FabricResponse<T> {
  readonly status: number;
  readonly body: T;
  readonly correlationId?: string;
  /** Long-running operations (202): the operation to poll, if any. */
  readonly operationId?: string;
  /** Seconds the service asked the client to wait before polling. */
  readonly retryAfterSeconds?: number;
}

/**
 * Structurally compatible with vscode.CancellationToken, so core modules
 * support cancellation without importing the vscode module.
 */
export interface CancelToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export const NEVER_CANCELLED: CancelToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

/** A plain JSON object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
