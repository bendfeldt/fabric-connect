import assert from "node:assert/strict";
import { test } from "node:test";
import { TargetConfigError } from "../src/core/errors";
import {
  notebookKey,
  readLakehouseBindings,
  writeLakehouseBinding,
} from "../src/core/lakehouseBindings";

const LH = "b2f230c4-b112-4cb4-a167-e4962900d1a5";
const WS = "39550824-a857-47a4-8651-52f804a372c5";
const NIL = "00000000-0000-0000-0000-000000000000";
const KEY = "notebooks/consolidated_entity_template.Notebook";

test("a binding round-trips and keeps every other local.json key", () => {
  const original = JSON.stringify({
    signIn: { account: "a" },
    compute: { tenantId: "t" },
  });
  const written = writeLakehouseBinding(original, KEY, {
    lakehouseId: LH,
    workspaceId: WS,
    lakehouseName: "lh_analytics",
    workspaceName: "Analytics Dev",
  });
  const parsed = JSON.parse(written);
  assert.deepEqual(parsed.signIn, { account: "a" });
  assert.deepEqual(parsed.compute, { tenantId: "t" });
  assert.deepEqual(readLakehouseBindings(written).get(KEY), {
    lakehouseId: LH,
    workspaceId: WS,
    lakehouseName: "lh_analytics",
    workspaceName: "Analytics Dev",
  });
});

test("unbinding removes the entry, and the section once it is empty", () => {
  const two = writeLakehouseBinding(
    writeLakehouseBinding(undefined, KEY, { lakehouseId: LH, workspaceId: WS }),
    "other.Notebook",
    { lakehouseId: LH, workspaceId: WS },
  );
  const one = writeLakehouseBinding(two, KEY, undefined);
  assert.deepEqual([...readLakehouseBindings(one).keys()], ["other.Notebook"]);
  const none = writeLakehouseBinding(one, "other.Notebook", undefined);
  assert.equal("lakehouseBindings" in JSON.parse(none), false);
});

test("missing file or section means no bindings", () => {
  assert.equal(readLakehouseBindings(undefined).size, 0);
  assert.equal(readLakehouseBindings('{"compute":{}}').size, 0);
});

test("placeholder or malformed IDs are refused loudly, naming the entry", () => {
  for (const bad of [
    { lakehouseId: NIL, workspaceId: WS },
    { lakehouseId: LH, workspaceId: "nope" },
    { lakehouseId: LH },
  ]) {
    assert.throws(
      () =>
        readLakehouseBindings(
          JSON.stringify({ lakehouseBindings: { [KEY]: bad } }),
        ),
      (error: unknown) =>
        error instanceof TargetConfigError &&
        error.message.includes(KEY) &&
        /Next step:/.test(error.message),
    );
    assert.throws(
      () =>
        writeLakehouseBinding(
          undefined,
          KEY,
          bad as unknown as { lakehouseId: string; workspaceId: string },
        ),
      TargetConfigError,
    );
  }
  assert.throws(
    () => writeLakehouseBinding("{broken", KEY, undefined),
    TargetConfigError,
  );
});

test("the key is the repo-relative item folder with / separators", () => {
  assert.equal(
    notebookKey("/repo", "/repo/notebooks/Load.Notebook"),
    "notebooks/Load.Notebook",
  );
  assert.equal(
    notebookKey("/repo", "/repo/notebooks\\Load.Notebook"),
    "notebooks/Load.Notebook",
  );
  assert.equal(notebookKey("/repo", "/elsewhere/Load.Notebook"), undefined);
  assert.equal(notebookKey("/repo", "/repo"), undefined);
});
