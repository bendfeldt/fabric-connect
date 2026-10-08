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

test("payloads whose record separators were stripped still become tables", () => {
  // As returned by Fabric's Livy endpoint (see Feedback, 2026-10-08).
  const text =
    "before\n" +
    'FABRIC_CONNECT_DISPLAY{"columns": ["A"], "rows": [[1]], "truncated": false}\n' +
    "after\n";
  const { text: rest, tables } = extractDisplays(text);
  assert.equal(rest, "before\nafter\n");
  assert.deepEqual(tables, [{ columns: ["A"], rows: [[1]], truncated: false }]);
});

test("a payload that lost only its trailing separator becomes a table", () => {
  // Exact bytes from Fabric's Livy endpoint (see Feedback, 2026-10-08).
  const json = '{"columns": ["A"], "rows": [[1]], "truncated": false}';
  for (const text of [
    `${RS}FABRIC_CONNECT_DISPLAY${json}`,
    `${RS}FABRIC_CONNECT_DISPLAY${json}\nafter\n`,
  ]) {
    const { text: rest, tables } = extractDisplays(text);
    assert.equal(rest, text.endsWith("after\n") ? "after\n" : "");
    assert.deepEqual(tables, [
      { columns: ["A"], rows: [[1]], truncated: false },
    ]);
  }
});

test("a payload that lost only its leading separator becomes a table", () => {
  const { text, tables } = extractDisplays(
    `FABRIC_CONNECT_DISPLAY{"columns": ["A"], "rows": [], "truncated": false}${RS}\n`,
  );
  assert.equal(text, "");
  assert.equal(tables.length, 1);
});

test("a payload on the last line, without a newline, is still taken", () => {
  const { text, tables } = extractDisplays(
    'FABRIC_CONNECT_DISPLAY{"columns": ["A"], "rows": [], "truncated": false}',
  );
  assert.equal(text, "");
  assert.equal(tables.length, 1);
});

test("framed payloads printed on one line are each taken", () => {
  const one = payload({ columns: ["a"], rows: [], truncated: false });
  const { text, tables } = extractDisplays(
    one.trimEnd() + payload({ columns: ["b"], rows: [], truncated: false }),
  );
  assert.equal(text, "");
  assert.deepEqual(
    tables.map((t) => t.columns),
    [["a"], ["b"]],
  );
});

test("mixed record separators preserve display order and ordinary output", () => {
  const table = (value: number) => ({
    columns: ["n"],
    rows: [[value]],
    truncated: false,
  });
  const variants = (value: number) => {
    const tagged = `FABRIC_CONNECT_DISPLAY${JSON.stringify(table(value))}`;
    return [
      `${RS}${tagged}${RS}\n`,
      `${tagged}\n`,
      `${RS}${tagged}\n`,
      `${tagged}${RS}\n`,
    ];
  };
  for (const first of variants(1)) {
    for (const second of variants(2)) {
      assert.deepEqual(
        extractDisplays(`before\n${first}between\n${second}after\n`),
        {
          text: "before\nbetween\nafter\n",
          tables: [table(1), table(2)],
        },
      );
    }
  }
});

test("an incomplete inline frame cannot consume the next frame's opening", () => {
  const first = JSON.stringify({
    columns: ["n"],
    rows: [[1]],
    truncated: false,
  });
  const second = { columns: ["n"], rows: [[2]], truncated: false };
  const ordinary = `prefix ${RS}FABRIC_CONNECT_DISPLAY${first}\n`;
  for (const next of [payload(second), payload(second).slice(1)]) {
    assert.deepEqual(extractDisplays(ordinary + next), {
      text: ordinary,
      tables: [second],
    });
  }
});

test("removing a framed payload does not turn inline text into a payload", () => {
  const first = { columns: ["n"], rows: [[1]], truncated: false };
  const ordinary =
    'FABRIC_CONNECT_DISPLAY{"columns":["n"],"rows":[[2]],"truncated":false}\n';
  assert.deepEqual(extractDisplays(payload(first).trimEnd() + ordinary), {
    text: ordinary,
    tables: [first],
  });
});

test("fully framed multiline JSON remains supported", () => {
  const table = { columns: ["n"], rows: [[1]], truncated: false };
  assert.deepEqual(
    extractDisplays(
      `${RS}FABRIC_CONNECT_DISPLAY${JSON.stringify(table, null, 2)}${RS}\n`,
    ),
    { text: "", tables: [table] },
  );
});

test("framed JSON whitespace does not leak separators into ordinary output", () => {
  const table = { columns: ["n"], rows: [[1]], truncated: false };
  for (const json of [JSON.stringify(table), JSON.stringify(table, null, 2)]) {
    for (const leading of ["", " ", "\n", "\r\n\t"]) {
      for (const trailing of ["", " ", "\n", "\r\n\t"]) {
        const text =
          `before\n${RS}FABRIC_CONNECT_DISPLAY${leading}${json}${trailing}${RS}\n` +
          "after\n";
        assert.deepEqual(extractDisplays(text), {
          text: "before\nafter\n",
          tables: [table],
        });
      }
    }
  }
});

test("a whitespace-terminated frame preserves a following ordinary tag", () => {
  const table = { columns: ["n"], rows: [[1]], truncated: false };
  const ordinary = "FABRIC_CONNECT_DISPLAYordinary\n";
  for (const whitespace of ["\n", "\r\n\t"]) {
    assert.deepEqual(
      extractDisplays(
        `${RS}FABRIC_CONNECT_DISPLAY ${JSON.stringify(table)}${whitespace}${RS}${ordinary}`,
      ),
      { text: ordinary, tables: [table] },
    );
  }
});

test("escaped braces and nested JSON do not alter payload boundaries", () => {
  const table = {
    columns: ["text", "nested"],
    rows: [['}\\\"{FABRIC_CONNECT_DISPLAY', { values: [{ brace: "}" }] }]],
    truncated: false,
  };
  assert.deepEqual(extractDisplays(`before\n${payload(table)}after\n`), {
    text: "before\nafter\n",
    tables: [table],
  });
});

test("schema-invalid frames preserve text without hiding a later table", () => {
  const invalid = `${RS}FABRIC_CONNECT_DISPLAY{"columns":[],"rows":"invalid"}${RS}\n`;
  const table = { columns: ["n"], rows: [[1]], truncated: false };
  assert.deepEqual(extractDisplays(invalid + payload(table)), {
    text: invalid,
    tables: [table],
  });
});

test("repeated invalid markers have a linear character-work budget", () => {
  const original = String.prototype.charAt;
  for (const text of [
    `${RS}FABRIC_CONNECT_DISPLAY{`.repeat(10_000),
    "FABRIC_CONNECT_DISPLAY{\n".repeat(10_000),
  ]) {
    let visits = 0;
    const limit = text.length * 8;
    try {
      String.prototype.charAt = function (this: string, index: number): string {
        if (this === text) {
          assert.ok(++visits <= limit, "invalid output exceeded linear work");
        }
        return original.call(this, index);
      };
      assert.deepEqual(extractDisplays(text), { text, tables: [] });
    } finally {
      String.prototype.charAt = original;
    }
  }
});

test("the tag in the middle of a line is ordinary output", () => {
  const line =
    'x FABRIC_CONNECT_DISPLAY{"columns": ["A"], "rows": [[1]], "truncated": false}\n';
  assert.deepEqual(extractDisplays(line), { text: line, tables: [] });
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
