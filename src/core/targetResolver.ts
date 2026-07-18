/**
 * Target Config Module: resolves `folder path → target → workspace ID`.
 *
 * Target *shape* (name, item type, tenant) is committed in
 * `.fabric/targets.json`; the actual workspace ID resolves from a local,
 * gitignored `.fabric/local.json`. Resolution failures are loud and
 * specific by design: the real risk is not a crash, it is silently
 * executing against the wrong client's workspace, so there is no fallback
 * default anywhere in this module.
 */

import * as path from 'node:path';
import { TargetConfigError } from './errors';
import type { ITargetResolver, ResolvedTarget } from './types';

export const TARGETS_FILE = path.join('.fabric', 'targets.json');
export const LOCAL_OVERRIDE_FILE = path.join('.fabric', 'local.json');

/** Filesystem seam so the module is unit-testable without touching disk. */
export interface TargetFileSystem {
  /** Returns file text, or undefined if the file does not exist. */
  readFile(filePath: string): Promise<string | undefined>;
}

export interface ItemTypeHandler {
  readonly itemType: string;
}

interface TargetShape {
  readonly itemType: string;
  readonly tenantId: string;
}

const WORKSPACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TargetResolver implements ITargetResolver {
  private readonly handlers = new Map<string, ItemTypeHandler>();

  constructor(
    private readonly fs: TargetFileSystem,
    /** Root the resolver may not escape (the VS Code workspace folder). */
    private readonly workspaceRoot: string,
  ) {}

  /**
   * Item types are added via this registry, not hardcoded: Part 2 registers
   * `pipeline` here instead of modifying this module.
   */
  registerItemType(itemType: string, handler: ItemTypeHandler): void {
    this.handlers.set(itemType, handler);
  }

  async resolveTarget(folderPath: string): Promise<ResolvedTarget> {
    const root = path.resolve(this.workspaceRoot);
    const folder = path.resolve(folderPath);
    if (folder !== root && !folder.startsWith(root + path.sep)) {
      throw new TargetConfigError(
        `Cannot resolve a Fabric target for '${folderPath}': it is outside the workspace folder '${this.workspaceRoot}'.`,
        {
          operation: 'resolve target',
          entity: `folder ${folderPath}`,
          remediation:
            'Open the folder inside the VS Code workspace, or fix the target mapping so it does not point outside the workspace.',
        },
      );
    }

    const targetsPath = path.join(root, TARGETS_FILE);
    const targetsText = await this.fs.readFile(targetsPath);
    if (targetsText === undefined) {
      throw new TargetConfigError(
        `No Fabric target configuration found for folder '${folderPath}': '${TARGETS_FILE}' does not exist in the workspace.`,
        {
          operation: 'resolve target',
          entity: `folder ${folderPath}`,
          remediation: `Create '${TARGETS_FILE}' declaring your targets, e.g. { "folders": { ".": "dev" }, "targets": { "dev": { "itemType": "notebook", "tenantId": "<tenant-guid>" } } }.`,
        },
      );
    }

    const targets = this.parseTargetsFile(targetsText, targetsPath);
    const targetName = this.matchFolder(targets.folders, root, folder);
    if (targetName === undefined) {
      throw new TargetConfigError(
        `Folder '${folderPath}' is not mapped to any target in '${TARGETS_FILE}'.`,
        {
          operation: 'resolve target',
          entity: `folder ${folderPath}`,
          remediation: `Add a folder mapping in '${TARGETS_FILE}' under "folders", e.g. { "notebooks": "dev" }.`,
        },
      );
    }

    const shape = targets.targets[targetName];
    if (shape === undefined) {
      throw new TargetConfigError(
        `Folder '${folderPath}' maps to target '${targetName}', but '${TARGETS_FILE}' does not declare that target.`,
        {
          operation: 'resolve target',
          entity: `target ${targetName}`,
          remediation: `Declare target '${targetName}' under "targets" in '${TARGETS_FILE}'.`,
        },
      );
    }

    if (!this.handlers.has(shape.itemType)) {
      throw new TargetConfigError(
        `Target '${targetName}' declares item type '${shape.itemType}', which is not registered with this extension.`,
        {
          operation: 'resolve target',
          entity: `target ${targetName}`,
          remediation: `Use a registered item type (${[...this.handlers.keys()].join(', ') || 'none registered'}) or install the extension part that provides '${shape.itemType}'.`,
        },
      );
    }

    const workspaceId = await this.resolveWorkspaceId(root, targetName);
    return {
      targetName,
      workspaceId,
      itemType: shape.itemType,
      tenantId: shape.tenantId,
    };
  }

  private async resolveWorkspaceId(
    root: string,
    targetName: string,
  ): Promise<string> {
    const localPath = path.join(root, LOCAL_OVERRIDE_FILE);
    const localText = await this.fs.readFile(localPath);
    if (localText === undefined) {
      throw new TargetConfigError(
        `No local override file found while resolving target '${targetName}': '${LOCAL_OVERRIDE_FILE}' does not exist.`,
        {
          operation: 'resolve workspace ID',
          entity: `target ${targetName}`,
          remediation: `Create the gitignored file '${LOCAL_OVERRIDE_FILE}' with { "targets": { "${targetName}": { "workspaceId": "<workspace-guid>" } } }.`,
        },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(localText);
    } catch (cause) {
      throw new TargetConfigError(
        `The local override file '${LOCAL_OVERRIDE_FILE}' is not valid JSON.`,
        {
          operation: 'resolve workspace ID',
          entity: `target ${targetName}`,
          remediation: `Fix the JSON syntax in '${LOCAL_OVERRIDE_FILE}'.`,
          cause,
        },
      );
    }

    const workspaceId = this.readWorkspaceId(parsed, targetName);
    if (workspaceId === undefined) {
      throw new TargetConfigError(
        `The local override file '${LOCAL_OVERRIDE_FILE}' has no workspace ID for target '${targetName}'.`,
        {
          operation: 'resolve workspace ID',
          entity: `target ${targetName}`,
          remediation: `Add a workspace ID for target '${targetName}' in '${LOCAL_OVERRIDE_FILE}'.`,
        },
      );
    }
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw new TargetConfigError(
        `The workspace ID configured for target '${targetName}' in '${LOCAL_OVERRIDE_FILE}' is not a valid GUID: '${workspaceId}'.`,
        {
          operation: 'resolve workspace ID',
          entity: `target ${targetName}`,
          remediation: `Copy the workspace's GUID from the Fabric portal URL into '${LOCAL_OVERRIDE_FILE}'.`,
        },
      );
    }
    return workspaceId;
  }

  private readWorkspaceId(
    parsed: unknown,
    targetName: string,
  ): string | undefined {
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const targets = (parsed as Record<string, unknown>)['targets'];
    if (typeof targets !== 'object' || targets === null) {
      return undefined;
    }
    const entry = (targets as Record<string, unknown>)[targetName];
    if (typeof entry !== 'object' || entry === null) {
      return undefined;
    }
    const id = (entry as Record<string, unknown>)['workspaceId'];
    return typeof id === 'string' ? id : undefined;
  }

  private parseTargetsFile(
    text: string,
    filePath: string,
  ): { folders: Record<string, string>; targets: Record<string, TargetShape> } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new TargetConfigError(
        `The target configuration file '${filePath}' is not valid JSON.`,
        {
          operation: 'resolve target',
          entity: filePath,
          remediation: `Fix the JSON syntax in '${TARGETS_FILE}'.`,
          cause,
        },
      );
    }

    const bad = (why: string): TargetConfigError =>
      new TargetConfigError(
        `The target configuration file '${filePath}' is malformed: ${why}.`,
        {
          operation: 'resolve target',
          entity: filePath,
          remediation: `Fix '${TARGETS_FILE}' to the shape { "folders": { "<relative-folder>": "<target>" }, "targets": { "<target>": { "itemType": "notebook", "tenantId": "<guid>" } } }.`,
        },
      );

    if (typeof parsed !== 'object' || parsed === null) {
      throw bad('the root must be an object');
    }
    const record = parsed as Record<string, unknown>;
    const folders = record['folders'];
    const targets = record['targets'];
    if (typeof folders !== 'object' || folders === null) {
      throw bad('"folders" must be an object mapping folder paths to target names');
    }
    if (typeof targets !== 'object' || targets === null) {
      throw bad('"targets" must be an object of target declarations');
    }
    for (const [name, value] of Object.entries(folders)) {
      if (typeof value !== 'string') {
        throw bad(`folder mapping '${name}' must name a target (string)`);
      }
    }
    const shapes: Record<string, TargetShape> = {};
    for (const [name, value] of Object.entries(targets)) {
      if (typeof value !== 'object' || value === null) {
        throw bad(`target '${name}' must be an object`);
      }
      const entry = value as Record<string, unknown>;
      if (typeof entry['itemType'] !== 'string') {
        throw bad(`target '${name}' is missing "itemType"`);
      }
      if (typeof entry['tenantId'] !== 'string') {
        throw bad(`target '${name}' is missing "tenantId"`);
      }
      shapes[name] = {
        itemType: entry['itemType'],
        tenantId: entry['tenantId'],
      };
    }
    return { folders: folders as Record<string, string>, targets: shapes };
  }

  /**
   * Picks the most specific folder mapping that contains `folder`.
   * Mappings are relative to the workspace root; "." maps the root itself.
   */
  private matchFolder(
    folders: Record<string, string>,
    root: string,
    folder: string,
  ): string | undefined {
    let best: { depth: number; target: string } | undefined;
    for (const [mapped, target] of Object.entries(folders)) {
      const mappedAbs = path.resolve(root, mapped);
      if (mappedAbs !== root && !mappedAbs.startsWith(root + path.sep)) {
        // A mapping may never point outside the workspace folder.
        continue;
      }
      if (folder === mappedAbs || folder.startsWith(mappedAbs + path.sep)) {
        const depth = mappedAbs.split(path.sep).length;
        if (best === undefined || depth > best.depth) {
          best = { depth, target };
        }
      }
    }
    return best?.target;
  }
}
