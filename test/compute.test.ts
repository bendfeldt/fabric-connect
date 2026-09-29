import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeCompute,
  readComputeProfile,
  writeComputeProfile,
  type ComputeProfile,
} from "../src/core/computeProfile";
import { ComputeError, TargetConfigError } from "../src/core/errors";
import {
  describeWorkspaceCapacity,
  listAll,
  listCapacities,
  listWorkspaces,
} from "../src/core/fabricCatalog";
import { resolveLivyHost } from "../src/core/livyHost";
import type {
  FabricRequestOptions,
  FabricResponse,
  IFabricApiClient,
} from "../src/core/types";

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

test("a workspace shows the SKU and name of its capacity, and when it is paused", () => {
  const capacity = {
    id: CAP,
    displayName: "dev-cap",
    sku: "F4",
    region: "West Europe",
    state: "Active",
  };
  const workspace = (capacityId?: string) => ({
    id: WS,
    displayName: "Sandbox",
    type: "Workspace",
    capacityId,
  });
  assert.equal(
    describeWorkspaceCapacity(workspace(CAP.toUpperCase()), [capacity]),
    "F4 · dev-cap",
  );
  assert.equal(
    describeWorkspaceCapacity(workspace(CAP), [
      { ...capacity, state: "Inactive" },
    ]),
    "F4 · dev-cap · Inactive",
  );
  assert.equal(
    describeWorkspaceCapacity(workspace(), [capacity]),
    "no capacity",
  );
  assert.equal(
    describeWorkspaceCapacity(workspace("not-listed"), [capacity]),
    "unknown capacity",
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
