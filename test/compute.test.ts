import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeCompute,
  readComputeProfile,
  writeComputeProfile,
  type ComputeProfile,
} from "../src/core/computeProfile";
import {
  ComputeError,
  LakehouseError,
  LocalFirstViolationError,
  TargetConfigError,
} from "../src/core/errors";
import { FabricApiClient } from "../src/core/fabricApiClient";
import {
  listAll,
  listCapacities,
  listWorkspaces,
} from "../src/core/fabricCatalog";
import {
  createLakehouse,
  validateLakehouseName,
} from "../src/core/lakehouseProvisioning";
import { resolveLivyHost } from "../src/core/livyHost";
import type {
  FabricRequestOptions,
  FabricResponse,
  IFabricApiClient,
} from "../src/core/types";
import { mintUserConfirmation } from "../src/core/writePolicy";

const TENANT = "87654321-4321-4321-4321-cba987654321";
const OTHER_TENANT = "99999999-4321-4321-4321-cba987654321";
const CAP = "aaaaaaaa-0000-0000-0000-000000000001";
const WS = "11111111-1111-1111-1111-111111111111";
const LH = "22222222-2222-2222-2222-222222222222";
const ENV = "33333333-3333-3333-3333-333333333333";

const PROFILE: ComputeProfile = {
  tenantId: TENANT,
  capacityId: CAP,
  workspaceId: WS,
  lakehouseId: LH,
  capacityName: "dev-cap",
  sku: "F4",
  workspaceName: "Sandbox",
  lakehouseName: "scratch",
};

type Route = (options: FabricRequestOptions) => FabricResponse<unknown>;

function fakeApi(route: Route): IFabricApiClient & {
  calls: FabricRequestOptions[];
} {
  const calls: FabricRequestOptions[] = [];
  return {
    calls,
    async request<T>(options: FabricRequestOptions) {
      calls.push(options);
      return route(options) as FabricResponse<T>;
    },
  };
}

// --- compute profile -------------------------------------------------------

test("compute profile round-trips and keeps other local.json keys", () => {
  const original = JSON.stringify({
    targets: { dev: { workspaceId: WS } },
    extra: [1, 2],
  });
  const written = writeComputeProfile(original, PROFILE);
  const parsed = JSON.parse(written);
  assert.deepEqual(parsed.targets, { dev: { workspaceId: WS } });
  assert.deepEqual(parsed.extra, [1, 2]);
  assert.deepEqual(readComputeProfile(written), PROFILE);
});

test("disconnect removes only the compute section", () => {
  const written = writeComputeProfile(
    writeComputeProfile('{"targets":{}}', PROFILE),
    undefined,
  );
  assert.deepEqual(JSON.parse(written), { targets: {} });
  assert.equal(readComputeProfile(written), undefined);
});

test("missing file or section means not connected", () => {
  assert.equal(readComputeProfile(undefined), undefined);
  assert.equal(readComputeProfile('{"targets":{}}'), undefined);
  assert.equal(
    JSON.parse(writeComputeProfile(undefined, PROFILE)).compute.lakehouseId,
    LH,
  );
});

test("a malformed compute section is a loud, specific error", () => {
  const bad = JSON.stringify({
    compute: { ...PROFILE, workspaceId: "not-a-guid" },
  });
  assert.throws(
    () => readComputeProfile(bad),
    (error: unknown) =>
      error instanceof TargetConfigError &&
      /compute\.workspaceId/.test(error.message) &&
      /Next step:/.test(error.message),
  );
  assert.throws(() => readComputeProfile("{nope"), TargetConfigError);
  assert.throws(
    () =>
      readComputeProfile(
        JSON.stringify({ compute: { ...PROFILE, environmentId: 5 } }),
      ),
    TargetConfigError,
  );
});

test("saving never clobbers an unreadable local.json", () => {
  assert.throws(
    () => writeComputeProfile("{broken", PROFILE),
    TargetConfigError,
  );
});

test("the compute label shows names, never IDs", () => {
  const label = describeCompute(PROFILE);
  assert.equal(label, "dev-cap F4 · Sandbox / scratch");
  assert.doesNotMatch(label, new RegExp(WS));
});

// --- catalog ---------------------------------------------------------------

test("listAll follows continuation tokens", async () => {
  const api = fakeApi((options) => {
    if (options.path === "/workspaces") {
      return {
        status: 200,
        body: { value: [{ id: "a" }], continuationToken: "t 1" },
      };
    }
    assert.equal(options.path, "/workspaces?continuationToken=t%201");
    return { status: 200, body: { value: [{ id: "b" }] } };
  });
  const all = await listAll<{ id: string }>(api, TENANT, "/workspaces");
  assert.deepEqual(
    all.map((w) => w.id),
    ["a", "b"],
  );
});

test("listAll stops a runaway continuation loop with a typed error", async () => {
  const api = fakeApi(() => ({
    status: 200,
    body: { value: [], continuationToken: "again" },
  }));
  await assert.rejects(listAll(api, TENANT, "/workspaces"), ComputeError);
});

test("capacities carry SKU, region and state; workspaces filter by capacity", async () => {
  const api = fakeApi((options) =>
    options.path === "/capacities"
      ? {
          status: 200,
          body: {
            value: [
              {
                id: CAP,
                displayName: "dev-cap",
                sku: "F4",
                region: "West Europe",
                state: "Active",
              },
              { displayName: "no id" },
            ],
          },
        }
      : {
          status: 200,
          body: {
            value: [
              {
                id: WS,
                displayName: "Sandbox",
                type: "Workspace",
                capacityId: CAP.toUpperCase(),
              },
              { id: "x", displayName: "Elsewhere", capacityId: "other" },
              { id: "y", displayName: "My workspace" },
            ],
          },
        },
  );
  assert.deepEqual(await listCapacities(api, TENANT), [
    {
      id: CAP,
      displayName: "dev-cap",
      sku: "F4",
      region: "West Europe",
      state: "Active",
    },
  ]);
  const onCapacity = await listWorkspaces(api, TENANT, CAP);
  assert.deepEqual(
    onCapacity.map((w) => w.displayName),
    ["Sandbox"],
  );
});

test("catalog failures are wrapped with operation and next step", async () => {
  const api = fakeApi(() => {
    throw new Error("boom");
  });
  await assert.rejects(
    listCapacities(api, TENANT),
    (error: unknown) =>
      error instanceof ComputeError &&
      error.operation === "list capacities" &&
      error.cause instanceof Error,
  );
});

// --- lakehouse provisioning (D3) --------------------------------------------

test("lakehouse names follow Fabric's rule", () => {
  assert.equal(validateLakehouseName("fabric_connect_scratch"), undefined);
  assert.notEqual(validateLakehouseName("1abc"), undefined);
  assert.notEqual(validateLakehouseName("has space"), undefined);
  assert.notEqual(validateLakehouseName(""), undefined);
});

test("create returns the new lakehouse on 201 and passes the confirmation", async () => {
  const confirmation = mintUserConfirmation("create-lakehouse", WS, "scratch");
  const api = fakeApi((options) => {
    if (options.method === "GET") {
      return { status: 200, body: { value: [] } };
    }
    assert.equal(options.confirmation, confirmation);
    assert.deepEqual(options.body, { displayName: "scratch" });
    return { status: 201, body: { id: LH, displayName: "scratch" } };
  });
  assert.deepEqual(
    await createLakehouse(api, TENANT, WS, "scratch", confirmation),
    { id: LH, displayName: "scratch" },
  );
});

test("create waits for a 202 provisioning to show up in the list", async () => {
  let lists = 0;
  const api = fakeApi((options) => {
    if (options.method === "POST") {
      return { status: 202, body: undefined };
    }
    lists++;
    return {
      status: 200,
      body: { value: lists < 3 ? [] : [{ id: LH, displayName: "scratch" }] },
    };
  });
  const created = await createLakehouse(
    api,
    TENANT,
    WS,
    "scratch",
    mintUserConfirmation("create-lakehouse", WS, "scratch"),
    { sleep: async () => undefined },
  );
  assert.equal(created.id, LH);
});

test("create refuses an existing name before calling the API", async () => {
  const api = fakeApi((options) => {
    assert.equal(options.method, "GET");
    return {
      status: 200,
      body: { value: [{ id: LH, displayName: "scratch" }] },
    };
  });
  await assert.rejects(
    createLakehouse(
      api,
      TENANT,
      WS,
      "scratch",
      mintUserConfirmation("create-lakehouse", WS, "scratch"),
    ),
    LakehouseError,
  );
  assert.ok(api.calls.every((c) => c.method === "GET"));
});

test("create times out loudly when provisioning never finishes", async () => {
  const api = fakeApi((options) =>
    options.method === "POST"
      ? { status: 202, body: undefined }
      : { status: 200, body: { value: [] } },
  );
  await assert.rejects(
    createLakehouse(
      api,
      TENANT,
      WS,
      "scratch",
      mintUserConfirmation("create-lakehouse", WS, "scratch"),
      { sleep: async () => undefined, timeoutMs: 0 },
    ),
    LakehouseError,
  );
});

test("through the real client, create without a confirmation never leaves the machine", async () => {
  let posted = false;
  const client = new FabricApiClient(
    { getToken: async () => "token" },
    {
      fetchFn: (async (_url: unknown, init?: RequestInit) => {
        if (init?.method === "POST") {
          posted = true;
        }
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }) as typeof fetch,
      sleep: async () => undefined,
    },
  );
  const forged = {
    action: "create-lakehouse",
    workspaceId: WS,
    displayName: "scratch",
  };
  await assert.rejects(
    createLakehouse(
      client,
      TENANT,
      WS,
      "scratch",
      forged as unknown as Parameters<typeof createLakehouse>[4],
    ),
    (error: unknown) =>
      error instanceof LakehouseError &&
      error.cause instanceof LocalFirstViolationError,
  );
  assert.equal(posted, false);
});

// --- Livy host precedence (M0.4) ---------------------------------------------

const TARGET = {
  targetName: "dev",
  workspaceId: "44444444-4444-4444-4444-444444444444",
  itemType: "notebook",
  tenantId: TENANT,
};

test("a notebook's own default Lakehouse wins, in the target's workspace", () => {
  const host = resolveLivyHost({
    entity: "nb",
    notebookDefault: { id: "nb-lh", name: "Bronze", workspaceId: WS },
    target: TARGET,
    compute: PROFILE,
  });
  assert.equal(host.source, "notebook");
  assert.deepEqual(host.target, {
    tenantId: TENANT,
    workspaceId: TARGET.workspaceId,
    lakehouseId: "nb-lh",
  });
  assert.match(host.label, /Bronze/);
});

test("without a target, the notebook's own workspace and the compute tenant are used", () => {
  const host = resolveLivyHost({
    entity: "nb",
    notebookDefault: { id: "nb-lh", workspaceId: WS },
    compute: PROFILE,
  });
  assert.equal(host.target.workspaceId, WS);
  assert.equal(host.target.tenantId, TENANT);
});

test("a notebook Lakehouse with no known tenant is an error, not a guess", () => {
  assert.throws(
    () =>
      resolveLivyHost({
        entity: "nb",
        notebookDefault: { id: "nb-lh", workspaceId: WS },
      }),
    ComputeError,
  );
});

test("the notebook's Environment is used only in the host workspace", () => {
  const same = resolveLivyHost({
    entity: "nb",
    notebookDefault: { id: "nb-lh", workspaceId: WS },
    notebookEnvironment: { id: ENV, workspaceId: WS },
    compute: PROFILE,
  });
  assert.equal(same.target.environmentId, ENV);
  const other = resolveLivyHost({
    entity: "nb",
    notebookDefault: { id: "nb-lh" },
    notebookEnvironment: { id: ENV, workspaceId: WS },
    target: TARGET,
  });
  assert.equal(other.target.environmentId, undefined);
});

test("code without a Lakehouse runs on the connected compute and its Environment", () => {
  const host = resolveLivyHost({
    entity: "job.py",
    compute: { ...PROFILE, environmentId: ENV },
  });
  assert.equal(host.source, "compute");
  assert.deepEqual(host.target, {
    tenantId: TENANT,
    workspaceId: WS,
    lakehouseId: LH,
    environmentId: ENV,
  });
});

test("no Lakehouse and no compute is a loud error naming both fixes", () => {
  assert.throws(
    () => resolveLivyHost({ entity: "job.py" }),
    (error: unknown) =>
      error instanceof ComputeError &&
      /Connect to Compute/.test(error.message) &&
      /Manage Lakehouses/.test(error.message),
  );
});

test("compute in another tenant than the folder's target is refused", () => {
  assert.throws(
    () =>
      resolveLivyHost({
        entity: "job.py",
        target: { ...TARGET, tenantId: OTHER_TENANT },
        compute: PROFILE,
      }),
    (error: unknown) =>
      error instanceof ComputeError && /different tenant/.test(error.message),
  );
});
