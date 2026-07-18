import assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "node:path";
import { TargetConfigError } from "../src/core/errors";
import {
  LOCAL_OVERRIDE_FILE,
  TARGETS_FILE,
  TargetResolver,
  type TargetFileSystem,
} from "../src/core/targetResolver";

const ROOT = path.resolve("/repo");
const WORKSPACE_ID = "12345678-1234-1234-1234-123456789abc";
const TENANT_ID = "87654321-4321-4321-4321-cba987654321";

function makeFs(files: Record<string, string>): TargetFileSystem {
  return {
    readFile: async (filePath) => files[filePath],
  };
}

function standardFiles(): Record<string, string> {
  return {
    [path.join(ROOT, TARGETS_FILE)]: JSON.stringify({
      folders: { notebooks: "dev", ".": "fallback" },
      targets: {
        dev: { itemType: "notebook", tenantId: TENANT_ID },
        fallback: { itemType: "notebook", tenantId: TENANT_ID },
      },
    }),
    [path.join(ROOT, LOCAL_OVERRIDE_FILE)]: JSON.stringify({
      targets: { dev: { workspaceId: WORKSPACE_ID } },
    }),
  };
}

function makeResolver(files: Record<string, string>): TargetResolver {
  const resolver = new TargetResolver(makeFs(files), ROOT);
  resolver.registerItemType("notebook", { itemType: "notebook" });
  return resolver;
}

test("resolves folder → target → workspace ID, most specific mapping wins", async () => {
  const resolver = makeResolver(standardFiles());
  const resolved = await resolver.resolveTarget(
    path.join(ROOT, "notebooks", "Sales.Notebook"),
  );
  assert.equal(resolved.targetName, "dev");
  assert.equal(resolved.workspaceId, WORKSPACE_ID);
  assert.equal(resolved.itemType, "notebook");
  assert.equal(resolved.tenantId, TENANT_ID);
});

test("folder outside the workspace root is rejected (no traversal)", async () => {
  const resolver = makeResolver(standardFiles());
  await assert.rejects(
    resolver.resolveTarget(path.resolve("/elsewhere")),
    (error: unknown) => {
      assert.ok(error instanceof TargetConfigError);
      assert.match(error.message, /outside the workspace folder/);
      return true;
    },
  );
});

test("missing local override file names the exact remediation", async () => {
  const files = standardFiles();
  delete files[path.join(ROOT, LOCAL_OVERRIDE_FILE)];
  const resolver = makeResolver(files);
  await assert.rejects(
    resolver.resolveTarget(path.join(ROOT, "notebooks")),
    (error: unknown) => {
      assert.ok(error instanceof TargetConfigError);
      assert.match(error.message, /local\.json/);
      assert.match(error.message, /"dev"/);
      assert.ok(error.remediation?.includes("workspaceId"));
      return true;
    },
  );
});

test("missing workspace ID for the target is loud and names the target", async () => {
  const files = standardFiles();
  files[path.join(ROOT, LOCAL_OVERRIDE_FILE)] = JSON.stringify({
    targets: { other: { workspaceId: WORKSPACE_ID } },
  });
  const resolver = makeResolver(files);
  await assert.rejects(
    resolver.resolveTarget(path.join(ROOT, "notebooks")),
    /no workspace ID for target 'dev'/,
  );
});

test("malformed local override JSON is a specific error, not a fallback", async () => {
  const files = standardFiles();
  files[path.join(ROOT, LOCAL_OVERRIDE_FILE)] = "{ oops";
  const resolver = makeResolver(files);
  await assert.rejects(
    resolver.resolveTarget(path.join(ROOT, "notebooks")),
    /not valid JSON/,
  );
});

test("non-GUID workspace ID is rejected before any API use", async () => {
  const files = standardFiles();
  files[path.join(ROOT, LOCAL_OVERRIDE_FILE)] = JSON.stringify({
    targets: { dev: { workspaceId: "production" } },
  });
  const resolver = makeResolver(files);
  await assert.rejects(
    resolver.resolveTarget(path.join(ROOT, "notebooks")),
    /not a valid GUID/,
  );
});

test("unregistered item type is rejected — Part 2 must register, not bypass", async () => {
  const files = standardFiles();
  files[path.join(ROOT, TARGETS_FILE)] = JSON.stringify({
    folders: { ".": "pipe" },
    targets: { pipe: { itemType: "pipeline", tenantId: TENANT_ID } },
  });
  const resolver = makeResolver(files);
  await assert.rejects(
    resolver.resolveTarget(path.join(ROOT, "anything")),
    /item type 'pipeline'.*not registered/,
  );
});

test("registering an item type via the registry makes it resolvable", async () => {
  const files = standardFiles();
  files[path.join(ROOT, TARGETS_FILE)] = JSON.stringify({
    folders: { ".": "pipe" },
    targets: { pipe: { itemType: "pipeline", tenantId: TENANT_ID } },
  });
  files[path.join(ROOT, LOCAL_OVERRIDE_FILE)] = JSON.stringify({
    targets: { pipe: { workspaceId: WORKSPACE_ID } },
  });
  const resolver = makeResolver(files);
  resolver.registerItemType("pipeline", { itemType: "pipeline" });
  const resolved = await resolver.resolveTarget(path.join(ROOT, "anything"));
  assert.equal(resolved.itemType, "pipeline");
});

test("missing targets file states how to create it", async () => {
  const resolver = makeResolver({});
  await assert.rejects(
    resolver.resolveTarget(path.join(ROOT, "notebooks")),
    (error: unknown) => {
      assert.ok(error instanceof TargetConfigError);
      assert.ok(error.remediation?.includes(TARGETS_FILE));
      return true;
    },
  );
});
