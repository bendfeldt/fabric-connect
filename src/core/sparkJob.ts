/**
 * Spark Job Definitions, run from the working tree as Livy batches.
 *
 * A local `<name>.SparkJobDefinition/` folder carries the job's settings in
 * `SparkJobDefinitionV1.json` (main file, arguments, main class, libraries,
 * default Lakehouse). The main file and libraries are taken from the repo —
 * the `Main/` and `Libs/` folders or files named like the configured ones —
 * staged to the host Lakehouse's scratch folder, and submitted as a Livy
 * batch. Nothing is published to the Spark Job Definition item.
 */

import * as path from "node:path";
import { LIVY_API_VERSION } from "./constants";
import { FabricApiError, LivyError, SparkJobError } from "./errors";
import type { LivyTarget } from "./livySessionManager";
import type { CancelToken, IFabricApiClient } from "./types";

export const SJD_SETTINGS_FILE = "SparkJobDefinitionV1.json";

export interface SparkJobSettings {
  readonly executableFile?: string;
  readonly mainClass?: string;
  readonly commandLineArguments?: string;
  readonly additionalLibraryUris: string[];
  readonly language?: string;
  readonly defaultLakehouseArtifactId?: string;
  readonly environmentArtifactId?: string;
}

export interface SparkJobFiles {
  /** Absolute path of the local main file. */
  readonly main: string;
  /** Absolute paths of local library files to stage. */
  readonly libs: string[];
  /** Remote library URIs (abfss://…) passed through unchanged. */
  readonly remoteLibs: string[];
}

export interface JobFileSystem {
  readFile(filePath: string): Promise<string | undefined>;
  /** Names of the entries directly in `dir` (files only); [] if missing. */
  listDir(dir: string): Promise<string[]>;
}

export function parseSparkJobSettings(
  text: string | undefined,
  folder: string,
): SparkJobSettings {
  const entity = `Spark job ${path.basename(folder)}`;
  if (text === undefined) {
    throw new SparkJobError(
      `Cannot run ${path.basename(folder)}: '${SJD_SETTINGS_FILE}' is missing.`,
      {
        operation: "read Spark job definition",
        entity,
        remediation:
          "Pull the Spark Job Definition into the repo with Fabric's git integration or 'Fabric: Pull Item into Repo'.",
      },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new SparkJobError(
      `Cannot run ${path.basename(folder)}: '${SJD_SETTINGS_FILE}' is not valid JSON.`,
      {
        operation: "read Spark job definition",
        entity,
        remediation: `Fix the JSON in '${SJD_SETTINGS_FILE}'.`,
        cause,
      },
    );
  }
  const record =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const text_ = (key: string) =>
    typeof record[key] === "string" && (record[key] as string).length > 0
      ? (record[key] as string)
      : undefined;
  const libs = record["additionalLibraryUris"];
  return {
    executableFile: text_("executableFile"),
    mainClass: text_("mainClass"),
    commandLineArguments: text_("commandLineArguments"),
    additionalLibraryUris: Array.isArray(libs)
      ? libs.filter((l): l is string => typeof l === "string" && l.length > 0)
      : [],
    language: text_("language"),
    defaultLakehouseArtifactId: text_("defaultLakehouseArtifactId"),
    environmentArtifactId: text_("environmentArtifactId"),
  };
}

/**
 * Finds the main file and libraries in the local folder. The main file is
 * looked up as: the `executableFile` name in `Main/`, then in the folder
 * itself, then the single file in `Main/`.
 */
export async function locateJobFiles(
  fs: JobFileSystem,
  folder: string,
  settings: SparkJobSettings,
): Promise<SparkJobFiles> {
  const mainDir = path.join(folder, "Main");
  const mainFiles = await fs.listDir(mainDir);
  const wanted =
    settings.executableFile === undefined
      ? undefined
      : path.posix.basename(settings.executableFile.replace(/\\/g, "/"));
  const candidates = [
    ...(wanted === undefined
      ? []
      : [path.join(mainDir, wanted), path.join(folder, wanted)]),
    ...(mainFiles.length === 1 ? [path.join(mainDir, mainFiles[0])] : []),
  ];
  let main: string | undefined;
  for (const candidate of candidates) {
    if ((await fs.readFile(candidate)) !== undefined) {
      main = candidate;
      break;
    }
  }
  if (main === undefined) {
    throw new SparkJobError(
      `Cannot run ${path.basename(folder)}: its main file is not in the repo.`,
      {
        operation: "locate Spark job files",
        entity: `Spark job ${path.basename(folder)}`,
        remediation: `Put the main definition file in '${path.join(path.basename(folder), "Main")}/'${wanted === undefined ? "" : ` (expected '${wanted}')`}. Fabric Connect runs local code only.`,
      },
    );
  }
  const libDir = path.join(folder, "Libs");
  const libs = (await fs.listDir(libDir)).map((name) =>
    path.join(libDir, name),
  );
  const remoteLibs: string[] = [];
  for (const uri of settings.additionalLibraryUris) {
    const local = path.join(libDir, path.posix.basename(uri));
    if (!libs.includes(local)) {
      remoteLibs.push(uri);
    }
  }
  return { main, libs, remoteLibs };
}

/** Splits command-line arguments like a shell: whitespace, quotes kept together. */
export function splitArguments(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const args: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of value.matchAll(pattern)) {
    args.push(match[1] ?? match[2] ?? match[3]);
  }
  return args;
}

export interface BatchRequest {
  readonly name: string;
  readonly file: string;
  readonly args: string[];
  readonly className?: string;
  readonly pyFiles?: string[];
  readonly jars?: string[];
  readonly files?: string[];
  readonly conf?: Record<string, string>;
}

/** Livy batch body for staged files (all URIs already abfss://). */
export function buildBatchRequest(
  name: string,
  settings: SparkJobSettings,
  mainUri: string,
  libUris: readonly string[],
  environmentId: string | undefined,
): BatchRequest {
  const pyFiles = libUris.filter((u) => /\.(py|zip|egg|whl)$/i.test(u));
  const jars = libUris.filter((u) => /\.jar$/i.test(u));
  const files = libUris.filter(
    (u) => !pyFiles.includes(u) && !jars.includes(u),
  );
  return {
    name,
    file: mainUri,
    args: splitArguments(settings.commandLineArguments),
    ...(settings.mainClass !== undefined && !/\.(py|r)$/i.test(mainUri)
      ? { className: settings.mainClass }
      : {}),
    ...(pyFiles.length > 0 ? { pyFiles } : {}),
    ...(jars.length > 0 ? { jars } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(environmentId === undefined
      ? {}
      : {
          conf: {
            "spark.fabric.environmentDetails": JSON.stringify({
              id: environmentId,
            }),
          },
        }),
  };
}

export type BatchState = "success" | "dead" | "killed" | "cancelled";

const BATCH_FINAL = new Set(["success", "dead", "killed", "error"]);

export interface BatchRunOptions {
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Receives driver log lines as they arrive (best effort). */
  readonly onLog?: (line: string) => void;
  /** Receives state changes. */
  readonly onState?: (state: string) => void;
}

/**
 * Submits a batch, follows it to a final state (streaming logs where the
 * service provides them), and cancels it when the token fires.
 */
export async function runBatch(
  api: IFabricApiClient,
  target: LivyTarget,
  request: BatchRequest,
  token: CancelToken,
  options: BatchRunOptions = {},
): Promise<BatchState> {
  const base = `/workspaces/${target.workspaceId}/lakehouses/${target.lakehouseId}/livyapi/versions/${LIVY_API_VERSION}/batches`;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = options.pollIntervalMs ?? 3000;

  let batchId: unknown;
  try {
    const response = await api.request<{ id?: unknown; state?: string }>({
      method: "POST",
      path: base,
      tenantId: target.tenantId,
      body: request,
    });
    batchId = response.body?.id;
  } catch (cause) {
    throw new LivyError(`Failed to submit Spark job '${request.name}'.`, {
      operation: "submit Livy batch",
      entity: `Spark job ${request.name}`,
      kind: "session-start",
      remediation:
        cause instanceof FabricApiError && cause.status === 403
          ? "Ask a workspace admin for Contributor (or higher) access to the host Lakehouse's workspace."
          : "Check the Fabric monitoring hub first: the job may have been submitted. If it is not there, check that the capacity is running, then run the job again.",
      cause,
    });
  }
  if (
    (typeof batchId !== "number" && typeof batchId !== "string") ||
    !/^[0-9A-Za-z-]+$/.test(String(batchId))
  ) {
    throw new LivyError(
      `The Livy API accepted Spark job '${request.name}' but returned no usable batch ID.`,
      {
        operation: "submit Livy batch",
        entity: `Spark job ${request.name}`,
        kind: "protocol",
        remediation: "Check the job in the Fabric monitoring hub.",
      },
    );
  }
  const id = String(batchId);

  let logFrom = 0;
  let logsAvailable = options.onLog !== undefined;
  let lastState = "";
  for (;;) {
    if (token.isCancellationRequested) {
      try {
        await api.request({
          method: "DELETE",
          path: `${base}/${id}`,
          tenantId: target.tenantId,
        });
      } catch {
        // Best effort: the user asked to stop.
      }
      return "cancelled";
    }
    let state: string;
    try {
      const response = await api.request<{ state?: string }>({
        method: "GET",
        path: `${base}/${id}`,
        tenantId: target.tenantId,
      });
      state = response.body?.state ?? "unknown";
    } catch (cause) {
      throw new LivyError(`Lost track of Spark job '${request.name}'.`, {
        operation: "follow Livy batch",
        entity: `Spark job ${request.name}`,
        kind: "protocol",
        remediation: "Check the job's status in the Fabric monitoring hub.",
        cause,
      });
    }
    if (state !== lastState) {
      lastState = state;
      options.onState?.(state);
    }
    if (logsAvailable) {
      try {
        const response = await api.request<{ log?: unknown }>({
          method: "GET",
          path: `${base}/${id}/log?from=${logFrom}&size=200`,
          tenantId: target.tenantId,
        });
        const lines = Array.isArray(response.body?.log)
          ? (response.body.log as unknown[]).map(String)
          : [];
        logFrom += lines.length;
        for (const line of lines) {
          options.onLog?.(line);
        }
      } catch {
        logsAvailable = false; // the service doesn't expose batch logs
      }
    }
    if (BATCH_FINAL.has(state)) {
      return state === "success"
        ? "success"
        : state === "killed"
          ? "killed"
          : "dead";
    }
    await sleep(interval);
  }
}
