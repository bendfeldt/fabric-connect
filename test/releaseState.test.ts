import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

const { classifyRelease } = require(
  path.join(__dirname, "..", "..", "scripts", "releaseState.cjs"),
) as {
  classifyRelease(
    status: number,
    response: string,
    assetName: string,
  ): "absent" | "partial" | "complete";
};

const asset = "fabric-connect-1.5.0.vsix";

test("classifies only a nonempty uploaded matching asset as complete", () => {
  assert.equal(
    classifyRelease(
      0,
      JSON.stringify({
        assets: [{ name: asset, state: "uploaded", size: 42 }],
      }),
      asset,
    ),
    "complete",
  );
  for (const assets of [
    [],
    [{ name: asset, state: "starter", size: 0 }],
    [{ name: asset, state: "uploaded", size: 0 }],
    [{ name: "other.vsix", state: "uploaded", size: 42 }],
  ]) {
    assert.equal(
      classifyRelease(0, JSON.stringify({ assets }), asset),
      "partial",
    );
  }
});

test("classifies 404 as absent and rejects other API or protocol failures", () => {
  assert.equal(classifyRelease(1, "gh: Not Found (HTTP 404)", asset), "absent");
  assert.throws(
    () => classifyRelease(1, "gh: service unavailable (HTTP 503)", asset),
    /HTTP 503/,
  );
  assert.throws(() => classifyRelease(0, "not json", asset), /valid JSON/);
  assert.throws(
    () => classifyRelease(0, JSON.stringify({ assets: "invalid" }), asset),
    /assets array/,
  );
});
