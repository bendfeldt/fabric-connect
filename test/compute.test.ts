import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capacityDisplayName,
  describeCompute,
  hostOf,
  withoutHost,
  readComputeProfile,
  writeComputeProfile,
  type ComputeProfile,
} from "../src/core/computeProfile";
import {
  ComputeError,
  DefaultLakehouseUnboundError,
  FabricApiError,
  HostLakehouseNeededError,
  TargetConfigError,
} from "../src/core/errors";
import {
  capacitiesFromWorkspaces,
  describeWorkspaceCapacity,
  findLakehousesByName,
  isPlaceholderName,
  listPowerBiCapacities,
  mergeCapacities,
  listAll,
  listCapacities,
  listUsableCapacities,
  listWorkspaces,
} from "../src/core/fabricCatalog";
import {
  diagnoseLivyHost,
  probeLivyHost,
  resolveLivyHost,
} from "../src/core/livyHost";
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
/** A notebook's own default Lakehouse. */
const NB_LH = "55555555-5555-5555-5555-555555555555";

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

const OTHER_CAP = "bbbbbbbb-0000-0000-0000-000000000002";

test("connecting saves only the capacity; the host Lakehouse is optional", () => {
  const capacityOnly = withoutHost(PROFILE);
  assert.deepEqual(capacityOnly, {
    tenantId: TENANT,
    capacityId: CAP,
    capacityName: "dev-cap",
    sku: "F4",
  });
  const written = writeComputeProfile('{"targets":{}}', capacityOnly);
  assert.deepEqual(readComputeProfile(written), capacityOnly);
  assert.equal(hostOf(capacityOnly), undefined);
  assert.equal(
    hostOf(readComputeProfile(writeComputeProfile(undefined, PROFILE))!)
      ?.lakehouseId,
    LH,
    "an existing full profile reads as capacity + host",
  );
});

test("the host names workspace and Lakehouse together; Environment needs a host", () => {
  const { lakehouseId: _lh, ...halfHost } = PROFILE;
  assert.throws(
    () => readComputeProfile(JSON.stringify({ compute: halfHost })),
    (error: unknown) =>
      error instanceof TargetConfigError &&
      /both or neither/.test(error.message),
  );
  assert.throws(
    () =>
      readComputeProfile(
        JSON.stringify({
          compute: { ...withoutHost(PROFILE), environmentId: ENV },
        }),
      ),
    (error: unknown) =>
      error instanceof TargetConfigError &&
      /needs a host Lakehouse/.test(error.message),
  );
});

test("a capacity label is validated, read back and shown instead of the listed name", () => {
  const labelled = { ...withoutHost(PROFILE), capacityLabel: "Prod" };
  const read = readComputeProfile(writeComputeProfile(undefined, labelled));
  assert.equal(read?.capacityLabel, "Prod");
  assert.equal(capacityDisplayName(read!), "Prod");
  assert.equal(describeCompute(read!), "Prod F4");
  for (const bad of ["", "   ", 5, "x".repeat(101)]) {
    assert.throws(
      () =>
        readComputeProfile(
          JSON.stringify({
            compute: { ...withoutHost(PROFILE), capacityLabel: bad },
          }),
        ),
      (error: unknown) =>
        error instanceof TargetConfigError &&
        /capacityLabel/.test(error.message),
    );
  }
});

test("the compute label shows names, never IDs", () => {
  const label = describeCompute(PROFILE);
  assert.equal(label, "dev-cap F4 · Sandbox / scratch");
  assert.doesNotMatch(label, new RegExp(WS));
  assert.equal(describeCompute(withoutHost(PROFILE)), "dev-cap F4");
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

test("capacities behind workspaces show even when they cannot be listed", () => {
  const listed = [
    {
      id: CAP,
      displayName: "dev-cap",
      sku: "F4",
      region: "West Europe",
      state: "Active",
    },
  ];
  const ws = (id: string, capacityId?: string) => ({
    id,
    displayName: id,
    type: "Workspace",
    capacityId,
  });
  const capacities = capacitiesFromWorkspaces(
    [
      ws("a", CAP.toUpperCase()),
      ws("b", OTHER_CAP),
      ws("c", OTHER_CAP.toUpperCase()),
      ws("d"),
    ],
    listed,
  );
  assert.deepEqual(capacities, [
    listed[0],
    {
      id: OTHER_CAP,
      displayName: "Capacity bbbbbbbb",
      sku: "",
      region: "",
      state: "Unknown",
    },
  ]);
  assert.equal(
    describeWorkspaceCapacity(ws("b", OTHER_CAP), capacities),
    "Capacity bbbbbbbb",
    "an unknown state is not shown as if the capacity were paused",
  );
});

test("listing capacities may be forbidden; workspaces still name them, and the reason is kept", async () => {
  const api = fakeApi((options) => {
    if (options.path.includes("capacities")) {
      throw new Error("HTTP 403 Forbidden");
    }
    return {
      status: 200,
      body: {
        value: [{ id: WS, displayName: "Sandbox", capacityId: CAP }],
      },
    };
  });
  const { capacities, workspaces, listError } = await listUsableCapacities(
    api,
    TENANT,
  );
  assert.deepEqual(
    capacities.map((c) => [c.id, c.state]),
    [[CAP, "Unknown"]],
  );
  assert.equal(isPlaceholderName(capacities[0]), true);
  assert.equal(workspaces.length, 1);
  assert.match(listError ?? "", /capacities/);
  const failing = fakeApi(() => {
    throw new Error("boom");
  });
  await assert.rejects(
    listUsableCapacities(failing, TENANT),
    (error: unknown) =>
      error instanceof ComputeError && error.operation === "list workspaces",
  );
});

test("Power BI's capacity list supplies the name Fabric's listing lacks", async () => {
  const api = fakeApi((options) => {
    if (options.service?.kind === "powerbi") {
      assert.equal(options.path, "/v1.0/myorg/capacities");
      assert.equal(options.method, "GET");
      return {
        status: 200,
        body: {
          value: [
            {
              id: CAP.toUpperCase(),
              displayName: "Prod Capacity",
              sku: "F64",
              region: "North Europe",
              state: "Active",
            },
          ],
        },
      };
    }
    if (options.path === "/capacities") {
      return { status: 200, body: { value: [] } };
    }
    return {
      status: 200,
      body: { value: [{ id: WS, displayName: "Sandbox", capacityId: CAP }] },
    };
  });
  assert.equal((await listPowerBiCapacities(api, TENANT))[0].sku, "F64");
  const { capacities, listError } = await listUsableCapacities(api, TENANT);
  assert.equal(listError, undefined);
  assert.deepEqual(
    capacities.map((c) => [c.displayName, c.sku, c.state]),
    [["Prod Capacity", "F64", "Active"]],
  );
});

test("merging capacities keeps the first real name and fills gaps", () => {
  const placeholder = {
    id: CAP,
    displayName: `Capacity ${CAP.slice(0, 8)}`,
    sku: "",
    region: "",
    state: "Unknown",
  };
  const named = {
    id: CAP.toUpperCase(),
    displayName: "Prod",
    sku: "F64",
    region: "West Europe",
    state: "Active",
  };
  const other = { ...named, id: OTHER_CAP, displayName: "Other" };
  assert.deepEqual(mergeCapacities([placeholder, other], [named]), [
    { ...named, id: CAP },
    other,
  ]);
  assert.equal(
    mergeCapacities([{ ...named, displayName: "First" }], [named])[0]
      .displayName,
    "First",
    "an earlier real name is not replaced",
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

// Spec change (user feedback 2026-10-02, option B): a mapped folder's
// target no longer overrides the workspace of a notebook's default
// Lakehouse; the workspace in the notebook's metadata is used.
test("a notebook's own default Lakehouse wins, in its own workspace even when the folder is mapped", () => {
  const host = resolveLivyHost({
    entity: "nb",
    notebookDefault: { id: NB_LH, name: "Bronze", workspaceId: WS },
    target: TARGET,
    compute: PROFILE,
  });
  assert.equal(host.source, "notebook");
  assert.deepEqual(host.target, {
    tenantId: TENANT,
    workspaceId: WS,
    lakehouseId: NB_LH,
  });
  assert.match(host.label, /Bronze/);
});

test("a default Lakehouse without a workspace in the metadata is an error, not the target's", () => {
  assert.throws(
    () =>
      resolveLivyHost({
        entity: "nb",
        notebookDefault: { id: NB_LH, name: "Bronze" },
        target: TARGET,
        compute: PROFILE,
      }),
    (error: unknown) =>
      error instanceof ComputeError &&
      /which workspace/.test(error.message) &&
      /Set as Default/.test(error.message),
  );
});

test("without a target, the notebook's own workspace and the compute tenant are used", () => {
  const host = resolveLivyHost({
    entity: "nb",
    notebookDefault: { id: NB_LH, workspaceId: WS },
    compute: PROFILE,
  });
  assert.equal(host.target.workspaceId, WS);
  assert.equal(host.target.tenantId, TENANT);
});

test("signed in without compute, a notebook runs on its Lakehouse in the sign-in tenant", () => {
  const host = resolveLivyHost({
    entity: "nb",
    notebookDefault: { id: NB_LH, workspaceId: WS },
    signedInTenant: OTHER_TENANT,
  });
  assert.equal(host.source, "notebook");
  assert.equal(host.target.tenantId, OTHER_TENANT);
  assert.equal(host.target.workspaceId, WS);
});

test("the folder's target tenant wins over the sign-in, which wins over compute", () => {
  const notebookDefault = { id: NB_LH, workspaceId: WS };
  assert.equal(
    resolveLivyHost({
      entity: "nb",
      notebookDefault,
      target: TARGET,
      signedInTenant: OTHER_TENANT,
      compute: PROFILE,
    }).target.tenantId,
    TENANT,
  );
  assert.equal(
    resolveLivyHost({
      entity: "nb",
      notebookDefault,
      signedInTenant: OTHER_TENANT,
      compute: PROFILE,
    }).target.tenantId,
    OTHER_TENANT,
  );
});

test("a notebook Lakehouse with no known tenant is an error, not a guess", () => {
  assert.throws(
    () =>
      resolveLivyHost({
        entity: "nb",
        notebookDefault: { id: NB_LH, workspaceId: WS },
      }),
    (error: unknown) =>
      error instanceof ComputeError &&
      /which tenant/.test(error.message) &&
      /Fabric: Sign In/.test(error.message),
  );
});

test("the notebook's Environment is used only in the host workspace", () => {
  const same = resolveLivyHost({
    entity: "nb",
    notebookDefault: { id: NB_LH, workspaceId: WS },
    notebookEnvironment: { id: ENV, workspaceId: WS },
    compute: PROFILE,
  });
  assert.equal(same.target.environmentId, ENV);
  const other = resolveLivyHost({
    entity: "nb",
    notebookDefault: { id: NB_LH, workspaceId: TARGET.workspaceId },
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

test("code without a Lakehouse on a capacity with no host asks for one", () => {
  assert.throws(
    () => resolveLivyHost({ entity: "job.py", compute: withoutHost(PROFILE) }),
    (error: unknown) =>
      error instanceof HostLakehouseNeededError &&
      error instanceof ComputeError &&
      /host Lakehouse/.test(error.message),
  );
  // A notebook with its own default Lakehouse needs no host.
  assert.equal(
    resolveLivyHost({
      entity: "nb",
      notebookDefault: { id: NB_LH, workspaceId: WS },
      compute: withoutHost(PROFILE),
    }).source,
    "notebook",
  );
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

test("a notebook whose default Lakehouse is not bound is refused, not run on the host", () => {
  assert.throws(
    () =>
      resolveLivyHost({
        entity: "notebook publish_metadata.Notebook",
        unboundDefault: { name: "Bronze" },
        signedInTenant: TENANT,
        compute: PROFILE,
      }),
    (error: unknown) =>
      error instanceof ComputeError &&
      !(error instanceof HostLakehouseNeededError) &&
      /'Bronze' is not bound/.test(error.message) &&
      /Lakehouses view/.test(error.message),
  );
  // No default at all still runs on the host Lakehouse.
  assert.equal(
    resolveLivyHost({ entity: "nb", compute: PROFILE }).source,
    "compute",
  );
});

test("the unbound error carries the Lakehouse name and points to Bind Lakehouse", () => {
  assert.throws(
    () =>
      resolveLivyHost({
        entity: "nb",
        unboundDefault: { name: "lh_analytics" },
        signedInTenant: TENANT,
      }),
    (error: unknown) =>
      error instanceof DefaultLakehouseUnboundError &&
      error.lakehouseName === "lh_analytics" &&
      /Bind Lakehouse/.test(error.message),
  );
});

test("Lakehouses are found by name, case-insensitively, ordered by workspace", () => {
  const at = (name: string, id: string, workspace: string) => ({
    lakehouse: { id, displayName: name },
    workspace: { id: `ws-${workspace}`, displayName: workspace },
  });
  const candidates = [
    at("lh_analytics", "1", "Prod"),
    at("LH_Analytics ", "2", "Dev"),
    at("lh_raw", "3", "Dev"),
  ];
  assert.deepEqual(
    findLakehousesByName(" lh_analytics", candidates).map((m) => [
      m.workspace.displayName,
      m.lakehouse.id,
    ]),
    [
      ["Dev", "2"],
      ["Prod", "1"],
    ],
  );
  assert.deepEqual(findLakehousesByName("missing", candidates), []);
});

test("a binding on this machine runs as the notebook's Lakehouse and says so", () => {
  const host = resolveLivyHost({
    entity: "nb",
    notebookDefault: { id: NB_LH, name: "lh_analytics", workspaceId: WS },
    boundLocally: true,
    signedInTenant: TENANT,
  });
  assert.equal(host.source, "notebook");
  assert.deepEqual(host.target, {
    tenantId: TENANT,
    workspaceId: WS,
    lakehouseId: NB_LH,
  });
  assert.equal(host.label, "lh_analytics (bound on this machine)");
});

test("a placeholder or malformed Lakehouse target never reaches Livy", () => {
  const NIL = "00000000-0000-0000-0000-000000000000";
  for (const notebookDefault of [
    { id: NIL, workspaceId: WS },
    { id: NB_LH, workspaceId: NIL },
    { id: "not-a-guid", workspaceId: WS },
  ]) {
    assert.throws(
      () =>
        resolveLivyHost({
          entity: "nb",
          notebookDefault,
          signedInTenant: TENANT,
        }),
      (error: unknown) =>
        error instanceof ComputeError &&
        /placeholder or not a GUID/.test(error.message),
    );
  }
});

// --- explaining a failed session start ---------------------------------------

const HOST_TARGET = { tenantId: TENANT, workspaceId: WS, lakehouseId: LH };
const apiError = (status: number) =>
  new FabricApiError("x", { operation: "call Fabric API", status });

test("probing a host reads the workspace's capacity and the Lakehouse", async () => {
  const api = fakeApi((options) => {
    assert.equal(options.method, "GET");
    return options.path === `/workspaces/${WS}`
      ? { status: 200, body: { id: WS, capacityId: CAP } }
      : { status: 200, body: { id: LH } };
  });
  assert.deepEqual(await probeLivyHost(api, HOST_TARGET), {
    workspace: "found",
    lakehouse: "found",
    capacityId: CAP,
  });
  assert.deepEqual(
    api.calls.map((c) => c.path),
    [`/workspaces/${WS}`, `/workspaces/${WS}/lakehouses/${LH}`],
  );
});

test("probing never throws and maps 404 / 403 to missing / forbidden", async () => {
  const missing = fakeApi(() => {
    throw apiError(404);
  });
  assert.deepEqual(await probeLivyHost(missing, HOST_TARGET), {
    workspace: "missing",
    lakehouse: "unknown",
  });
  const forbidden = fakeApi(() => {
    throw apiError(403);
  });
  assert.equal(
    (await probeLivyHost(forbidden, HOST_TARGET)).workspace,
    "forbidden",
  );
  const noLakehouse = fakeApi((options) => {
    if (options.path.includes("lakehouses")) {
      throw apiError(404);
    }
    return { status: 200, body: { capacityId: CAP } };
  });
  assert.equal(
    (await probeLivyHost(noLakehouse, HOST_TARGET)).lakehouse,
    "missing",
  );
});

test("a failed start is explained by the host's workspace, capacity or Lakehouse", () => {
  const gone = diagnoseLivyHost(
    { workspace: "missing", lakehouse: "unknown" },
    "notebook",
  );
  assert.match(gone?.why ?? "", /workspace that does not exist/);
  assert.match(gone?.next ?? "", /Lakehouses view/);
  assert.match(
    diagnoseLivyHost(
      { workspace: "forbidden", lakehouse: "unknown" },
      "compute",
    )?.next ?? "",
    /Change Host Lakehouse/,
  );
  assert.match(
    diagnoseLivyHost({ workspace: "found", lakehouse: "found" }, "notebook")
      ?.why ?? "",
    /not assigned to a Fabric capacity/,
  );
  assert.match(
    diagnoseLivyHost(
      { workspace: "found", capacityId: CAP, lakehouse: "missing" },
      "notebook",
    )?.why ?? "",
    /no longer exists/,
  );
  assert.equal(
    diagnoseLivyHost(
      { workspace: "found", capacityId: CAP, lakehouse: "found" },
      "notebook",
    ),
    undefined,
    "nothing found wrong: no guess",
  );
  assert.equal(
    diagnoseLivyHost(
      { workspace: "unknown", lakehouse: "unknown" },
      "notebook",
    ),
    undefined,
  );
});
