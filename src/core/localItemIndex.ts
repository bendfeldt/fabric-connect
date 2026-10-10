/**
 * Local item index: what Fabric items this working tree contains, read from
 * the `.platform` files Fabric's git integration writes next to every item
 * (`<name>.<Type>/.platform`). It maps display name and logicalId to the
 * local folder, so `%run OtherNotebook` and GUID hovers resolve against the
 * repo — never against whatever happens to be deployed in a workspace.
 */

import * as path from "node:path";
import { ItemMetadataError } from "./errors";
import { isRecord } from "./types";

export interface LocalItem {
  readonly type: string;
  readonly displayName: string;
  readonly logicalId?: string;
  readonly description?: string;
  /** Absolute path of the item folder (the one holding `.platform`). */
  readonly folder: string;
}

/** Filesystem seam so the index is unit-testable without touching disk. */
export interface ItemIndexFileSystem {
  /** Absolute paths of every `.platform` file under the workspace. */
  findPlatformFiles(): Promise<string[]>;
  readFile(filePath: string): Promise<string | undefined>;
}

export class LocalItemIndex {
  private constructor(
    readonly items: readonly LocalItem[],
    /** `.platform` files that could not be read or parsed (skipped). */
    readonly skipped: readonly string[],
  ) {}

  static async build(fs: ItemIndexFileSystem): Promise<LocalItemIndex> {
    const items: LocalItem[] = [];
    const skipped: string[] = [];
    for (const file of (await fs.findPlatformFiles()).sort()) {
      const item = parsePlatform(await fs.readFile(file), path.dirname(file));
      if (item === undefined) {
        skipped.push(file);
      } else {
        items.push(item);
      }
    }
    return new LocalItemIndex(items, skipped);
  }

  /** Items of a type with this display name (case-insensitive, like Fabric). */
  findByName(type: string, displayName: string): LocalItem[] {
    const wantedType = type.toLowerCase();
    const wantedName = displayName.toLowerCase();
    return this.items.filter(
      (i) =>
        i.type.toLowerCase() === wantedType &&
        i.displayName.toLowerCase() === wantedName,
    );
  }

  findByLogicalId(logicalId: string): LocalItem | undefined {
    const wanted = logicalId.toLowerCase();
    return this.items.find((i) => i.logicalId?.toLowerCase() === wanted);
  }
}

/**
 * The local item index, built once and reused until `invalidate()` (called
 * when a `.platform` file is created, changed or deleted), so views and
 * runs do not rescan the repo each time. A failed build is not cached.
 */
export class CachedItemIndex {
  private pending: Promise<LocalItemIndex> | undefined;

  constructor(private readonly fs: ItemIndexFileSystem) {}

  get(): Promise<LocalItemIndex> {
    this.pending ??= LocalItemIndex.build(this.fs).catch((error: unknown) => {
      this.pending = undefined;
      throw error;
    });
    return this.pending;
  }

  invalidate(): void {
    this.pending = undefined;
  }
}

/** Parses one `.platform` file; undefined when it is not a usable one. */
export function parsePlatform(
  text: string | undefined,
  folder: string,
): LocalItem | undefined {
  if (text === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed["metadata"])) {
    return undefined;
  }
  const metadata = parsed["metadata"];
  const type = metadata["type"];
  const displayName = metadata["displayName"];
  if (typeof type !== "string" || typeof displayName !== "string") {
    return undefined;
  }
  const config = isRecord(parsed["config"]) ? parsed["config"] : {};
  const logicalId = config["logicalId"];
  const description = metadata["description"];
  return {
    type,
    displayName,
    folder,
    ...(typeof logicalId === "string" ? { logicalId } : {}),
    ...(typeof description === "string" && description.length > 0
      ? { description }
      : {}),
  };
}

export interface PlatformChanges {
  readonly displayName?: string;
  /** An empty description removes the key, as Fabric omits it. */
  readonly description?: string;
}

/**
 * Returns `.platform` text with the item's display name and/or description
 * changed. Every other field, the key order, the indentation, the line
 * endings and the trailing newline are kept; unchanged input comes back
 * byte-for-byte. Throws `ItemMetadataError` for a file that is not a
 * usable `.platform` or an empty display name.
 */
export function updatePlatform(text: string, changes: PlatformChanges): string {
  const fail = (why: string, cause?: unknown) =>
    new ItemMetadataError(`Cannot edit item metadata: ${why}.`, {
      operation: "edit item metadata",
      entity: "file .platform",
      remediation:
        "Open the .platform file and fix it by hand, or pull the item into the repo again.",
      cause,
    });
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(bom.length));
  } catch (cause) {
    throw fail("the file is not valid JSON", cause);
  }
  if (!isRecord(parsed) || !isRecord(parsed["metadata"])) {
    throw fail('it has no "metadata" object');
  }
  const metadata = parsed["metadata"];
  let changed = false;
  if (changes.displayName !== undefined) {
    const name = changes.displayName.trim();
    if (name.length === 0) {
      throw new ItemMetadataError(
        "Cannot edit item metadata: the display name is empty.",
        {
          operation: "edit item metadata",
          entity: "file .platform",
          remediation: "Enter a display name.",
        },
      );
    }
    if (metadata["displayName"] !== name) {
      metadata["displayName"] = name;
      changed = true;
    }
  }
  if (changes.description !== undefined) {
    const description = changes.description.trim();
    if (description.length === 0) {
      if ("description" in metadata) {
        delete metadata["description"];
        changed = true;
      }
    } else if (metadata["description"] !== description) {
      metadata["description"] = description;
      changed = true;
    }
  }
  if (!changed) {
    return text;
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? "  ";
  const body = JSON.stringify(parsed, undefined, indent).replace(/\n/g, eol);
  return bom + (/\r?\n$/.test(text) ? body + eol : body);
}
