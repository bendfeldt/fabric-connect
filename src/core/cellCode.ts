/**
 * Turns a cell (or a file/selection) into the code and Livy statement kind
 * to submit. Fabric cells may start with a cell magic (`%%sql`,
 * `%%pyspark`, `%%spark`, `%%sparkr`) that overrides the cell language;
 * Livy does not understand magics, so the magic line is stripped and mapped
 * to the statement kind instead.
 */

import { FabricConnectError } from "./errors";

const LANGUAGE_TO_KIND: Record<string, string> = {
  python: "pyspark",
  scala: "spark",
  sql: "sql",
  r: "sparkr",
};

const MAGIC_TO_KIND: Record<string, string> = {
  "%%pyspark": "pyspark",
  "%%python": "pyspark",
  "%%sql": "sql",
  "%%spark": "spark",
  "%%sparkr": "sparkr",
};

export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGE_TO_KIND);

export interface CellStatement {
  readonly kind: string;
  readonly code: string;
}

/**
 * The statement for a cell: `languageId` is the editor language, `entity`
 * names the cell for errors.
 */
export function toStatement(
  source: string,
  languageId: string,
  entity: string,
): CellStatement {
  const newline = source.indexOf("\n");
  const firstLine = (newline === -1 ? source : source.slice(0, newline)).trim();
  if (firstLine.startsWith("%%")) {
    const magic = firstLine.split(/\s+/, 1)[0];
    const kind = MAGIC_TO_KIND[magic];
    if (kind === undefined) {
      throw new FabricConnectError(
        `Cannot run ${entity}: the cell magic '${magic}' is not supported over Livy.`,
        {
          operation: "execute cell",
          entity,
          remediation:
            magic === "%%configure"
              ? "Session settings come from the connected Environment ('Fabric: Connect to Compute'); remove the %%configure cell."
              : "Remove the magic line, or use one of %%pyspark, %%sql, %%spark, %%sparkr.",
        },
      );
    }
    return { kind, code: newline === -1 ? "" : source.slice(newline + 1) };
  }
  return { kind: LANGUAGE_TO_KIND[languageId] ?? "pyspark", code: source };
}
