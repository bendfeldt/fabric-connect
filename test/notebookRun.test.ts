import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { toStatement } from "../src/core/cellCode";
import { FabricConnectError } from "../src/core/errors";
import { LocalItemIndex, parsePlatform } from "../src/core/localItemIndex";
import {
  RunExpansionError,
  expandRunMagics,
  hasRunMagic,
  toPythonLiteral,
} from "../src/core/runExpansion";

const ROOT = path.resolve("/repo");

function platform(type: string, displayName: string, logicalId?: string) {
  return JSON.stringify({
    $schema: "https://example/platform.json",
    metadata: { type, displayName },
    config: { version: "2.0", ...(logicalId ? { logicalId } : {}) },
  });
}

function ipynb(
  cells: Array<{
    source: string;
    tags?: string[];
    type?: string;
    language?: string;
  }>,
) {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { language_info: { name: "python" } },
    cells: cells.map((c) => ({
      cell_type: c.type ?? "code",
      metadata: {
        ...(c.tags ? { tags: c.tags } : {}),
        ...(c.language ? { language: c.language } : {}),
      },
      source: c.source,
      outputs: [],
      execution_count: null,
    })),
  });
}

async function repo(files: Record<string, string>) {
  const abs: Record<string, string> = {};
  for (const [rel, text] of Object.entries(files)) {
    abs[path.join(ROOT, rel)] = text;
  }
  const fs = { readFile: async (p: string) => abs[p] };
  const index = await LocalItemIndex.build({
    findPlatformFiles: async () =>
      Object.keys(abs).filter((p) => path.basename(p) === ".platform"),
    readFile: fs.readFile,
  });
  return { index, fs };
}

// --- local item index ---------------------------------------------------------

test("the index reads type, name and logicalId from .platform files", async () => {
  const { index } = await repo({
    "nb/Loader.Notebook/.platform": platform("Notebook", "Loader", "abc-123"),
    "lh/Bronze.Lakehouse/.platform": platform("Lakehouse", "Bronze"),
    "bad/X.Notebook/.platform": "{not json",
  });
  assert.equal(index.items.length, 2);
  assert.equal(index.skipped.length, 1);
  assert.equal(
    index.findByName("notebook", "loader")[0]?.folder,
    path.join(ROOT, "nb/Loader.Notebook"),
  );
  assert.equal(index.findByLogicalId("ABC-123")?.displayName, "Loader");
  assert.equal(index.findByLogicalId("nope"), undefined);
});

test("parsePlatform rejects files without type or name", () => {
  assert.equal(
    parsePlatform('{"metadata":{"type":"Notebook"}}', "/x"),
    undefined,
  );
  assert.equal(parsePlatform(undefined, "/x"), undefined);
});

// --- %run ------------------------------------------------------------------------

test("code without %run is returned unchanged", async () => {
  const { index, fs } = await repo({});
  const code =
    "x = 1\n# %run in a comment is not a magic line? it is only at line start";
  assert.equal(hasRunMagic("x = 1"), false);
  assert.equal(await expandRunMagics("x = 1", index, fs), "x = 1");
  assert.equal(hasRunMagic(code), false);
});

test("%run inlines a local .ipynb notebook's Python cells in order", async () => {
  const { index, fs } = await repo({
    "Utils.Notebook/.platform": platform("Notebook", "Utils"),
    "Utils.Notebook/notebook-content.ipynb": ipynb([
      { source: "def add(a, b):\n    return a + b" },
      { type: "markdown", source: "# ignored" },
      { source: "%%pyspark\nZ = 3" },
    ]),
  });
  const out = await expandRunMagics(
    "before = 1\n%run Utils\nprint(add(1, 2))",
    index,
    fs,
  );
  assert.equal(
    out,
    [
      "before = 1",
      "# --- %run Utils (local) ---",
      "def add(a, b):\n    return a + b",
      "Z = 3",
      "# --- end %run Utils ---",
      "print(add(1, 2))",
    ].join("\n"),
  );
});

test("%run parameters are assigned after the parameters cell", async () => {
  const { index, fs } = await repo({
    "Load.Notebook/.platform": platform("Notebook", "Load"),
    "Load.Notebook/notebook-content.ipynb": ipynb([
      { source: 'run_date = "default"\nlimit = 10', tags: ["parameters"] },
      { source: "print(run_date, limit)" },
    ]),
  });
  const out = await expandRunMagics(
    '%run Load {"run_date": "2026-01-01", "limit": null, "flags": [true, false]}',
    index,
    fs,
  );
  const lines = out.split("\n");
  const paramsAt = lines.indexOf('run_date = "2026-01-01"');
  assert.ok(paramsAt > lines.indexOf("limit = 10"));
  assert.ok(paramsAt < lines.indexOf("print(run_date, limit)"));
  assert.ok(lines.includes("limit = None"));
  assert.ok(lines.includes("flags = [True, False]"));
});

test("%run reads the git source format and recurses", async () => {
  const source = `# Fabric notebook source

# PARAMETERS CELL ********************

p = 1

# METADATA ********************

# META {
# META   "language": "python"
# META }

# CELL ********************

%run Inner

# METADATA ********************

# META {
# META   "language": "python"
# META }
`;
  const { index, fs } = await repo({
    "Outer.Notebook/.platform": platform("Notebook", "Outer"),
    "Outer.Notebook/notebook-content.py": source,
    "Inner.Notebook/.platform": platform("Notebook", "Inner"),
    "Inner.Notebook/notebook-content.ipynb": ipynb([
      { source: "inner = True" },
    ]),
  });
  const out = await expandRunMagics('%run Outer {"p": 2}', index, fs);
  assert.match(out, /p = 1\np = 2/);
  assert.match(out, /# --- %run Inner \(local\) ---\ninner = True/);
});

test("%run errors are specific: missing, duplicate, cyclic, non-Python, bad params", async () => {
  const { index, fs } = await repo({
    "A.Notebook/.platform": platform("Notebook", "A"),
    "A.Notebook/notebook-content.ipynb": ipynb([{ source: "%run B" }]),
    "B.Notebook/.platform": platform("Notebook", "B"),
    "B.Notebook/notebook-content.ipynb": ipynb([{ source: "%run A" }]),
    "one/Dup.Notebook/.platform": platform("Notebook", "Dup"),
    "two/Dup.Notebook/.platform": platform("Notebook", "Dup"),
    "Sql.Notebook/.platform": platform("Notebook", "Sql"),
    "Sql.Notebook/notebook-content.ipynb": ipynb([
      { source: "SELECT 1", language: "sparksql" },
    ]),
  });
  const cases: Array<[string, RegExp]> = [
    ["%run Missing", /no notebook with that name exists/],
    ["%run Dup", /2 notebooks in this repo have that name/],
    ["%run A", /runs itself through A → B → A/],
    ["%run Sql", /cell 0 is sparksql, and only Python cells/],
    ["%run A {bad json", /parameters are not valid JSON/],
    ["%run A [1]", /no notebook with that name|must be a JSON object/],
    ['%run A {"not valid": 1}', /not a valid Python name|runs itself/],
  ];
  for (const [code, pattern] of cases) {
    await assert.rejects(
      expandRunMagics(code, index, fs),
      (error: unknown) =>
        error instanceof RunExpansionError &&
        pattern.test(error.message) &&
        /Next step:/.test(error.message),
      code,
    );
  }
});

test("JSON values become Python literals", () => {
  assert.equal(
    toPythonLiteral({ a: [1, "x", null, true], "b c": { d: false } }),
    '{"a": [1, "x", None, True], "b c": {"d": False}}',
  );
  assert.equal(toPythonLiteral('quote " and \\'), '"quote \\" and \\\\"');
});

// --- cell magics -----------------------------------------------------------

test("cell magics pick the Livy kind and are stripped", () => {
  assert.deepEqual(toStatement("%%sql\nSELECT 1", "python", "cell 1"), {
    kind: "sql",
    code: "SELECT 1",
  });
  assert.deepEqual(toStatement("%%spark\nval x = 1", "python", "cell 1"), {
    kind: "spark",
    code: "val x = 1",
  });
  assert.deepEqual(toStatement("print(1)", "python", "cell 1"), {
    kind: "pyspark",
    code: "print(1)",
  });
  assert.deepEqual(toStatement("SELECT 2", "sql", "cell 1"), {
    kind: "sql",
    code: "SELECT 2",
  });
  assert.deepEqual(toStatement("x", "unknown-language", "cell 1"), {
    kind: "pyspark",
    code: "x",
  });
});

test("unsupported cell magics are refused with a next step", () => {
  assert.throws(
    () => toStatement('%%configure\n{"conf": {}}', "python", "cell 3"),
    (error: unknown) =>
      error instanceof FabricConnectError &&
      /cell 3/.test(error.message) &&
      /Environment/.test(error.message),
  );
  assert.throws(
    () => toStatement("%%html\n<b/>", "python", "cell 1"),
    FabricConnectError,
  );
});
