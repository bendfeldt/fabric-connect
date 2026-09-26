/**
 * Local module staging — the part that makes this feel like Databricks
 * Connect: `import mypkg` in a notebook cell or a run file resolves to the
 * code in your working tree, not to a wheel someone uploaded.
 *
 * The configured source roots are zipped (deterministically), uploaded to
 * the session host's scratch folder `Files/.fabric-connect/<run>/`, added
 * with `sc.addPyFile`, and stale copies of the same packages are dropped
 * from `sys.modules` so the new code is what gets imported. Unchanged
 * sources are not re-uploaded (content hash).
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { StagingError } from "./errors";
import { createZip, type ZipEntry } from "./zip";

/** Filesystem seam: lists files below a directory and reads bytes. */
export interface StagingFileSystem {
  /** Absolute paths of all files below `dir` (recursive). */
  listFiles(dir: string): Promise<string[]>;
  readBytes(filePath: string): Promise<Uint8Array>;
}

export interface ModuleBundle {
  readonly zip: Uint8Array;
  /** Hex SHA-256 of the zip: the same sources give the same hash. */
  readonly hash: string;
  /** Top-level module/package names the bundle provides. */
  readonly topLevel: string[];
  readonly fileCount: number;
}

/** Directory names never staged. */
const SKIPPED_DIRS = new Set([
  "__pycache__",
  "node_modules",
  ".git",
  ".venv",
  "venv",
  ".mypy_cache",
  ".pytest_cache",
]);

/**
 * Bundles the `.py` files below each source root; paths inside the zip are
 * relative to their root, so `src/mypkg/x.py` with root `src` imports as
 * `mypkg.x`. Returns undefined when there is nothing to stage.
 */
export async function bundleModules(
  fs: StagingFileSystem,
  workspaceRoot: string,
  sourceRoots: readonly string[],
): Promise<ModuleBundle | undefined> {
  const entries: ZipEntry[] = [];
  const seen = new Map<string, string>();
  const root = path.resolve(workspaceRoot);
  for (const sourceRoot of sourceRoots) {
    const dir = path.resolve(root, sourceRoot);
    if (dir !== root && !dir.startsWith(root + path.sep)) {
      throw new StagingError(
        `Cannot stage source root '${sourceRoot}': it is outside the workspace folder.`,
        {
          operation: "stage local modules",
          entity: `source root ${sourceRoot}`,
          remediation:
            "Use workspace-relative folders in the 'fabric-connect.sourceRoots' setting.",
        },
      );
    }
    let files: string[];
    try {
      files = await fs.listFiles(dir);
    } catch (cause) {
      throw new StagingError(
        `Cannot stage source root '${sourceRoot}': the folder could not be read.`,
        {
          operation: "stage local modules",
          entity: `source root ${sourceRoot}`,
          remediation:
            "Check that the folder exists, or remove it from 'fabric-connect.sourceRoots'.",
          cause,
        },
      );
    }
    for (const file of files) {
      const rel = path.relative(dir, file).split(path.sep);
      if (
        !file.endsWith(".py") ||
        rel.some((part) => SKIPPED_DIRS.has(part) || part.startsWith("."))
      ) {
        continue;
      }
      const zipPath = rel.join("/");
      const previous = seen.get(zipPath);
      if (previous !== undefined) {
        throw new StagingError(
          `Cannot stage modules: '${zipPath}' exists in two source roots (${previous} and ${sourceRoot}).`,
          {
            operation: "stage local modules",
            entity: `module ${zipPath}`,
            remediation:
              "Make the source roots in 'fabric-connect.sourceRoots' non-overlapping.",
          },
        );
      }
      seen.set(zipPath, sourceRoot);
      entries.push({ path: zipPath, data: await fs.readBytes(file) });
    }
  }
  if (entries.length === 0) {
    return undefined;
  }
  const zip = createZip(entries);
  const topLevel = [
    ...new Set(entries.map((e) => e.path.split("/")[0].replace(/\.py$/, ""))),
  ].sort();
  return {
    zip,
    hash: createHash("sha256").update(zip).digest("hex"),
    topLevel,
    fileCount: entries.length,
  };
}

/** Scratch folder for one VS Code window's runs on one host. */
export function scratchFolder(runId: string): string {
  return `Files/.fabric-connect/${runId}`;
}

/**
 * A local file name made safe for the scratch folder (the write policy only
 * accepts plain segments). Python module names already fit, so imports of
 * staged libraries are unaffected.
 */
export function stagedFileName(fileName: string): string {
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, "_");
  return /^[A-Za-z0-9_]/.test(safe) ? safe : `_${safe}`;
}

/** Where a bundle is staged; the hash in the name keeps versions apart. */
export function bundlePath(runId: string, hash: string): string {
  return `${scratchFolder(runId)}/modules-${hash.slice(0, 16)}.zip`;
}

/**
 * Python that makes the staged bundle importable in the session and drops
 * stale copies of its packages so the next import loads the new code. It is
 * idempotent per session: re-sending the same bundle is a no-op, so module
 * state survives until the sources actually change.
 */
export function moduleImportCode(
  abfss: string,
  topLevel: readonly string[],
): string {
  return [
    "import sys as _fc_sys, importlib as _fc_importlib",
    "_fc_staged = globals().setdefault('_fc_staged', set())",
    `if ${JSON.stringify(abfss)} not in _fc_staged:`,
    `    spark.sparkContext.addPyFile(${JSON.stringify(abfss)})`,
    `    _fc_names = set(${JSON.stringify(topLevel)})`,
    "    for _fc_name in [m for m in _fc_sys.modules if m.split('.')[0] in _fc_names]:",
    "        del _fc_sys.modules[_fc_name]",
    "    _fc_importlib.invalidate_caches()",
    `    _fc_staged.add(${JSON.stringify(abfss)})`,
  ].join("\n");
}
