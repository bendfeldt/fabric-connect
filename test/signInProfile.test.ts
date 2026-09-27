import assert from "node:assert/strict";
import { test } from "node:test";
import { TargetConfigError } from "../src/core/errors";
import {
  describeSignIn,
  readSignInProfile,
  tenantFromToken,
  writeSignInProfile,
} from "../src/core/signInProfile";

const TENANT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

function jwt(claims: unknown): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.signature`;
}

test("a missing file or section means the repo is not signed in", () => {
  assert.equal(readSignInProfile(undefined), undefined);
  assert.equal(readSignInProfile(""), undefined);
  assert.equal(readSignInProfile('{"compute": {}}'), undefined);
});

test("reads the saved account and tenant", () => {
  const text = JSON.stringify({
    signIn: {
      account: "you@contoso.com",
      accountId: "abc.def",
      tenantId: TENANT.toUpperCase(),
      tenantName: "Contoso",
    },
  });
  assert.deepEqual(readSignInProfile(text), {
    account: "you@contoso.com",
    accountId: "abc.def",
    tenantId: TENANT,
    tenantName: "Contoso",
  });
  assert.deepEqual(
    readSignInProfile(
      JSON.stringify({ signIn: { account: "a@b.com", tenantId: TENANT } }),
    ),
    { account: "a@b.com", tenantId: TENANT },
  );
});

test("an invalid sign-in section fails loudly, naming the field", () => {
  for (const [signIn, field] of [
    ["x", '"signIn" must be an object'],
    [{ tenantId: TENANT }, '"signIn.account"'],
    [{ account: "a@b.com", tenantId: "contoso" }, '"signIn.tenantId"'],
  ] as const) {
    assert.throws(
      () => readSignInProfile(JSON.stringify({ signIn })),
      (error: unknown) =>
        error instanceof TargetConfigError && error.message.includes(field),
    );
  }
  assert.throws(() => readSignInProfile("{not json"), TargetConfigError);
});

test("writing keeps every other key; undefined removes the sign-in", () => {
  const before = JSON.stringify({
    compute: { lakehouseId: "x" },
    targets: { dev: {} },
  });
  const signedIn = writeSignInProfile(before, {
    account: "you@contoso.com",
    tenantId: TENANT,
  });
  assert.deepEqual(JSON.parse(signedIn), {
    compute: { lakehouseId: "x" },
    targets: { dev: {} },
    signIn: { account: "you@contoso.com", tenantId: TENANT },
  });
  assert.ok(signedIn.endsWith("\n"));
  assert.deepEqual(JSON.parse(writeSignInProfile(signedIn, undefined)), {
    compute: { lakehouseId: "x" },
    targets: { dev: {} },
  });
  assert.deepEqual(
    JSON.parse(
      writeSignInProfile(undefined, { account: "a", tenantId: TENANT }),
    ),
    { signIn: { account: "a", tenantId: TENANT } },
  );
  assert.throws(
    () => writeSignInProfile("{broken", undefined),
    TargetConfigError,
    "never overwrites a file it cannot parse",
  );
});

test("the status text names the account, and the tenant when known", () => {
  assert.equal(
    describeSignIn({ account: "you@contoso.com", tenantId: TENANT }),
    "you@contoso.com",
  );
  assert.equal(
    describeSignIn({
      account: "you@contoso.com",
      tenantId: TENANT,
      tenantName: "Fabrikam",
    }),
    "you@contoso.com · Fabrikam",
  );
});

test("tenantFromToken reads the tid claim, and nothing from junk", () => {
  assert.equal(tenantFromToken(jwt({ tid: TENANT.toUpperCase() })), TENANT);
  assert.equal(tenantFromToken(jwt({ tid: "not-a-guid" })), undefined);
  assert.equal(tenantFromToken(jwt({ oid: "x" })), undefined);
  assert.equal(tenantFromToken("opaque-token"), undefined);
  assert.equal(tenantFromToken("a.%%%.c"), undefined);
  assert.equal(tenantFromToken(""), undefined);
});
