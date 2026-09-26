import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DISPLAY_BOOTSTRAP_CODE,
  extractDisplays,
  livySqlResultToTable,
  renderTableHtml,
  renderTableText,
} from "../src/core/displayProtocol";

const RS = "\u001e";
const payload = (value: unknown) =>
  `${RS}FABRIC_CONNECT_DISPLAY${JSON.stringify(value)}${RS}\n`;

test("display payloads are split out of printed text", () => {
  const text =
    "loading\n" +
    payload({ columns: ["a", "b"], rows: [[1, "x"]], truncated: false }) +
    "done\n" +
    payload({ columns: ["n"], rows: [[1], [2]], truncated: true });
  const { text: rest, tables } = extractDisplays(text);
  assert.equal(rest, "loading\ndone\n");
  assert.deepEqual(tables, [
    { columns: ["a", "b"], rows: [[1, "x"]], truncated: false },
    { columns: ["n"], rows: [[1], [2]], truncated: true },
  ]);
});

test("text without payloads, or with a broken one, is left alone", () => {
  assert.deepEqual(extractDisplays("plain\n"), { text: "plain\n", tables: [] });
  const broken = `${RS}FABRIC_CONNECT_DISPLAY{nope${RS}`;
  assert.deepEqual(extractDisplays(broken), { text: broken, tables: [] });
});

test("HTML tables escape every value", () => {
  const html = renderTableHtml({
    columns: ["<b>col</b>"],
    rows: [["<script>alert(1)</script>"], [null], [{ k: "&" }]],
    truncated: false,
  });
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<b>col/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<td>null<\/td>/);
  assert.match(html, /&quot;k&quot;:&quot;&amp;&quot;/);
  assert.match(html, /3 rows/);
});

test("text tables align columns and note truncation", () => {
  const text = renderTableText({
    columns: ["id", "name"],
    rows: [
      [1, "alpha"],
      [22, null],
    ],
    truncated: true,
  });
  assert.equal(
    text,
    [
      "id | name",
      "---+------",
      "1  | alpha",
      "22 | null",
      "(first 2 rows)",
    ].join("\n"),
  );
});

test("Livy SQL results become tables", () => {
  assert.deepEqual(
    livySqlResultToTable({
      schema: { type: "struct", fields: [{ name: "id" }, { name: "v" }] },
      data: [
        [1, "a"],
        [2, "b"],
      ],
    }),
    {
      columns: ["id", "v"],
      rows: [
        [1, "a"],
        [2, "b"],
      ],
      truncated: false,
    },
  );
  assert.equal(livySqlResultToTable({ some: "json" }), undefined);
  assert.equal(livySqlResultToTable([1, 2]), undefined);
});

test("the bootstrap defines display() and emits the same framing", () => {
  assert.match(DISPLAY_BOOTSTRAP_CODE, /^def display\(obj=None/);
  assert.match(DISPLAY_BOOTSTRAP_CODE, /"\\x1eFABRIC_CONNECT_DISPLAY"/);
  assert.match(DISPLAY_BOOTSTRAP_CODE, /limit\(1000 \+ 1\)/);
});
