import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LocalFirstViolationError,
  QueryError,
  TargetConfigError,
} from "../src/core/errors";
import { FabricApiClient } from "../src/core/fabricApiClient";
import {
  queryKindOf,
  readQueryBinding,
  writeQueryBinding,
  type QueryBinding,
} from "../src/core/queryBindings";
import {
  graphqlTables,
  runDax,
  runGraphql,
  runKql,
  splitGraphqlVariables,
} from "../src/core/queryExecutors";
import type {
  FabricRequestOptions,
  FabricResponse,
  IFabricApiClient,
} from "../src/core/types";
import { assertWriteAllowed, serviceOrigin } from "../src/core/writePolicy";

const TENANT = "87654321-4321-4321-4321-cba987654321";
const WS = "11111111-1111-1111-1111-111111111111";
const ITEM = "22222222-2222-2222-2222-222222222222";
const KUSTO = "https://trd-abc123.z4.kusto.fabric.microsoft.com";

function fakeApi(
  body: unknown,
): IFabricApiClient & { calls: FabricRequestOptions[] } {
  const calls: FabricRequestOptions[] = [];
  return {
    calls,
    async request<T>(options: FabricRequestOptions) {
      calls.push(options);
      return { status: 200, body } as FabricResponse<T>;
    },
  };
}

// --- write policy for query services -------------------------------------------

test("query endpoints are allowed on their own services only", () => {
  const describe = "POST <path>";
  assertWriteAllowed(
    {
      method: "POST",
      path: "/v1/rest/query",
      tenantId: TENANT,
      service: { kind: "kusto", origin: KUSTO },
    },
    describe,
  );
  assertWriteAllowed(
    {
      method: "POST",
      path: `/v1.0/myorg/groups/${WS}/datasets/${ITEM}/executeQueries`,
      tenantId: TENANT,
      service: { kind: "powerbi" },
    },
    describe,
  );
  assertWriteAllowed(
    {
      method: "POST",
      path: `/workspaces/${WS}/graphqlapis/${ITEM}/graphql`,
      tenantId: TENANT,
    },
    describe,
  );
  const blocked: FabricRequestOptions[] = [
    // Kusto control commands go to /mgmt: blocked.
    {
      method: "POST",
      path: "/v1/rest/mgmt",
      tenantId: TENANT,
      service: { kind: "kusto", origin: KUSTO },
    },
    // Right path, wrong service.
    { method: "POST", path: "/v1/rest/query", tenantId: TENANT },
    {
      method: "POST",
      path: `/v1.0/myorg/groups/${WS}/datasets/${ITEM}/executeQueries`,
      tenantId: TENANT,
    },
    // Power BI writes (refresh, rebind) stay blocked.
    {
      method: "POST",
      path: `/v1.0/myorg/groups/${WS}/datasets/${ITEM}/refreshes`,
      tenantId: TENANT,
      service: { kind: "powerbi" },
    },
    {
      method: "POST",
      path: `/v1.0/myorg/groups/${WS}/imports`,
      tenantId: TENANT,
      service: { kind: "powerbi" },
    },
    // GraphQL API item definition stays blocked.
    {
      method: "POST",
      path: `/workspaces/${WS}/graphqlapis/${ITEM}/updateDefinition`,
      tenantId: TENANT,
    },
  ];
  for (const options of blocked) {
    assert.throws(
      () => assertWriteAllowed(options, describe),
      LocalFirstViolationError,
      options.path,
    );
  }
});

test("Kusto tokens only go to Fabric Kusto hosts", () => {
  assert.equal(serviceOrigin({ kind: "kusto", origin: KUSTO }), KUSTO);
  assert.equal(serviceOrigin({ kind: "kusto", origin: `${KUSTO}/` }), KUSTO);
  for (const origin of [
    "http://trd.kusto.fabric.microsoft.com",
    "https://evil.example.com",
    "https://kusto.fabric.microsoft.com.evil.com",
    "https://trd.kusto.fabric.microsoft.com:8443",
    "https://user@trd.kusto.fabric.microsoft.com",
    `${KUSTO}/v1/rest/query`,
    "not a url",
  ]) {
    assert.throws(
      () => serviceOrigin({ kind: "kusto", origin }),
      LocalFirstViolationError,
      origin,
    );
    // Even GETs are refused: the check guards the token, not just writes.
    assert.throws(
      () =>
        assertWriteAllowed(
          {
            method: "GET",
            path: "/v1/rest/query",
            tenantId: TENANT,
            service: { kind: "kusto", origin },
          },
          "GET <path>",
        ),
      LocalFirstViolationError,
    );
  }
});

test("the client routes services to their base URL and scope", async () => {
  const seen: Array<{ url: string; scopes: readonly string[] }> = [];
  let lastScopes: readonly string[] = [];
  const client = new FabricApiClient(
    {
      getToken: async (_t, scopes) => {
        lastScopes = scopes;
        return "t";
      },
    },
    {
      fetchFn: (async (url: unknown) => {
        seen.push({ url: String(url), scopes: lastScopes });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      sleep: async () => undefined,
    },
  );
  await client.request({
    method: "POST",
    path: "/v1/rest/query",
    tenantId: TENANT,
    service: { kind: "kusto", origin: KUSTO },
    body: {},
  });
  await client.request({
    method: "POST",
    path: `/v1.0/myorg/groups/${WS}/datasets/${ITEM}/executeQueries`,
    tenantId: TENANT,
    service: { kind: "powerbi" },
    body: {},
  });
  await client.request({
    method: "GET",
    path: "/workspaces",
    tenantId: TENANT,
  });
  assert.deepEqual(seen, [
    {
      url: `${KUSTO}/v1/rest/query`,
      scopes: ["https://kusto.kusto.windows.net/.default"],
    },
    {
      url: `https://api.powerbi.com/v1.0/myorg/groups/${WS}/datasets/${ITEM}/executeQueries`,
      scopes: ["https://analysis.windows.net/powerbi/api/.default"],
    },
    {
      url: "https://api.fabric.microsoft.com/v1/workspaces",
      scopes: ["https://api.fabric.microsoft.com/.default"],
    },
  ]);
});

// --- executors ------------------------------------------------------------------

test("KQL: query sent to the database, primary results from the table of contents", async () => {
  const api = fakeApi({
    Tables: [
      {
        TableName: "Table_0",
        Columns: [{ ColumnName: "n" }],
        Rows: [[1], [2]],
      },
      {
        TableName: "Table_1",
        Columns: [{ ColumnName: "Value" }],
        Rows: [["{}"]],
      },
      {
        TableName: "Table_2",
        Columns: [
          { ColumnName: "Ordinal" },
          { ColumnName: "Kind" },
          { ColumnName: "Name" },
          { ColumnName: "Id" },
          { ColumnName: "PrettyName" },
        ],
        Rows: [
          [0, "QueryResult", "PrimaryResult", "x", ""],
          [1, "QueryProperties", "@ExtendedProperties", "y", ""],
        ],
      },
    ],
  });
  const result = await runKql(
    api,
    TENANT,
    `${KUSTO}/`,
    "Telemetry",
    "Events | take 2",
  );
  assert.deepEqual(result.tables, [
    { columns: ["n"], rows: [[1], [2]], truncated: false },
  ]);
  assert.deepEqual(api.calls[0].body, {
    db: "Telemetry",
    csl: "Events | take 2",
  });
  assert.deepEqual(api.calls[0].service, { kind: "kusto", origin: KUSTO });
});

test("KQL with an unparsable query URI is a typed error", async () => {
  await assert.rejects(
    runKql(fakeApi({}), TENANT, "not a url", "db", "x"),
    QueryError,
  );
});

test("DAX: rows become a table; service errors are surfaced", async () => {
  const api = fakeApi({
    results: [
      { tables: [{ rows: [{ "T[a]": 1, "T[b]": "x" }, { "T[a]": 2 }] }] },
    ],
  });
  const result = await runDax(api, TENANT, WS, ITEM, "EVALUATE T");
  assert.deepEqual(result.tables, [
    {
      columns: ["T[a]", "T[b]"],
      rows: [
        [1, "x"],
        [2, null],
      ],
      truncated: false,
    },
  ]);
  assert.deepEqual(api.calls[0].body, {
    queries: [{ query: "EVALUATE T" }],
    serializerSettings: { includeNulls: true },
  });
  await assert.rejects(
    runDax(
      fakeApi({
        error: { code: "DatasetExecuteQueriesError", message: "bad syntax" },
      }),
      TENANT,
      WS,
      ITEM,
      "x",
    ),
    (error: unknown) =>
      error instanceof QueryError && /bad syntax/.test(error.message),
  );
});

test("GraphQL: items lists become tables; errors are surfaced", async () => {
  const api = fakeApi({
    data: {
      customers: {
        items: [
          { id: 1, name: "a" },
          { id: 2, city: "b" },
        ],
      },
    },
  });
  const { query, variables } = splitGraphqlVariables(
    '# variables: {"n": 2}\nquery { customers(first: $n) { items { id name } } }',
  );
  assert.deepEqual(variables, { n: 2 });
  const result = await runGraphql(api, TENANT, WS, ITEM, query, variables);
  assert.deepEqual(result.tables, [
    {
      columns: ["id", "name", "city"],
      rows: [
        [1, "a", null],
        [2, null, "b"],
      ],
      truncated: false,
    },
  ]);
  assert.deepEqual(api.calls[0].body, { query, variables: { n: 2 } });
  await assert.rejects(
    runGraphql(
      fakeApi({ errors: [{ message: "Unknown field" }] }),
      TENANT,
      WS,
      ITEM,
      "{ x }",
    ),
    (error: unknown) =>
      error instanceof QueryError && /Unknown field/.test(error.message),
  );
  assert.throws(
    () => splitGraphqlVariables("# variables: {nope\n{ x }"),
    QueryError,
  );
  assert.throws(
    () => splitGraphqlVariables("# variables: [1]\n{ x }"),
    QueryError,
  );
  assert.deepEqual(splitGraphqlVariables("{ x }"), { query: "{ x }" });
  assert.deepEqual(graphqlTables(null), []);
});

// --- bindings -------------------------------------------------------------------

const BINDING: QueryBinding = {
  kind: "kql",
  tenantId: TENANT,
  workspaceId: WS,
  itemId: ITEM,
  displayName: "Telemetry",
  queryServiceUri: KUSTO,
};

test("query kinds come from the file extension", () => {
  assert.equal(queryKindOf("a/b.kql"), "kql");
  assert.equal(queryKindOf("a/b.CSL"), "kql");
  assert.equal(queryKindOf("m.dax"), "dax");
  assert.equal(queryKindOf("q.gql"), "graphql");
  assert.equal(queryKindOf("x.sql"), undefined);
});

test("bindings round-trip in local.json next to other keys, by relative path", () => {
  const text = writeQueryBinding(
    '{"compute":{"a":1}}',
    "queries\\events.kql",
    BINDING,
  );
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.compute, { a: 1 });
  assert.deepEqual(readQueryBinding(text, "queries/events.kql"), BINDING);
  assert.equal(readQueryBinding(text, "other.kql"), undefined);
  assert.equal(readQueryBinding(undefined, "x.kql"), undefined);
});

test("malformed bindings are loud", () => {
  const bad = JSON.stringify({
    queryBindings: { "x.kql": { ...BINDING, itemId: "nope" } },
  });
  assert.throws(() => readQueryBinding(bad, "x.kql"), TargetConfigError);
  assert.throws(
    () => writeQueryBinding("{bad", "x.kql", BINDING),
    TargetConfigError,
  );
});
