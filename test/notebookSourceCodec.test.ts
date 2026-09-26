import assert from "node:assert/strict";
import { test } from "node:test";
import { NotebookFidelityError } from "../src/core/errors";
import {
  getEnvironmentAttachment,
  getLakehouseAttachments,
  attachLakehouse,
} from "../src/core/notebookCodec";
import {
  isNotebookSource,
  parseNotebookSource,
  serializeNotebookSource,
  type ParsedSourceNotebook,
  type SourceSerializeCell,
} from "../src/core/notebookSourceCodec";

/** Shape of a real Fabric git export (microsoft/fabric-cicd sample). */
const SAMPLE = `# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {
# META     "environment": {
# META       "environmentId": "a277ea4a-e87f-8537-4ce0-39db11d4aade",
# META       "workspaceId": "00000000-0000-0000-0000-000000000000"
# META     }
# META   }
# META }

# CELL ********************

print("Hello World")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
`;

const RICH = `# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {
# META     "lakehouse": {
# META       "default_lakehouse": "11111111-1111-1111-1111-111111111111",
# META       "default_lakehouse_name": "Bronze",
# META       "default_lakehouse_workspace_id": "22222222-2222-2222-2222-222222222222"
# META     }
# META   },
# META   "future_field": {"kept": true}
# META }

# MARKDOWN ********************

# # Load
#
# Loads **raw** data.
#

# PARAMETERS CELL ********************

run_date = "2026-01-01"

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

df = spark.read.table("raw")


display(df)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark",
# META   "cell_future": 7
# META }

# CELL ********************

# MAGIC %%sql
# MAGIC SELECT *
# MAGIC
# MAGIC FROM raw

# METADATA ********************

# META {
# META   "language": "sparksql",
# META   "language_group": "synapse_pyspark"
# META }
`;

function unchangedCells(parsed: ParsedSourceNotebook): SourceSerializeCell[] {
  return parsed.cells.map((c) => ({
    kind: c.kind,
    language: c.language,
    source: c.source,
    raw: c.raw,
  }));
}

function roundTrip(
  parsed: ParsedSourceNotebook,
  cells: SourceSerializeCell[],
  root = parsed.root,
): string {
  return serializeNotebookSource({
    fileName: parsed.fileName,
    prefix: parsed.prefix,
    root,
    originalText: parsed.originalText,
    cells,
  });
}

test("recognizes source notebooks by their header line", () => {
  assert.equal(isNotebookSource(SAMPLE), true);
  assert.equal(isNotebookSource("-- Fabric notebook source\n"), true);
  assert.equal(isNotebookSource("// Fabric notebook source\r\n"), true);
  assert.equal(isNotebookSource("print('hi')\n"), false);
});

test("parses a real Fabric git export", () => {
  const parsed = parseNotebookSource(SAMPLE, "notebook-content.py");
  assert.equal(parsed.prefix, "#");
  assert.equal(parsed.cells.length, 1);
  assert.equal(parsed.cells[0].kind, "code");
  assert.equal(parsed.cells[0].language, "python");
  assert.equal(parsed.cells[0].source, 'print("Hello World")');
  assert.deepEqual(getEnvironmentAttachment(parsed.root), {
    id: "a277ea4a-e87f-8537-4ce0-39db11d4aade",
    workspaceId: "00000000-0000-0000-0000-000000000000",
  });
});

test("parses markdown, parameters, multi-line code and magic cells", () => {
  const parsed = parseNotebookSource(RICH, "notebook-content.py");
  assert.deepEqual(
    parsed.cells.map((c) => [c.kind, c.language]),
    [
      ["markdown", "markdown"],
      ["parameters", "python"],
      ["code", "python"],
      ["code", "sql"],
    ],
  );
  assert.equal(parsed.cells[0].source, "# Load\n\nLoads **raw** data.\n");
  assert.equal(parsed.cells[1].source, 'run_date = "2026-01-01"');
  assert.equal(
    parsed.cells[2].source,
    'df = spark.read.table("raw")\n\n\ndisplay(df)',
  );
  assert.equal(parsed.cells[3].source, "%%sql\nSELECT *\n\nFROM raw");
  assert.equal(
    getLakehouseAttachments(parsed.root).defaultLakehouse?.name,
    "Bronze",
  );
});

test("unmodified notebooks serialize byte-for-byte", () => {
  for (const text of [SAMPLE, RICH, RICH.replace(/\n/g, "\r\n")]) {
    const parsed = parseNotebookSource(text, "notebook-content.py");
    assert.equal(roundTrip(parsed, unchangedCells(parsed)), text);
  }
});

test("editing one cell rewrites only that cell's block", () => {
  const parsed = parseNotebookSource(RICH, "notebook-content.py");
  const cells = unchangedCells(parsed);
  cells[1] = { ...cells[1], source: 'run_date = "2026-02-02"' };
  const out = roundTrip(parsed, cells);
  assert.equal(out, RICH.replace('"2026-01-01"', '"2026-02-02"'));
});

test("an edited cell keeps its unknown cell metadata", () => {
  const parsed = parseNotebookSource(RICH, "notebook-content.py");
  const cells = unchangedCells(parsed);
  cells[2] = { ...cells[2], source: "df = 1" };
  const reparsed = parseNotebookSource(
    roundTrip(parsed, cells),
    "notebook-content.py",
  );
  assert.equal(reparsed.cells[2].source, "df = 1");
  assert.equal(reparsed.cells[2].raw.meta?.["cell_future"], 7);
});

test("unknown notebook metadata survives a metadata edit", () => {
  const parsed = parseNotebookSource(RICH, "notebook-content.py");
  const root = attachLakehouse(
    parsed.root,
    { id: "33333333-3333-3333-3333-333333333333", name: "Silver" },
    true,
  );
  const out = roundTrip(parsed, unchangedCells(parsed), root);
  const reparsed = parseNotebookSource(out, "notebook-content.py");
  assert.deepEqual(
    (reparsed.root["metadata"] as Record<string, unknown>)["future_field"],
    { kept: true },
  );
  assert.equal(
    getLakehouseAttachments(reparsed.root).defaultLakehouse?.name,
    "Silver",
  );
  // Cells were untouched, so their text is unchanged too.
  assert.ok(out.endsWith(RICH.slice(RICH.indexOf("# MARKDOWN"))));
});

test("new, deleted and re-languaged cells round-trip through parse", () => {
  const parsed = parseNotebookSource(RICH, "notebook-content.py");
  const cells = unchangedCells(parsed);
  cells.splice(0, 1); // delete markdown
  cells.push({
    kind: "markdown",
    language: "markdown",
    source: "Done.\n\nBye",
  });
  cells.push({ kind: "code", language: "sql", source: "SELECT 1" });
  cells.push({ kind: "code", language: "python", source: "x = 2" });
  const out = roundTrip(parsed, cells);
  const reparsed = parseNotebookSource(out, "notebook-content.py");
  assert.deepEqual(
    reparsed.cells.map((c) => [c.kind, c.language, c.source]),
    [
      ["parameters", "python", 'run_date = "2026-01-01"'],
      ["code", "python", 'df = spark.read.table("raw")\n\n\ndisplay(df)'],
      ["code", "sql", "%%sql\nSELECT *\n\nFROM raw"],
      ["markdown", "markdown", "Done.\n\nBye"],
      ["code", "sql", "%%sql\nSELECT 1"],
      ["code", "python", "x = 2"],
    ],
  );
  assert.ok(out.endsWith("# META }\n"), "file ends with a single newline");
  assert.doesNotMatch(out, /\n\n\n# (CELL|MARKDOWN)/);
});

test("changing a cell's language rewrites it with magic and metadata", () => {
  const parsed = parseNotebookSource(SAMPLE, "notebook-content.py");
  const out = roundTrip(parsed, [
    { ...unchangedCells(parsed)[0], language: "sql", source: "SELECT 2" },
  ]);
  const cell = parseNotebookSource(out, "notebook-content.py").cells[0];
  assert.equal(cell.language, "sql");
  assert.equal(cell.raw.meta?.["language"], "sparksql");
  assert.match(out, /# MAGIC %%sql\n# MAGIC SELECT 2\n/);
});

test("SQL-file notebooks use the -- prefix", () => {
  const text = `-- Fabric notebook source

-- CELL ********************

SELECT 1

-- METADATA ********************

-- META {
-- META   "language": "sparksql"
-- META }
`;
  const parsed = parseNotebookSource(text, "notebook-content.sql");
  assert.equal(parsed.prefix, "--");
  assert.equal(parsed.cells[0].language, "sql");
  assert.equal(parsed.cells[0].source, "SELECT 1");
  assert.equal(roundTrip(parsed, unchangedCells(parsed)), text);
});

test("malformed files are specific read errors", () => {
  assert.throws(
    () => parseNotebookSource("print(1)\n", "notebook-content.py"),
    (error: unknown) =>
      error instanceof NotebookFidelityError &&
      /notebook-content\.py/.test(error.message) &&
      /Next step:/.test(error.message),
  );
  const badMeta = SAMPLE.replace('"language": "python",', '"language": ,');
  assert.throws(
    () => parseNotebookSource(badMeta, "notebook-content.py"),
    (error: unknown) =>
      error instanceof NotebookFidelityError &&
      /cell 0 metadata is not valid JSON/.test(error.message),
  );
});

test("a notebook with no cells and no metadata round-trips", () => {
  const text = "# Fabric notebook source\n";
  const parsed = parseNotebookSource(text, "notebook-content.py");
  assert.equal(parsed.cells.length, 0);
  assert.equal(roundTrip(parsed, []), text);
  const withCell = roundTrip(parsed, [
    { kind: "code", language: "python", source: "print(1)" },
  ]);
  assert.equal(
    parseNotebookSource(withCell, "notebook-content.py").cells[0].source,
    "print(1)",
  );
});

test("without a file extension the main language is inferred from the cells", () => {
  const r = `# Fabric notebook source

# CELL ********************

# MAGIC %%pyspark
# MAGIC print(1)

# METADATA ********************

# META {
# META   "language": "python"
# META }

# CELL ********************

summary(df)

# METADATA ********************

# META {
# META   "language": "r"
# META }
`;
  const parsed = parseNotebookSource(r, "notebook-content");
  assert.equal(parsed.fileLanguage, "r");
  assert.deepEqual(
    parsed.cells.map((c) => [c.language, c.source]),
    [
      ["python", "%%pyspark\nprint(1)"],
      ["r", "summary(df)"],
    ],
  );
  assert.equal(roundTrip(parsed, unchangedCells(parsed)), r);
});
