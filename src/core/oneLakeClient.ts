/**
 * OneLake client: the ADLS Gen2-compatible DFS API at
 * `onelake.dfs.fabric.microsoft.com`, used to browse Lakehouse files and to
 * stage local code for a run. Staging is not deployment: writes are allowed
 * only under the scratch prefix `Files/.fabric-connect/` of a Lakehouse
 * (enforced by `assertOneLakeWriteAllowed` before any request), and the
 * extension deletes what it staged when the session stops.
 *
 * Plain `fetch`, no Azure SDK — the zero-dependency rule holds.
 */

import {
  ONELAKE_API_VERSION,
  ONELAKE_BASE_URL,
  STORAGE_SCOPES,
} from "./constants";
import { OneLakeError } from "./errors";
import type { IAuthProvider } from "./types";
import { assertOneLakeWriteAllowed } from "./writePolicy";

export interface OneLakeLocation {
  readonly tenantId: string;
  readonly workspaceId: string;
  /** The Lakehouse (or other OneLake item) ID. */
  readonly itemId: string;
}

export interface OneLakePath {
  /** Path relative to the item, e.g. `Files/raw/a.csv`. */
  readonly path: string;
  readonly isDirectory: boolean;
  readonly contentLength?: number;
  readonly lastModified?: string;
}

export interface OneLakeClientOptions {
  readonly baseUrl?: string;
  readonly fetchFn?: typeof fetch;
}

/** The `abfss://` URI Spark uses for a path inside an item. */
export function abfssUri(
  workspaceId: string,
  itemId: string,
  relPath: string,
): string {
  return `abfss://${workspaceId}@onelake.dfs.fabric.microsoft.com/${itemId}/${relPath}`;
}

export class OneLakeClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly auth: IAuthProvider,
    options: OneLakeClientOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? ONELAKE_BASE_URL;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /** Creates (or overwrites) a file with the given bytes. */
  async uploadFile(
    at: OneLakeLocation,
    relPath: string,
    data: Uint8Array,
  ): Promise<void> {
    assertOneLakeWriteAllowed("PUT", relPath);
    const url = this.itemUrl(at, relPath);
    await this.send(at, "PUT", `${url}?resource=file`, "upload file", relPath);
    if (data.length > 0) {
      await this.send(
        at,
        "PATCH",
        `${url}?action=append&position=0`,
        "upload file",
        relPath,
        data,
      );
    }
    await this.send(
      at,
      "PATCH",
      `${url}?action=flush&position=${data.length}`,
      "upload file",
      relPath,
    );
  }

  /** Deletes a directory and everything in it; a missing one is fine. */
  async deleteDirectory(at: OneLakeLocation, relPath: string): Promise<void> {
    assertOneLakeWriteAllowed("DELETE", relPath);
    await this.send(
      at,
      "DELETE",
      `${this.itemUrl(at, relPath)}?recursive=true`,
      "delete staged files",
      relPath,
      undefined,
      [404],
    );
  }

  /** Lists one directory level (e.g. `Files` or `Tables`). */
  async list(at: OneLakeLocation, relDir: string): Promise<OneLakePath[]> {
    const paths: OneLakePath[] = [];
    let continuation: string | undefined;
    const prefix = `${at.itemId}/`;
    do {
      const query = new URLSearchParams({
        resource: "filesystem",
        recursive: "false",
        directory: `${at.itemId}/${relDir}`,
      });
      if (continuation !== undefined) {
        query.set("continuation", continuation);
      }
      const response = await this.send(
        at,
        "GET",
        `${this.baseUrl}/${at.workspaceId}?${query.toString()}`,
        "list files",
        relDir,
      );
      const body = (await response.json()) as {
        paths?: Array<Record<string, unknown>>;
      };
      for (const entry of body.paths ?? []) {
        const name = entry["name"];
        if (typeof name !== "string") {
          continue;
        }
        const length = Number(entry["contentLength"]);
        paths.push({
          path: name.startsWith(prefix) ? name.slice(prefix.length) : name,
          isDirectory:
            entry["isDirectory"] === "true" || entry["isDirectory"] === true,
          ...(Number.isFinite(length) ? { contentLength: length } : {}),
          ...(typeof entry["lastModified"] === "string"
            ? { lastModified: entry["lastModified"] }
            : {}),
        });
      }
      continuation = response.headers.get("x-ms-continuation") ?? undefined;
    } while (continuation !== undefined && continuation.length > 0);
    return paths;
  }

  /** Reads up to `maxBytes` from the start of a file (for previews). */
  async readHead(
    at: OneLakeLocation,
    relPath: string,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const response = await this.send(
      at,
      "GET",
      this.itemUrl(at, relPath),
      "read file",
      relPath,
      undefined,
      [],
      { Range: `bytes=0-${Math.max(0, maxBytes - 1)}` },
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  private itemUrl(at: OneLakeLocation, relPath: string): string {
    const encoded = relPath
      .split("/")
      .filter((segment) => segment.length > 0)
      .map(encodeURIComponent)
      .join("/");
    return `${this.baseUrl}/${at.workspaceId}/${at.itemId}/${encoded}`;
  }

  private async send(
    at: OneLakeLocation,
    method: string,
    url: string,
    operation: string,
    relPath: string,
    body?: Uint8Array,
    okStatuses: number[] = [],
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const token = await this.auth.getToken(at.tenantId, STORAGE_SCOPES);
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "x-ms-version": ONELAKE_API_VERSION,
          ...extraHeaders,
        },
        body,
      });
    } catch (cause) {
      throw new OneLakeError(
        `Failed to ${operation} in OneLake: network error.`,
        {
          operation,
          entity: `OneLake path ${relPath}`,
          remediation:
            "Check your network connection and proxy settings, then retry.",
          cause,
        },
      );
    }
    if (response.ok || okStatuses.includes(response.status)) {
      return response;
    }
    const why =
      response.status === 403
        ? "your account lacks access to this Lakehouse"
        : response.status === 404
          ? "the path does not exist"
          : `OneLake answered HTTP ${response.status}`;
    throw new OneLakeError(`Failed to ${operation} in OneLake: ${why}.`, {
      operation,
      entity: `OneLake path ${relPath}`,
      remediation:
        response.status === 403
          ? "Ask a workspace admin for Contributor access to the host Lakehouse's workspace."
          : "Check that the Lakehouse still exists, then retry.",
    });
  }
}
