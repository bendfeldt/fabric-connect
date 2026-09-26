/**
 * Local item index: what Fabric items this working tree contains, read from
 * the `.platform` files Fabric's git integration writes next to every item
 * (`<name>.<Type>/.platform`). It maps display name and logicalId to the
 * local folder, so `%run OtherNotebook` and GUID hovers resolve against the
 * repo — never against whatever happens to be deployed in a workspace.
 */

import * as path from "node:path";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
