import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApiNotebookState,
  parseApiCell,
  resolveApiPath,
  responseTable,
  selectPath,
  substitute,
} from "../src/core/apiNotebook";
import { ApiNotebookError, LocalFirstViolationError } from "../src/core/errors";
import { FabricApiClient } from "../src/core/fabricApiClient";

const WS = "11111111-1111-1111-1111-111111111111";

test("request cells parse with or without %api, with an optional JSON body", () => {
  assert.deepEqual(parseApiCell("%api\nGET /workspaces"), {
    type: "api",
    method: "GET",
    path: "/workspaces",
  });
  assert.deepEqual(parseApiCell("\n# list items\nget ./items"), {
    type: "api",
    method: "GET",
    path: "./items",
  });
  assert.deepEqual(
    parseApiCell('POST /workspaces\n{\n  "displayName": "x"\n}'),
    {
      type: "api",
      method: "POST",
      path: "/workspaces",
      body: { displayName: "x" },
    },
  );
});

test("malformed request cells are specific errors", () => {
  for (const [text, pattern] of [
    ["", /no request line/],
    ["FETCH /x", /not a request line/],
    ["GET", /not a request line/],
    ["POST /x\n{bad", /not valid JSON/],
  ] as const) {
    assert.throws(
      () => parseApiCell(text),
      (error: unknown) =>
        error instanceof ApiNotebookError &&
        pattern.test(error.message) &&
        /Next step:/.test(error.message),
      text,
    );
  }
});

test("%cmd sets and shows variables, case-insensitively", () => {
  assert.deepEqual(
    parseApiCell(
      "%cmd\nSET API_PATH = /workspaces/abc\nlimit = 10\n# note\nSET api_path",
    ),
    {
      type: "cmd",
      sets: [
        { name: "API_PATH", value: "/workspaces/abc" },
        { name: "LIMIT", value: "10" },
      ],
      gets: ["API_PATH"],
    },
  );
  assert.throws(() => parseApiCell("%cmd\nwhat is this"), ApiNotebookError);
});

test("variables and previous cell outputs substitute into cells", () => {
  const state = new ApiNotebookState();
  state.set("ws", WS);
  state.recordOutput(0, { value: [{ id: "a" }, { id: "b", name: "Bee" }] });
  state.recordOutput(1, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(
    substitute("GET /workspaces/$(WS)/items", state, 2),
    `GET /workspaces/${WS}/items`,
  );
  assert.equal(substitute("$(_cells[-2].value[1].name)", state, 2), "Bee");
  assert.equal(substitute("$(_cells[1][-1].id)", state, 2), "3");
  assert.equal(substitute("$(_cells[0].value[0])", state, 2), '{"id":"a"}');
  assert.throws(() => substitute("$(missing)", state, 2), ApiNotebookError);
  assert.throws(
    () => substitute("$(_cells[-1].nope)", state, 2),
    ApiNotebookError,
  );
  assert.throws(
    () => substitute("$(_cells[-1]+x)", state, 2),
    ApiNotebookError,
  );
});

test("selectPath handles quoted keys and negative indexes", () => {
  assert.equal(selectPath({ "a b": [1, 2, 3] }, '["a b"][-1]', "x"), 3);
});

test("paths resolve against the API root, API_PATH, or a Fabric API URL only", () => {
  const state = new ApiNotebookState();
  assert.equal(resolveApiPath("/workspaces", state), "/workspaces");
  assert.equal(resolveApiPath("capacities", state), "/capacities");
  assert.equal(
    resolveApiPath("https://api.fabric.microsoft.com/v1/workspaces", state),
    "/workspaces",
  );
  assert.throws(() => resolveApiPath("./items", state), ApiNotebookError);
  state.set("root_path", `/workspaces/${WS}/`);
  assert.equal(resolveApiPath("./items", state), `/workspaces/${WS}/items`);
  for (const url of [
    "https://evil.example.com/v1/x",
    "https://api.fabric.microsoft.com.evil.com/v1/x",
    "http://api.fabric.microsoft.com/v1/x",
  ]) {
    assert.throws(() => resolveApiPath(url, state), ApiNotebookError, url);
  }
});

test("list responses become tables", () => {
  assert.deepEqual(responseTable({ value: [{ id: 1, n: "a" }, { id: 2 }] }), {
    columns: ["id", "n"],
    rows: [
      [1, "a"],
      [2, null],
    ],
    truncated: false,
  });
  assert.equal(responseTable({ id: 1 }), undefined);
  assert.equal(responseTable([1, 2]), undefined);
  assert.equal(responseTable({ value: [] }), undefined);
});

test("API cells cannot deploy: writes go through the local-first policy", async () => {
  let sent = false;
  const client = new FabricApiClient(
    { getToken: async () => "t" },
    {
      fetchFn: (async () => {
        sent = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      sleep: async () => undefined,
    },
  );
  for (const text of [
    `POST /workspaces/${WS}/items\n{"displayName":"x","type":"Notebook"}`,
    `PUT /workspaces/${WS}/items/x`,
    `DELETE /workspaces/${WS}`,
  ]) {
    const cell = parseApiCell(text);
    assert.equal(cell.type, "api");
    if (cell.type !== "api") {
      continue;
    }
    await assert.rejects(
      client.request({
        method: cell.method,
        path: resolveApiPath(cell.path, new ApiNotebookState()),
        tenantId: "87654321-4321-4321-4321-cba987654321",
        body: cell.body,
      }),
      LocalFirstViolationError,
      text,
    );
  }
  assert.equal(sent, false);
});
