/**
 * The only place that mints a `UserConfirmation` (decision D3): a Lakehouse
 * is created only after a modal that names the Lakehouse, the workspace and
 * the capacity it is billed to, and only when the user presses the button.
 */

import * as vscode from "vscode";
import type { CapacityInfo, NamedItem } from "../core/fabricCatalog";
import {
  createLakehouse,
  validateLakehouseName,
} from "../core/lakehouseProvisioning";
import type { IFabricApiClient } from "../core/types";
import { mintUserConfirmation } from "../core/writePolicy";

const CONFIRM = "Create Lakehouse";

export function makeLakehouseCreator(api: IFabricApiClient) {
  return async (
    tenantId: string,
    workspace: { id: string; displayName: string },
    capacity: CapacityInfo,
  ): Promise<NamedItem | undefined> => {
    const name = await vscode.window.showInputBox({
      prompt: `Name for the new Lakehouse in workspace '${workspace.displayName}'`,
      value: "fabric_connect_scratch",
      validateInput: (value) => validateLakehouseName(value),
      ignoreFocusOut: true,
    });
    if (name === undefined) {
      return undefined;
    }
    const answer = await vscode.window.showWarningMessage(
      `Create Lakehouse '${name}'?`,
      {
        modal: true,
        detail:
          `This creates a new Fabric item in workspace '${workspace.displayName}' on capacity '${capacity.displayName}'` +
          (capacity.sku ? ` (${capacity.sku})` : "") +
          ". Fabric Connect treats Lakehouses as infrastructure: it creates one only with your confirmation and never updates or deletes it.",
      },
      CONFIRM,
    );
    if (answer !== CONFIRM) {
      return undefined;
    }
    const confirmation = mintUserConfirmation(
      "create-lakehouse",
      workspace.id,
      name,
    );
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating Lakehouse '${name}'…`,
      },
      () => createLakehouse(api, tenantId, workspace.id, name, confirmation),
    );
  };
}
