/**
 * Notebook Fidelity Module: reads/writes the Fabric notebook (.ipynb) file
 * format 1:1 with the portal.
 *
 * Fidelity rules that make "100% compatible" a property, not a goal:
 *  - Unknown fields anywhere in the document survive parse → serialize
 *    unchanged. The model keeps the raw JSON objects and mutates only the
 *    specific paths this extension understands.
 *  - A parse → serialize round-trip of an unmodified notebook returns the
 *    original text byte-for-byte.
 */

import { NotebookFidelityError } from './errors';

export interface INotebookCodec {
  parse(text: string, fileName: string): NotebookModel;
  serialize(model: NotebookModel): string;
}

export interface LakehouseAttachment {
  readonly id: string;
  readonly name?: string;
  readonly workspaceId?: string;
}

export interface NotebookCellModel {
  readonly cellType: string;
  readonly language: string | undefined;
  source: string;
  /** The cell's full raw JSON object; unknown fields live here untouched. */
  readonly raw: Record<string, unknown>;
}

/** Jupyter serializes with 1-space indent; the Fabric portal matches it. */
const IPYNB_INDENT = 1;

export class NotebookModel {
  private dirty = false;

  constructor(
    readonly fileName: string,
    private readonly root: Record<string, unknown>,
    private readonly originalText: string,
    readonly cells: NotebookCellModel[],
  ) {}

  markDirty(): void {
    this.dirty = true;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  /** Default + attached lakehouses, from the same metadata Fabric writes. */
  getLakehouseAttachments(): {
    defaultLakehouse?: LakehouseAttachment;
    known: LakehouseAttachment[];
  } {
    const dep = this.lakehouseMetadata(false);
    if (dep === undefined) {
      return { known: [] };
    }
    const defaultId = asString(dep['default_lakehouse']);
    const defaultLakehouse: LakehouseAttachment | undefined =
      defaultId === undefined
        ? undefined
        : {
            id: defaultId,
            name: asString(dep['default_lakehouse_name']),
            workspaceId: asString(dep['default_lakehouse_workspace_id']),
          };
    const knownRaw = dep['known_lakehouses'];
    const known: LakehouseAttachment[] = [];
    if (Array.isArray(knownRaw)) {
      for (const entry of knownRaw) {
        if (typeof entry === 'object' && entry !== null) {
          const id = asString((entry as Record<string, unknown>)['id']);
          if (id !== undefined) {
            known.push({ id });
          }
        }
      }
    }
    return { defaultLakehouse, known };
  }

  attachLakehouse(lakehouse: LakehouseAttachment, makeDefault: boolean): void {
    const dep = this.lakehouseMetadata(true)!;
    const known = this.knownList(dep);
    if (!known.some((k) => asString(k['id']) === lakehouse.id)) {
      known.push({ id: lakehouse.id });
    }
    if (makeDefault || dep['default_lakehouse'] === undefined) {
      dep['default_lakehouse'] = lakehouse.id;
      if (lakehouse.name !== undefined) {
        dep['default_lakehouse_name'] = lakehouse.name;
      }
      if (lakehouse.workspaceId !== undefined) {
        dep['default_lakehouse_workspace_id'] = lakehouse.workspaceId;
      }
    }
    this.markDirty();
  }

  detachLakehouse(lakehouseId: string): void {
    const dep = this.lakehouseMetadata(false);
    if (dep === undefined) {
      return;
    }
    const known = this.knownList(dep);
    const filtered = known.filter((k) => asString(k['id']) !== lakehouseId);
    dep['known_lakehouses'] = filtered;
    if (dep['default_lakehouse'] === lakehouseId) {
      delete dep['default_lakehouse'];
      delete dep['default_lakehouse_name'];
      delete dep['default_lakehouse_workspace_id'];
    }
    this.markDirty();
  }

  serialize(): string {
    if (!this.dirty) {
      // Byte-for-byte fidelity for unmodified notebooks.
      return this.originalText;
    }
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i];
      cell.raw['source'] = splitSource(cell.source);
    }
    this.root['cells'] = this.cells.map((c) => c.raw);
    return JSON.stringify(this.root, undefined, IPYNB_INDENT) + '\n';
  }

  private knownList(dep: Record<string, unknown>): Record<string, unknown>[] {
    let known = dep['known_lakehouses'];
    if (!Array.isArray(known)) {
      known = [];
      dep['known_lakehouses'] = known;
    }
    return known as Record<string, unknown>[];
  }

  private lakehouseMetadata(
    create: boolean,
  ): Record<string, unknown> | undefined {
    const metadata = this.ensureObject(this.root, 'metadata', create);
    if (metadata === undefined) {
      return undefined;
    }
    const dependencies = this.ensureObject(metadata, 'dependencies', create);
    if (dependencies === undefined) {
      return undefined;
    }
    return this.ensureObject(dependencies, 'lakehouse', create);
  }

  private ensureObject(
    parent: Record<string, unknown>,
    key: string,
    create: boolean,
  ): Record<string, unknown> | undefined {
    const value = parent[key];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    if (!create) {
      return undefined;
    }
    const created: Record<string, unknown> = {};
    parent[key] = created;
    return created;
  }
}

export class NotebookCodec implements INotebookCodec {
  parse(text: string, fileName: string): NotebookModel {
    let root: unknown;
    try {
      root = JSON.parse(text);
    } catch (cause) {
      throw new NotebookFidelityError(
        `Failed to read notebook '${fileName}': the file is not valid JSON (corrupt or not an .ipynb file).`,
        {
          operation: 'parse notebook',
          entity: `file ${fileName}`,
          remediation:
            'Restore the file from git or re-export it from the Fabric portal.',
          cause,
        },
      );
    }
    if (typeof root !== 'object' || root === null || Array.isArray(root)) {
      throw new NotebookFidelityError(
        `Failed to read notebook '${fileName}': the top-level value is not an object.`,
        {
          operation: 'parse notebook',
          entity: `file ${fileName}`,
          remediation: 'Re-export the notebook from the Fabric portal.',
        },
      );
    }
    const record = root as Record<string, unknown>;
    const nbformat = record['nbformat'];
    if (nbformat !== undefined && nbformat !== 4) {
      throw new NotebookFidelityError(
        `Failed to read notebook '${fileName}': unsupported notebook schema version (nbformat ${String(nbformat)}); only nbformat 4 is supported.`,
        {
          operation: 'parse notebook',
          entity: `file ${fileName}`,
          remediation:
            'Convert the notebook to nbformat 4, or re-export it from the Fabric portal.',
        },
      );
    }
    const rawCells = record['cells'];
    if (!Array.isArray(rawCells)) {
      throw new NotebookFidelityError(
        `Failed to read notebook '${fileName}': the 'cells' section is missing or not a list.`,
        {
          operation: 'parse notebook',
          entity: `file ${fileName}, section 'cells'`,
          remediation: 'Re-export the notebook from the Fabric portal.',
        },
      );
    }

    const defaultLanguage = readDefaultLanguage(record);
    const cells: NotebookCellModel[] = rawCells.map((raw, index) => {
      if (typeof raw !== 'object' || raw === null) {
        throw new NotebookFidelityError(
          `Failed to read notebook '${fileName}': cell ${index} is not an object.`,
          {
            operation: 'parse notebook',
            entity: `file ${fileName}, cell ${index}`,
            remediation: 'Re-export the notebook from the Fabric portal.',
          },
        );
      }
      const cell = raw as Record<string, unknown>;
      const cellType = asString(cell['cell_type']);
      if (cellType === undefined) {
        throw new NotebookFidelityError(
          `Failed to read notebook '${fileName}': cell ${index} has no 'cell_type' field.`,
          {
            operation: 'parse notebook',
            entity: `file ${fileName}, cell ${index}`,
            remediation: 'Re-export the notebook from the Fabric portal.',
          },
        );
      }
      return {
        cellType,
        language:
          cellType === 'markdown' ? 'markdown' : cellLanguage(cell) ?? defaultLanguage,
        source: joinSource(cell['source']),
        raw: cell,
      };
    });

    return new NotebookModel(fileName, record, text, cells);
  }

  serialize(model: NotebookModel): string {
    try {
      return model.serialize();
    } catch (cause) {
      throw new NotebookFidelityError(
        `Failed to write notebook '${model.fileName}': serialization failed.`,
        {
          operation: 'serialize notebook',
          entity: `file ${model.fileName}`,
          remediation:
            'Undo the last change, or restore the file from git, then retry saving.',
          cause,
        },
      );
    }
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readDefaultLanguage(root: Record<string, unknown>): string {
  const metadata = root['metadata'];
  if (typeof metadata === 'object' && metadata !== null) {
    const languageInfo = (metadata as Record<string, unknown>)['language_info'];
    if (typeof languageInfo === 'object' && languageInfo !== null) {
      const name = asString((languageInfo as Record<string, unknown>)['name']);
      if (name !== undefined) {
        return name;
      }
    }
  }
  return 'python';
}

function cellLanguage(cell: Record<string, unknown>): string | undefined {
  const metadata = cell['metadata'];
  if (typeof metadata === 'object' && metadata !== null) {
    return asString((metadata as Record<string, unknown>)['language']);
  }
  return undefined;
}

/** ipynb sources are string-or-line-array; normalize to one string. */
function joinSource(source: unknown): string {
  if (typeof source === 'string') {
    return source;
  }
  if (Array.isArray(source)) {
    return source.filter((line) => typeof line === 'string').join('');
  }
  return '';
}

/** Write back in Jupyter's canonical line-array form. */
function splitSource(source: string): string[] {
  if (source.length === 0) {
    return [];
  }
  const lines = source.split('\n');
  return lines.map((line, i) => (i < lines.length - 1 ? line + '\n' : line)).filter(
    (line, i, all) => !(i === all.length - 1 && line === ''),
  );
}
