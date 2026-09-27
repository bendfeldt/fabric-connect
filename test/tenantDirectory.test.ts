import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthError, LocalFirstViolationError } from "../src/core/errors";
import { FabricApiClient } from "../src/core/fabricApiClient";
import {
  label,
  listAccountTenants,
  mergeTenantChoices,
  parseTenantInput,
  resolveTenantDomain,
} from "../src/core/tenantDirectory";
import type { IAuthProvider } from "../src/core/types";

const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function armClient(pages: unknown[]) {
  const calls: Array<{ url: string; method?: string }> = [];
  const tokens: Array<{ tenantId: string; scopes: readonly string[] }> = [];
  const auth: IAuthProvider = {
    getToken: async (tenantId, scopes) => {
      tokens.push({ tenantId, scopes });
      return "arm-token";
    },
  };
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    const page = pages.shift();
    if (page === undefined) {
      throw new Error("unexpected extra request");
    }
    return json(200, page);
  }) as typeof fetch;
  const client = new FabricApiClient(auth, {
    fetchFn,
    sleep: async () => undefined,
  });
  return { client, calls, tokens };
}

test("parseTenantInput accepts a GUID or a domain, nothing else", () => {
  assert.deepEqual(parseTenantInput(` ${A.toUpperCase()} `), {
    kind: "id",
    id: A,
  });
  assert.deepEqual(parseTenantInput("Contoso.onmicrosoft.com"), {
    kind: "domain",
    domain: "contoso.onmicrosoft.com",
  });
  assert.deepEqual(parseTenantInput("fabrikam.com"), {
    kind: "domain",
    domain: "fabrikam.com",
  });
  for (const bad of [
    "",
    "contoso",
    "not a tenant",
    "https://contoso.com",
    "contoso.com/../x",
    "user@contoso.com",
  ]) {
    assert.equal(parseTenantInput(bad), undefined, bad);
  }
});

test("listAccountTenants reads ARM /tenants with the home tenant and ARM scope", async () => {
  const { client, calls, tokens } = armClient([
    {
      value: [
        { tenantId: B, displayName: "Fabrikam", defaultDomain: "fabrikam.com" },
        {
          tenantId: A.toUpperCase(),
          displayName: "Contoso",
          defaultDomain: "contoso.onmicrosoft.com",
        },
        { tenantId: "not-a-guid", displayName: "Broken" },
      ],
    },
  ]);
  const tenants = await listAccountTenants(client);
  assert.deepEqual(tenants, [
    { id: A, displayName: "Contoso", defaultDomain: "contoso.onmicrosoft.com" },
    { id: B, displayName: "Fabrikam", defaultDomain: "fabrikam.com" },
  ]);
  assert.deepEqual(calls, [
    {
      url: "https://management.azure.com/tenants?api-version=2022-12-01",
      method: "GET",
    },
  ]);
  assert.deepEqual(tokens, [
    {
      tenantId: "organizations",
      scopes: ["https://management.azure.com/.default"],
    },
  ]);
});

test("listAccountTenants follows ARM nextLinks but never leaves the ARM origin", async () => {
  const { client, calls } = armClient([
    {
      value: [{ tenantId: A }],
      nextLink:
        "https://management.azure.com/tenants?api-version=2022-12-01&$skiptoken=abc123",
    },
    {
      value: [{ tenantId: B }],
      nextLink: "https://evil.example.com/tenants?api-version=2022-12-01",
    },
  ]);
  const tenants = await listAccountTenants(client);
  assert.deepEqual(
    tenants.map((t) => t.id),
    [A, B],
  );
  assert.equal(calls.length, 2);
  assert.equal(
    calls[1].url,
    "https://management.azure.com/tenants?api-version=2022-12-01&$skiptoken=abc123",
  );
});

test("the only ARM request allowed is GET /tenants", async () => {
  const { client, calls, tokens } = armClient([]);
  for (const options of [
    { method: "GET" as const, path: "/subscriptions?api-version=2022-12-01" },
    { method: "POST" as const, path: "/tenants?api-version=2022-12-01" },
    {
      method: "GET" as const,
      path: "/tenants?api-version=2022-12-01&$filter=x",
    },
    { method: "GET" as const, path: "/tenants/../subscriptions" },
  ]) {
    await assert.rejects(
      client.request({
        ...options,
        tenantId: "organizations",
        service: { kind: "arm" },
      }),
      LocalFirstViolationError,
      `${options.method} ${options.path}`,
    );
  }
  assert.equal(calls.length, 0, "blocked requests never reach the network");
  assert.equal(tokens.length, 0, "blocked requests never request a token");
});

test("resolveTenantDomain reads the tenant ID from OpenID discovery, without a token", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return json(200, {
      issuer: `https://login.microsoftonline.com/${A.toUpperCase()}/v2.0`,
    });
  }) as typeof fetch;
  assert.equal(
    await resolveTenantDomain("contoso.onmicrosoft.com", fetchFn),
    A,
  );
  assert.equal(
    requests[0].url,
    "https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0/.well-known/openid-configuration",
  );
  assert.equal(
    (requests[0].init?.headers as Record<string, string> | undefined)
      ?.Authorization,
    undefined,
  );
});

test("resolveTenantDomain explains unknown domains, bad input and odd responses", async () => {
  const respond = (response: Response | Error) =>
    (async () => {
      if (response instanceof Error) {
        throw response;
      }
      return response;
    }) as unknown as typeof fetch;
  await assert.rejects(
    resolveTenantDomain("nope.example", respond(json(400, {}))),
    (error: unknown) =>
      error instanceof AuthError &&
      /No Entra tenant was found for 'nope.example'/.test(error.message),
  );
  await assert.rejects(
    resolveTenantDomain("contoso.com", respond(new Error("offline"))),
    (error: unknown) =>
      error instanceof AuthError && /Could not reach/.test(error.message),
  );
  await assert.rejects(
    resolveTenantDomain(
      "contoso.com",
      respond(json(200, { issuer: "https://attacker.example/x/v2.0" })),
    ),
    AuthError,
  );
  let called = false;
  await assert.rejects(
    resolveTenantDomain("../../evil", (async () => {
      called = true;
      return json(200, {});
    }) as unknown as typeof fetch),
    AuthError,
  );
  assert.equal(called, false, "invalid domains never reach the network");
});

test("mergeTenantChoices de-duplicates by ID and keeps the first known name", () => {
  const merged = mergeTenantChoices(
    [{ id: A.toUpperCase() }],
    [
      { id: A, displayName: "Contoso", defaultDomain: "contoso.com" },
      { id: "junk" },
    ],
    [
      { id: B, defaultDomain: "fabrikam.com" },
      { id: A, displayName: "Other" },
    ],
  );
  assert.deepEqual(merged, [
    { id: A, displayName: "Contoso", defaultDomain: "contoso.com" },
    { id: B, displayName: undefined, defaultDomain: "fabrikam.com" },
  ]);
  assert.equal(label(merged[0]), "Contoso");
  assert.equal(label(merged[1]), "fabrikam.com");
  assert.equal(label({ id: A }), A);
});
