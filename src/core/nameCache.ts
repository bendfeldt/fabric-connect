/**
 * Names for GUIDs: remembers every workspace, item and capacity the
 * explorer has listed, so hovering a GUID anywhere in the editor (a
 * `.platform` file, notebook metadata, local.json) can say what it is.
 * Local items from the working tree's `.platform` files are looked up by
 * logicalId as well. Memory only — nothing is written to disk.
 */

import type { LocalItemIndex } from "./localItemIndex";

export interface NamedEntity {
  readonly kind: "workspace" | "item" | "capacity" | "local item";
  readonly displayName: string;
  /** Item type (Notebook, Lakehouse, …) or capacity SKU. */
  readonly type?: string;
  readonly workspaceName?: string;
  /** For local items: the folder path relative to the workspace root. */
  readonly folder?: string;
}

const GUID_AT =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The GUID under `character` in a line of text, if any. */
export function guidAt(line: string, character: number): string | undefined {
  for (const match of line.matchAll(GUID_AT)) {
    const start = match.index ?? 0;
    if (character >= start && character <= start + match[0].length) {
      return match[0].toLowerCase();
    }
  }
  return undefined;
}

export class NameCache {
  private readonly names = new Map<string, NamedEntity>();

  remember(id: string, entity: NamedEntity): void {
    this.names.set(id.toLowerCase(), entity);
  }

  lookup(id: string, local?: LocalItemIndex): NamedEntity | undefined {
    const known = this.names.get(id.toLowerCase());
    if (known !== undefined) {
      return known;
    }
    const item = local?.findByLogicalId(id);
    return item === undefined
      ? undefined
      : {
          kind: "local item",
          displayName: item.displayName,
          type: item.type,
          folder: item.folder,
        };
  }

  /** A one-line Markdown description (names escaped by the caller's renderer). */
  static describe(entity: NamedEntity): string {
    const type = entity.type === undefined ? "" : ` (${entity.type})`;
    const where =
      entity.workspaceName !== undefined
        ? ` in workspace ${entity.workspaceName}`
        : entity.folder !== undefined
          ? ` at ${entity.folder}`
          : "";
    return `Fabric ${entity.kind}: ${entity.displayName}${type}${where}`;
  }
}
