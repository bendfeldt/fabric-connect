/**
 * Repo tree: how the Repo view shows the working tree. Only Fabric items
 * appear, inside the repo's folders that lead to them: a folder holding a
 * `.platform` file is an item (shown by its display name, `.platform`
 * itself hidden, its own files listed under it); folders without items and
 * loose files are left out.
 *
 * Pure functions over paths and directory listings, so the view's rules
 * are unit-testable without VS Code or a disk.
 */

import * as path from "node:path";

export const PLATFORM_FILE = ".platform";

/** One directory entry as listed from disk. */
export interface DirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

/** How an item runs on Fabric, if at all. */
export type RunKind = "notebook" | "sparkJob";

/** Never worth showing in a repo view, whatever `files.exclude` says. */
const ALWAYS_HIDDEN = new Set([".git", "node_modules"]);

const NOTEBOOK_CONTENT = /^notebook-content\.(ipynb|py|scala|sql|r)$/i;

/**
 * Names to hide, from a `files.exclude` setting: entries whose pattern is a
 * plain name (`.DS_Store`) or `**\/name`, set to `true`. Patterns with other
 * wildcards or `when` clauses are not interpreted here.
 */
export function hiddenNames(filesExclude: unknown): Set<string> {
  const hidden = new Set(ALWAYS_HIDDEN);
  if (typeof filesExclude !== "object" || filesExclude === null) {
    return hidden;
  }
  for (const [pattern, enabled] of Object.entries(filesExclude)) {
    if (enabled !== true) {
      continue;
    }
    const name = pattern.replace(/^\*\*\//, "");
    if (name.length > 0 && !/[*?[\]{}/]/.test(name)) {
      hidden.add(name);
    }
  }
  return hidden;
}

/**
 * The entries of one folder in display order: folders before files, each
 * by name (case-insensitive). Hidden names are dropped, and so is
 * `.platform` in an item folder (the item node stands for it).
 */
export function visibleEntries(
  entries: readonly DirEntry[],
  hidden: ReadonlySet<string>,
  isItemFolder: boolean,
): DirEntry[] {
  return entries
    .filter(
      (e) => !hidden.has(e.name) && !(isItemFolder && e.name === PLATFORM_FILE),
    )
    .sort((a, b) =>
      a.isDirectory === b.isDirectory
        ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
        : a.isDirectory
          ? -1
          : 1,
    );
}

/** True when a folder listing contains a `.platform` file. */
export function isItemFolder(entries: readonly DirEntry[]): boolean {
  return entries.some((e) => !e.isDirectory && e.name === PLATFORM_FILE);
}

/**
 * The file a Notebook item opens in the notebook editor: `.ipynb` when
 * present, else the git source format file.
 */
export function notebookContentFile(
  entries: readonly DirEntry[],
): string | undefined {
  const candidates = entries
    .filter((e) => !e.isDirectory && NOTEBOOK_CONTENT.test(e.name))
    .map((e) => e.name);
  return (
    candidates.find((name) => /\.ipynb$/i.test(name)) ?? candidates.sort()[0]
  );
}

/** How an item of this Fabric type runs; undefined when it does not. */
export function itemRunKind(itemType: string): RunKind | undefined {
  switch (itemType) {
    case "Notebook":
      return "notebook";
    case "SparkJobDefinition":
      return "sparkJob";
    default:
      return undefined;
  }
}

/**
 * Folders the Repo view shows outside items: every item folder (the one
 * holding a `.platform`) and every folder between the root and it, as
 * root-relative paths with `/` separators (`""` is the root). Paths outside
 * the root are ignored.
 */
export function foldersWithItems(
  platformFiles: readonly string[],
  root: string,
): Set<string> {
  const folders = new Set<string>();
  for (const file of platformFiles) {
    const relative = relativeKey(root, path.dirname(file));
    if (relative === undefined) {
      continue;
    }
    const parts = relative === "" ? [] : relative.split("/");
    for (let depth = 0; depth <= parts.length; depth++) {
      folders.add(parts.slice(0, depth).join("/"));
    }
  }
  return folders;
}

/** A folder's root-relative path with `/` separators; undefined outside it. */
export function relativeKey(root: string, folder: string): string | undefined {
  const relative = path.relative(root, folder).split(/[\\/]/).join("/");
  if (
    relative === ".." ||
    relative.startsWith("../") ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return relative;
}
