/**
 * Local module staging — the part that makes this feel like Databricks
 * Connect: `import mypkg` in a notebook cell or a run file resolves to the
 * code in your working tree, not to a wheel someone uploaded.
 *
 * The configured source roots are zipped (deterministically) and sent inside
 * the statement itself: the driver writes the zip to its temp folder, adds it
 * with `sc.addPyFile` (which also ships it to executors), and stale copies of
 * the same packages are dropped from `sys.modules` so the new code is what
 * gets imported. Nothing is written to OneLake, so the host Lakehouse needs
 * no write access. Unchanged sources are not decoded again (content hash).
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

/** The staged file name of a bundle; the hash keeps versions apart. */
export function bundleFileName(hash: string): string {
  return `modules-${hash.slice(0, 16)}.zip`;
}

/**
 * Python that writes the bundle to the driver's temp folder, makes it
 * importable in the session and drops stale copies of its packages so the
 * next import loads the new code. It is idempotent per session: re-sending
 * the same bundle is a no-op, so module state survives until the sources
 * actually change.
 *
 * ponytail: the whole bundle travels base64-encoded in every statement, so
 * Livy's statement size limit is the ceiling for local sources; stage on
 * OneLake again only if real projects outgrow it.
 */
export function moduleImportCode(
  zipBase64: string,
  fileName: string,
  topLevel: readonly string[],
): string {
  return [
    "import sys as _fc_sys, importlib as _fc_importlib, os as _fc_os, tempfile as _fc_tempfile, base64 as _fc_base64",
    "_fc_staged = globals().setdefault('_fc_staged', set())",
    `_fc_bundle = _fc_os.path.join(_fc_tempfile.gettempdir(), "fabric-connect", ${JSON.stringify(fileName)})`,
    "if _fc_bundle not in _fc_staged:",
    "    _fc_os.makedirs(_fc_os.path.dirname(_fc_bundle), exist_ok=True)",
    "    with open(_fc_bundle, 'wb') as _fc_file:",
    `        _fc_file.write(_fc_base64.b64decode(${JSON.stringify(zipBase64)}))`,
    "    spark.sparkContext.addPyFile(_fc_bundle)",
    `    _fc_names = set(${JSON.stringify(topLevel)})`,
    "    for _fc_name in [m for m in _fc_sys.modules if m.split('.')[0] in _fc_names]:",
    "        del _fc_sys.modules[_fc_name]",
    "    _fc_importlib.invalidate_caches()",
    "    _fc_staged.add(_fc_bundle)",
    '_fabric_connect_sources = {"bundle": _fc_bundle}',
  ].join("\n");
}

/**
 * Where `import` finds your packages: `local` stages the working tree,
 * `remote` uses what the Fabric environment has installed (e.g. a wheel).
 */
export type PythonModuleMode = "local" | "wheel" | "remote";

/**
 * The effective mode. `auto` keeps the behaviour from before the setting
 * existed: configured source roots mean local, otherwise remote — so
 * nothing is uploaded to OneLake unless you opted in.
 */
export function resolveModuleMode(
  setting: string | undefined,
  sourceRoots: readonly string[],
): PythonModuleMode {
  if (setting === "local" || setting === "wheel" || setting === "remote") {
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
  readonly icon: "file-code" | "cloud" | "package";
  readonly tooltip: string;
}

export function describeModules(
  mode: PythonModuleMode,
  packages: readonly string[],
  wheelName?: string,
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
  if (mode === "wheel") {
    return {
      mode,
      label: `Wheel · ${wheelName ?? "not selected"}`,
      icon: "package",
      tooltip:
        "The selected local wheel is staged temporarily and installed into the Livy session before Python runs.",
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

export interface WheelFileManifest {
  readonly fileName: string;
  readonly size: number;
  readonly sha256: string;
}

export function wheelInitializeCode(
  contentHash: string,
  files: readonly WheelFileManifest[],
): string {
  return `import pathlib, tempfile
root = pathlib.Path(tempfile.gettempdir()) / "fabric-connect" / ${JSON.stringify(contentHash)} / "wheelhouse"
root.mkdir(parents=True, exist_ok=True)
for name in ${JSON.stringify(files.map((file) => file.fileName))}:
    (root / name).write_bytes(b"")`;
}

// shortcut: wheelhouse transfer is unbounded, add a cap after live Fabric limits are measured.
export function wheelChunkCode(
  contentHash: string,
  fileName: string,
  offset: number,
  dataBase64: string,
): string {
  return `import base64, pathlib, tempfile
path = pathlib.Path(tempfile.gettempdir()) / "fabric-connect" / ${JSON.stringify(contentHash)} / "wheelhouse" / ${JSON.stringify(fileName)}
with path.open("r+b") as wheel:
    wheel.seek(${offset})
    wheel.write(base64.b64decode(${JSON.stringify(dataBase64)}))`;
}

export function wheelInstallCode(
  selectedWheel: string,
  contentHash: string,
  files: readonly WheelFileManifest[],
): string {
  const manifest = JSON.stringify(files);
  const sentinel = `_fabric_connect_manifest_${contentHash}`;
  return `import hashlib, pathlib, shutil, subprocess, sys, tempfile, zipfile
from email.parser import Parser

content_hash = ${JSON.stringify(contentHash)}
manifest = ${manifest}
selected_wheel = ${JSON.stringify(selectedWheel)}
root = pathlib.Path(tempfile.gettempdir()) / "fabric-connect" / content_hash
wheelhouse = root / "wheelhouse"
for item in manifest:
    path = wheelhouse / item["fileName"]
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(262144), b""):
            size += len(chunk)
            digest.update(chunk)
    if size != item["size"] or digest.hexdigest() != item["sha256"]:
        raise RuntimeError("Transferred wheel failed size or SHA-256 verification: " + item["fileName"])

wheel_path = wheelhouse / selected_wheel
with zipfile.ZipFile(wheel_path) as wheel:
    metadata_files = [name for name in wheel.namelist() if name.endswith(".dist-info/WHEEL")]
    if len(metadata_files) != 1:
        raise RuntimeError("Selected wheel has invalid WHEEL metadata.")
    metadata = Parser().parsestr(wheel.read(metadata_files[0]).decode("utf-8"))
    tags = metadata.get_all("Tag", [])
    if metadata.get("Root-Is-Purelib", "").lower() != "true" or not tags or any(tag.rsplit("-", 1)[-1] != "any" for tag in tags):
        raise RuntimeError("Only pure-Python wheels with platform tag 'any' are supported.")

target = root / "installed"
if target.exists():
    shutil.rmtree(target)
subprocess.run([sys.executable, "-m", "pip", "install", "--no-index", "--find-links", str(wheelhouse), "--target", str(target), "--ignore-installed", str(wheel_path)], check=True)
for path in target.rglob("*"):
    if path.is_file() and (path.suffix.lower() in {".so", ".pyd", ".dll", ".dylib", ".pth"} or ".so." in path.name.lower()):
        raise RuntimeError("Wheel installation contains an unsupported native or .pth file: " + path.name)
if str(target) not in sys.path:
    sys.path.insert(0, str(target))

sentinel = target / ${JSON.stringify(sentinel + ".py")}
sentinel.write_text("MANIFEST_HASH = " + repr(content_hash) + "\\n", encoding="utf-8")
archive = root / (content_hash + ".zip")
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
    for path in target.rglob("*"):
        if path.is_file():
            bundle.write(path, path.relative_to(target).as_posix())
spark.sparkContext.addPyFile(str(archive))
def _fabric_connect_preflight(_):
    import importlib
    module = importlib.import_module(${JSON.stringify(sentinel)})
    if module.MANIFEST_HASH != content_hash:
        raise RuntimeError("Spark worker loaded a mismatched wheel manifest.")
    return module.MANIFEST_HASH
assert spark.sparkContext.parallelize([0], 1).map(_fabric_connect_preflight).collect() == [content_hash]`;
}
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
