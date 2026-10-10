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

/**
 * The run's module bundles, kept apart from Spark job files so stopping a
 * session never deletes the files of a job that is still running.
 */
export function modulesFolder(runId: string): string {
  return `${scratchFolder(runId)}/modules`;
}

/** Where a bundle is staged; the hash in the name keeps versions apart. */
export function bundlePath(runId: string, hash: string): string {
  return `${modulesFolder(runId)}/modules-${hash.slice(0, 16)}.zip`;
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

/**
 * Where `import` finds your packages: `local` stages the working tree,
 * `remote` uses what the Fabric environment has installed (e.g. a wheel).
 */
export type PythonModuleMode = "local" | "remote";

/**
 * The effective mode. `auto` keeps the behaviour from before the setting
 * existed: configured source roots mean local, otherwise remote — so
 * nothing is uploaded to OneLake unless you opted in.
 */
export function resolveModuleMode(
  setting: string | undefined,
  sourceRoots: readonly string[],
): PythonModuleMode {
  if (setting === "local" || setting === "remote") {
    return setting;
  }
  return sourceRoots.length > 0 ? "local" : "remote";
}

/**
 * Source roots a `pyproject.toml` names: setuptools `packages.find.where`
 * or `package-dir` `""`, Hatch wheel `packages`, Poetry `packages.from`.
 * Only these keys are read (no TOML parser); undefined when none is set.
 */
export function sourceRootsFromPyproject(text: string): string[] | undefined {
  const roots = new Set<string>();
  let section = "";
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = stripTomlComment(lines[i]).trim();
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header !== null) {
      section = header[1];
      continue;
    }
    // Multi-line arrays: read on until the closing bracket.
    while (/=\s*\[/.test(line) && !balanced(line) && i + 1 < lines.length) {
      line += " " + stripTomlComment(lines[++i]).trim();
    }
    const [key, value] = splitTomlKey(line);
    if (key === undefined) {
      continue;
    }
    if (section === "tool.setuptools.packages.find" && key === "where") {
      tomlStrings(value).forEach((r) => roots.add(r));
    } else if (section === "tool.setuptools" && key === "package-dir") {
      const root = /["']{2}\s*=\s*["']([^"']+)["']/.exec(value)?.[1];
      if (root !== undefined) {
        roots.add(root);
      }
    } else if (
      section === "tool.setuptools.package-dir" &&
      /^["']{2}$/.test(key)
    ) {
      tomlStrings(value).forEach((r) => roots.add(r));
    } else if (
      section === "tool.hatch.build.targets.wheel" &&
      key === "packages"
    ) {
      tomlStrings(value).forEach((p) => roots.add(path.posix.dirname(p)));
    } else if (section === "tool.poetry" && key === "packages") {
      for (const match of value.matchAll(/from\s*=\s*["']([^"']+)["']/g)) {
        roots.add(match[1]);
      }
    }
  }
  return roots.size > 0 ? [...roots] : undefined;
}

/**
 * The top-level package an `ImportError`/`ModuleNotFoundError` is about,
 * e.g. `analytics` for "cannot import name 'entity' from 'analytics' (…)"
 * or "No module named 'analytics.entity'"; undefined for other errors.
 */
export function failedImportPackage(
  errorName: string | undefined,
  errorValue: string | undefined,
): string | undefined {
  if (errorName !== "ImportError" && errorName !== "ModuleNotFoundError") {
    return undefined;
  }
  const name =
    /from (?:partially initialized module )?['"]([^'"]+)['"]/.exec(
      errorValue ?? "",
    )?.[1] ?? /No module named ['"]([^'"]+)['"]/.exec(errorValue ?? "")?.[1];
  return name?.split(".")[0];
}

/** How the mode is shown, the same in the status bar and the side bar. */
export interface ModulesDescription {
  readonly mode: PythonModuleMode;
  /** "Local · analytics", "Remote", "Remote · no local packages". */
  readonly label: string;
  readonly icon: "file-code" | "cloud";
  readonly tooltip: string;
}

export function describeModules(
  mode: PythonModuleMode,
  packages: readonly string[],
): ModulesDescription {
  if (mode === "local") {
    return {
      mode,
      label: packages.length > 0 ? `Local · ${packages.join(", ")}` : "Local",
      icon: "file-code",
      tooltip:
        "Python imports use your working tree, staged to the session before Python runs.",
    };
  }
  return {
    mode,
    label: packages.length > 0 ? "Remote" : "Remote · no local packages",
    icon: "cloud",
    tooltip:
      "Python imports use what the Fabric environment has installed (e.g. your wheel).",
  };
}

/** The hint added to an import error when the package is also local. */
export function localModuleHint(
  packageName: string,
  localPath: string,
): string {
  return (
    `'${packageName}' is also in your repo (${localPath}), but Python modules are set to Remote, ` +
    "so the Fabric environment's installed copy was imported. " +
    "Run 'Fabric: Python Modules' and pick Local to import your working tree."
  );
}

function stripTomlComment(line: string): string {
  // Good enough for the keys above: a '#' outside quotes starts a comment.
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === '"' && c === "\\") {
      i++; // basic strings escape: skip the escaped character
    } else if (quote !== undefined) {
      quote = c === quote ? undefined : quote;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function balanced(line: string): boolean {
  return line.split("[").length === line.split("]").length;
}

function splitTomlKey(line: string): [string | undefined, string] {
  const eq = line.indexOf("=");
  return eq <= 0
    ? [undefined, ""]
    : [line.slice(0, eq).trim(), line.slice(eq + 1).trim()];
}

function tomlStrings(value: string): string[] {
  // Basic strings ("…") may contain \" escapes; literal strings ('…') may not.
  return [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(
    (m) => m[2] ?? m[1].replace(/\\(.)/g, "$1"),
  );
}
