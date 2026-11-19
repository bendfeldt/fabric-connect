import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const workflow = readFileSync(
  path.join(__dirname, "..", "..", ".github", "workflows", "release.yml"),
  "utf8",
);

test("Marketplace publishing is required before a recoverable GitHub Release", () => {
  assert.doesNotMatch(workflow, /MARKETPLACE_TRUSTED_PUBLISHING/);

  const publish = workflow.indexOf(
    "name: Publish to VS Code Marketplace (trusted publishing)",
  );
  const release = workflow.indexOf("name: Create or repair GitHub Release");
  assert.ok(publish >= 0, "Marketplace publish step exists");
  assert.ok(release > publish, "GitHub Release follows Marketplace publish");

  assert.match(workflow, /node scripts\/releaseState\.cjs/);
  assert.match(workflow, /gh release upload "v\$version"/);
  assert.match(workflow, /--clobber/);
});
