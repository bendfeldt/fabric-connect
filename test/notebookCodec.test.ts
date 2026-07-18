import assert from "node:assert/strict";
import { test } from "node:test";
import { NotebookFidelityError } from "../src/core/errors";
import {
  attachLakehouse,
  defaultRawCell,
  detachLakehouse,
  getLakehouseAttachments,
  parseNotebook,
  serializeNotebook,
  type ParsedNotebook,
} from "../src/core/notebookCodec";

/**
 * A portal-style Fabric notebook, including metadata fields this extension
 * does not understand ("a365ComputeOptions", "sessionKeepAliveTimeout",
 * "future_unknown_field") that must survive round-trips untouched.
 */
const portalNotebook = {
  nbformat: 4,
  nbformat_minor: 5,
  cells: [
    {
      cell_type: "code",
      execution_count: null,
      id: "a1b2c3",
      metadata: { microsoft: { language: "python" }, collapsed: false },
      outputs: [],
      source: ['df = spark.read.table("sales")\n', "display(df)"],
    },
    {
      cell_type: "markdown",
      id: "d4e5f6",
      metadata: {},
      source: ["# Analysis"],
    },
  ],
  metadata: {
    language_info: { name: "python" },
    dependencies: {
      lakehouse: {
        default_lakehouse: "11111111-2222-3333-4444-555555555555",
        default_lakehouse_name: "SalesLakehouse",
        default_lakehouse_workspace_id: "99999999-8888-7777-6666-555555555555",
        known_lakehouses: [{ id: "11111111-2222-3333-4444-555555555555" }],
      },
    },
    a365ComputeOptions: { runtime: "1.2", poolName: "starter" },
    sessionKeepAliveTimeout: 30,
    future_unknown_field: { nested: [1, 2, 3] },
  },
};
const portalText = JSON.stringify(portalNotebook, undefined, 1) + "\n";

/** Serializes a parsed notebook back with no content changes. */
function roundTrip(parsed: ParsedNotebook, root = parsed.root): string {
  return serializeNotebook({
    fileName: parsed.fileName,
    root,
    originalText: parsed.originalText,
    cells: parsed.cells.map((cell) => ({ source: cell.source, raw: cell.raw })),
  });
}

test("round-trip of an unmodified notebook is byte-for-byte identical", () => {
  const parsed = parseNotebook(portalText, "notebook-content.ipynb");
  assert.equal(roundTrip(parsed), portalText);
});

test("string-form sources stay byte-for-byte when the notebook is unmodified", () => {
  // Same content, but sources in the non-canonical plain-string form.
  const text =
    JSON.stringify(
      {
        nbformat: 4,
        cells: [
          { cell_type: "code", metadata: {}, source: "print(1)\nprint(2)" },
        ],
        metadata: {},
      },
      undefined,
      1,
    ) + "\n";
  const parsed = parseNotebook(text, "string-source.ipynb");
  assert.equal(parsed.cells[0].source, "print(1)\nprint(2)");
  assert.equal(roundTrip(parsed), text);
});

test("parse exposes cells with joined source and languages", () => {
  const parsed = parseNotebook(portalText, "notebook-content.ipynb");
  assert.equal(parsed.cells.length, 2);
  assert.equal(
    parsed.cells[0].source,
    'df = spark.read.table("sales")\ndisplay(df)',
  );
  assert.equal(parsed.cells[0].language, "python");
  assert.equal(parsed.cells[1].language, "markdown");
});

test("unknown metadata fields survive a modifying round-trip", () => {
  const parsed = parseNotebook(portalText, "notebook-content.ipynb");
  const written = JSON.parse(
    serializeNotebook({
      fileName: parsed.fileName,
      root: parsed.root,
      originalText: parsed.originalText,
      cells: parsed.cells.map((cell, i) => ({
        source: i === 0 ? "print(1)" : cell.source,
        raw: cell.raw,
      })),
    }),
  );
  assert.deepEqual(written.metadata.a365ComputeOptions, {
    runtime: "1.2",
    poolName: "starter",
  });
  assert.deepEqual(written.metadata.future_unknown_field, {
    nested: [1, 2, 3],
  });
  assert.equal(written.metadata.sessionKeepAliveTimeout, 30);
  assert.deepEqual(written.cells[0].source, ["print(1)"]);
  // Unknown per-cell fields survive too.
  assert.equal(written.cells[0].id, "a1b2c3");
  assert.deepEqual(written.cells[0].metadata, {
    microsoft: { language: "python" },
    collapsed: false,
  });
});

test("editing a cell and restoring its source returns the original bytes", () => {
  const parsed = parseNotebook(portalText, "notebook-content.ipynb");
  // The editor changed a cell and the user typed the original text back:
  // content equality — not an edit-history flag — decides fidelity.
  const restored = parsed.cells.map((cell) => ({
    source: cell.source,
    raw: cell.raw,
  }));
  assert.equal(
    serializeNotebook({
      fileName: parsed.fileName,
      root: parsed.root,
      originalText: parsed.originalText,
      cells: restored,
    }),
    portalText,
  );
});

test("cells added in the editor get default raws; kept cells keep unknown fields", () => {
  const parsed = parseNotebook(portalText, "notebook-content.ipynb");
  const written = JSON.parse(
    serializeNotebook({
      fileName: parsed.fileName,
      root: parsed.root,
      originalText: parsed.originalText,
      cells: [
        ...parsed.cells.map((cell) => ({ source: cell.source, raw: cell.raw })),
        { source: "df.count()", raw: defaultRawCell(false) },
      ],
    }),
  );
  assert.equal(written.cells.length, 3);
  assert.equal(written.cells[0].id, "a1b2c3");
  assert.equal(written.cells[2].cell_type, "code");
  assert.deepEqual(written.cells[2].source, ["df.count()"]);
  assert.deepEqual(written.cells[2].outputs, []);
});

test("two documents with identical cells serialize with their own metadata", () => {
  // Regression: the old serializer matched saved content to a stored model
  // by cell equality, so identical notebooks could swap metadata.
  const other = {
    ...portalNotebook,
    metadata: { ...portalNotebook.metadata, sessionKeepAliveTimeout: 99 },
  };
  const otherText = JSON.stringify(other, undefined, 1) + "\n";
  const parsedA = parseNotebook(portalText, "a.ipynb");
  const parsedB = parseNotebook(otherText, "b.ipynb");
  assert.deepEqual(parsedA.cells[0].source, parsedB.cells[0].source);
  assert.equal(roundTrip(parsedA), portalText);
  assert.equal(roundTrip(parsedB), otherText);
});

test("payloads from separate parses are independent", () => {
  // Regression: a revert re-parses the same text; mutating one payload's
  // root must never leak into the other or break its fidelity.
  const first = parseNotebook(portalText, "notebook-content.ipynb");
  const second = parseNotebook(portalText, "notebook-content.ipynb");
  const attached = attachLakehouse(
    first.root,
    { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    false,
  );
  assert.equal(getLakehouseAttachments(attached).known.length, 2);
  assert.equal(roundTrip(second), portalText);
});

test("lakehouse attachments read the same metadata Fabric writes", () => {
  const parsed = parseNotebook(portalText, "notebook-content.ipynb");
  const attachments = getLakehouseAttachments(parsed.root);
  assert.equal(
    attachments.defaultLakehouse?.id,
    "11111111-2222-3333-4444-555555555555",
  );
  assert.equal(attachments.defaultLakehouse?.name, "SalesLakehouse");
  assert.equal(attachments.known.length, 1);
});

test("attach and detach update metadata and support multiple lakehouses", () => {
  const parsed = parseNotebook(portalText, "notebook-content.ipynb");
  const withSecond = attachLakehouse(
    parsed.root,
    { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "Second" },
    false,
  );
  let attachments = getLakehouseAttachments(withSecond);
  assert.equal(attachments.known.length, 2);
  // Existing default is kept when attaching non-default.
  assert.equal(
    attachments.defaultLakehouse?.id,
    "11111111-2222-3333-4444-555555555555",
  );

  const detached = detachLakehouse(
    withSecond,
    "11111111-2222-3333-4444-555555555555",
  );
  attachments = getLakehouseAttachments(detached);
  assert.equal(attachments.defaultLakehouse, undefined);
  assert.equal(attachments.known.length, 1);
  assert.equal(attachments.known[0].id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

test("attach and detach never mutate the input root", () => {
  // The panel passes the document's (frozen) metadata straight in; the
  // update must come back as a new object with the input left untouched.
  const parsed = parseNotebook(portalText, "notebook-content.ipynb");
  const before = JSON.stringify(parsed.root);
  const attached = attachLakehouse(
    parsed.root,
    { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    true,
  );
  detachLakehouse(parsed.root, "11111111-2222-3333-4444-555555555555");
  assert.equal(JSON.stringify(parsed.root), before);
  assert.notEqual(attached, parsed.root);
});

test("a metadata-only change serializes dirty with cells intact", () => {
  const parsed = parseNotebook(portalText, "notebook-content.ipynb");
  const attached = attachLakehouse(
    parsed.root,
    { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "Second" },
    false,
  );
  const written = JSON.parse(roundTrip(parsed, attached));
  assert.equal(
    written.metadata.dependencies.lakehouse.known_lakehouses.length,
    2,
  );
  assert.equal(written.cells[0].id, "a1b2c3");
  assert.deepEqual(written.cells[1].source, ["# Analysis"]);
});

test("parse failure names the file and states read-side failure", () => {
  assert.throws(
    () => parseNotebook("not json {", "broken.ipynb"),
    (error: unknown) => {
      assert.ok(error instanceof NotebookFidelityError);
      assert.match(error.message, /broken\.ipynb/);
      assert.match(error.message, /not valid JSON/);
      assert.equal(error.operation, "parse notebook");
      return true;
    },
  );
});

test("unsupported nbformat is rejected with the version named", () => {
  const text = JSON.stringify({ nbformat: 3, cells: [] });
  assert.throws(() => parseNotebook(text, "old.ipynb"), /nbformat 3/);
});
