import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotebookFidelityError } from '../src/core/errors';
import { NotebookCodec } from '../src/core/notebookCodec';

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
      cell_type: 'code',
      execution_count: null,
      id: 'a1b2c3',
      metadata: { microsoft: { language: 'python' }, collapsed: false },
      outputs: [],
      source: ['df = spark.read.table("sales")\n', 'display(df)'],
    },
    {
      cell_type: 'markdown',
      id: 'd4e5f6',
      metadata: {},
      source: ['# Analysis'],
    },
  ],
  metadata: {
    language_info: { name: 'python' },
    dependencies: {
      lakehouse: {
        default_lakehouse: '11111111-2222-3333-4444-555555555555',
        default_lakehouse_name: 'SalesLakehouse',
        default_lakehouse_workspace_id: '99999999-8888-7777-6666-555555555555',
        known_lakehouses: [{ id: '11111111-2222-3333-4444-555555555555' }],
      },
    },
    a365ComputeOptions: { runtime: '1.2', poolName: 'starter' },
    sessionKeepAliveTimeout: 30,
    future_unknown_field: { nested: [1, 2, 3] },
  },
};
const portalText = JSON.stringify(portalNotebook, undefined, 1) + '\n';

test('round-trip of an unmodified notebook is byte-for-byte identical', () => {
  const codec = new NotebookCodec();
  const model = codec.parse(portalText, 'notebook-content.ipynb');
  assert.equal(codec.serialize(model), portalText);
});

test('parse exposes cells with joined source and languages', () => {
  const codec = new NotebookCodec();
  const model = codec.parse(portalText, 'notebook-content.ipynb');
  assert.equal(model.cells.length, 2);
  assert.equal(model.cells[0].source, 'df = spark.read.table("sales")\ndisplay(df)');
  assert.equal(model.cells[0].language, 'python');
  assert.equal(model.cells[1].language, 'markdown');
});

test('unknown metadata fields survive a modifying round-trip', () => {
  const codec = new NotebookCodec();
  const model = codec.parse(portalText, 'notebook-content.ipynb');
  model.cells[0].source = 'print(1)';
  model.markDirty();
  const written = JSON.parse(codec.serialize(model));
  assert.deepEqual(written.metadata.a365ComputeOptions, {
    runtime: '1.2',
    poolName: 'starter',
  });
  assert.deepEqual(written.metadata.future_unknown_field, { nested: [1, 2, 3] });
  assert.equal(written.metadata.sessionKeepAliveTimeout, 30);
  // Unknown per-cell fields survive too.
  assert.equal(written.cells[0].id, 'a1b2c3');
  assert.deepEqual(written.cells[0].metadata, {
    microsoft: { language: 'python' },
    collapsed: false,
  });
});

test('lakehouse attachments read the same metadata Fabric writes', () => {
  const codec = new NotebookCodec();
  const model = codec.parse(portalText, 'notebook-content.ipynb');
  const attachments = model.getLakehouseAttachments();
  assert.equal(
    attachments.defaultLakehouse?.id,
    '11111111-2222-3333-4444-555555555555',
  );
  assert.equal(attachments.defaultLakehouse?.name, 'SalesLakehouse');
  assert.equal(attachments.known.length, 1);
});

test('attach and detach update metadata and support multiple lakehouses', () => {
  const codec = new NotebookCodec();
  const model = codec.parse(portalText, 'notebook-content.ipynb');
  model.attachLakehouse(
    { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'Second' },
    false,
  );
  let attachments = model.getLakehouseAttachments();
  assert.equal(attachments.known.length, 2);
  // Existing default is kept when attaching non-default.
  assert.equal(
    attachments.defaultLakehouse?.id,
    '11111111-2222-3333-4444-555555555555',
  );

  model.detachLakehouse('11111111-2222-3333-4444-555555555555');
  attachments = model.getLakehouseAttachments();
  assert.equal(attachments.defaultLakehouse, undefined);
  assert.equal(attachments.known.length, 1);
  assert.equal(attachments.known[0].id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
});

test('parse failure names the file and states read-side failure', () => {
  const codec = new NotebookCodec();
  assert.throws(
    () => codec.parse('not json {', 'broken.ipynb'),
    (error: unknown) => {
      assert.ok(error instanceof NotebookFidelityError);
      assert.match(error.message, /broken\.ipynb/);
      assert.match(error.message, /not valid JSON/);
      assert.equal(error.operation, 'parse notebook');
      return true;
    },
  );
});

test('unsupported nbformat is rejected with the version named', () => {
  const codec = new NotebookCodec();
  const text = JSON.stringify({ nbformat: 3, cells: [] });
  assert.throws(
    () => codec.parse(text, 'old.ipynb'),
    /nbformat 3/,
  );
});
