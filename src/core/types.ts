/**
 * Shared structural types. Core modules depend only on these interfaces —
 * never on the `vscode` module or on each other's internals — so every
 * module is unit-testable in plain Node and Part 2 can reuse Auth, Target
 * Config, and the API client unchanged.
 */

/** Auth Module boundary. No awareness of notebooks, targets, or item types. */
export interface IAuthProvider {
  getToken(tenantId: string, scopes: readonly string[]): Promise<string>;
}

/** Target Config Module boundary. */
export interface ITargetResolver {
  resolveTarget(folderPath: string): Promise<ResolvedTarget>;
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

export interface FabricRequestOptions {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path relative to the API base, e.g. `/workspaces/{id}/lakehouses`. */
  readonly path: string;
  readonly tenantId: string;
  readonly body?: unknown;
  readonly scopes?: readonly string[];
}

export interface FabricResponse<T> {
  readonly status: number;
  readonly body: T;
  readonly correlationId?: string;
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
