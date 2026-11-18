import {
  listVariableLibraries,
  variableLibraryVariableNames,
  type VariableLibrary,
  type VariableLibraryTarget,
} from "../core/variableLibraries";
import type { IFabricApiClient } from "../core/types";

export type VariableLibraryChoice =
  | { readonly kind: "library"; readonly library: VariableLibrary }
  | { readonly kind: "clear" };

export interface VariableLibraryPickerUi {
  chooseLibrary(
    libraries: readonly VariableLibrary[],
  ): Promise<VariableLibraryChoice | undefined>;
  chooseVariables(
    names: readonly string[],
    preselected: readonly string[],
  ): Promise<readonly string[] | undefined>;
  warn(message: string): void;
}

export interface VariableLibrarySettings {
  read(): unknown;
  write(value: Record<string, string[]>): Promise<void>;
}

export async function resolveVariableLibraryTarget(
  hasActiveNotebook: boolean,
  notebookTarget: () => Promise<VariableLibraryTarget>,
  computeHostTarget: () => Promise<VariableLibraryTarget>,
): Promise<VariableLibraryTarget> {
  return hasActiveNotebook ? notebookTarget() : computeHostTarget();
}

export class VariableLibraryPicker {
  constructor(
    private readonly api: IFabricApiClient,
    private readonly target: () => Promise<VariableLibraryTarget>,
    private readonly settings: VariableLibrarySettings,
    private readonly ui: VariableLibraryPickerUi,
  ) {}

  async pick(): Promise<void> {
    const target = await this.target();
    const libraries = await listVariableLibraries(this.api, target);
    const choice = await this.ui.chooseLibrary(libraries);
    if (choice === undefined) return;
    if (choice.kind === "clear") {
      await this.settings.write({});
      return;
    }

    const names = await variableLibraryVariableNames(
      this.api,
      target,
      choice.library.id,
    );
    if (names.length === 0) {
      this.ui.warn("This Variable Library has no variables to select.");
      return;
    }
    const configured = this.settings.read();
    const previous =
      configured !== null &&
      typeof configured === "object" &&
      !Array.isArray(configured)
        ? (configured as Record<string, unknown>)[choice.library.name]
        : undefined;
    const preselected = Array.isArray(previous)
      ? previous.filter(
          (name): name is string =>
            typeof name === "string" && names.includes(name),
        )
      : [];
    const selected = await this.ui.chooseVariables(names, preselected);
    if (selected === undefined) return;
    if (selected.length === 0) {
      this.ui.warn(
        "Select at least one variable, or choose None / Clear selection.",
      );
      return;
    }
    await this.settings.write({ [choice.library.name]: [...selected] });
  }
}
