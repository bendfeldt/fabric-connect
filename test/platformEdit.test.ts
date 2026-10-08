import assert from "node:assert/strict";
import { test } from "node:test";
import { ItemMetadataError } from "../src/core/errors";
import { parsePlatform, updatePlatform } from "../src/core/localItemIndex";

// As Fabric's git integration writes it.
const PLATFORM = `{
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",
  "metadata": {
    "type": "Notebook",
    "displayName": "Bronze Load",
    "description": "Loads bronze"
  },
  "config": {
    "version": "2.0",
    "logicalId": "aaaaaaaa-0000-0000-0000-000000000001"
  },
  "x-custom": [1, {"kept": true}]
}
`;

test("unchanged metadata returns the file byte-for-byte", () => {
  assert.equal(
    updatePlatform(PLATFORM, {
      displayName: "Bronze Load",
      description: "Loads bronze",
    }),
    PLATFORM,
  );
  assert.equal(updatePlatform(PLATFORM, {}), PLATFORM);
});

test("a new display name and description keep every other field and key order", () => {
  const updated = updatePlatform(PLATFORM, {
    displayName: "  Bronze Ingest ",
    description: "Ingests bronze",
  });
  const item = parsePlatform(updated, "/repo/Bronze Load.Notebook");
  assert.equal(item?.displayName, "Bronze Ingest");
  assert.equal(item?.description, "Ingests bronze");
  assert.equal(item?.logicalId, "aaaaaaaa-0000-0000-0000-000000000001");
  const parsed = JSON.parse(updated);
  assert.deepEqual(Object.keys(parsed), [
    "$schema",
    "metadata",
    "config",
    "x-custom",
  ]);
  assert.deepEqual(Object.keys(parsed.metadata), [
    "type",
    "displayName",
    "description",
  ]);
  assert.deepEqual(parsed["x-custom"], [1, { kept: true }]);
  assert.match(updated, /\n {2}"metadata"/, "two-space indent kept");
  assert.ok(updated.endsWith("}\n"), "trailing newline kept");
});

test("CRLF line endings, tab indentation and a BOM survive an edit", () => {
  const crlf = "﻿" + PLATFORM.replace(/\n/g, "\r\n").replace(/ {2}/g, "\t");
  const updated = updatePlatform(crlf, { displayName: "Renamed" });
  assert.ok(updated.startsWith('﻿{\r\n\t"$schema"'));
  assert.doesNotMatch(updated.replace(/\r\n/g, ""), /\n/, "no bare LF");
  assert.ok(updated.endsWith("}\r\n"));
  assert.equal(JSON.parse(updated.slice(1)).metadata.displayName, "Renamed");
});

test("an empty description removes the key; a missing one is added", () => {
  const removed = updatePlatform(PLATFORM, { description: "   " });
  assert.equal("description" in JSON.parse(removed).metadata, false);
  assert.equal(
    updatePlatform(removed, { description: "" }),
    removed,
    "removing an absent description changes nothing",
  );
  assert.equal(
    JSON.parse(updatePlatform(removed, { description: "Back" })).metadata
      .description,
    "Back",
  );
});

test("an empty display name or an unusable file is a typed error", () => {
  assert.throws(
    () => updatePlatform(PLATFORM, { displayName: " " }),
    (error: unknown) =>
      error instanceof ItemMetadataError &&
      /display name is empty/.test(error.message) &&
      /Next step:/.test(error.message),
  );
  assert.throws(
    () => updatePlatform("{nope", { displayName: "x" }),
    ItemMetadataError,
  );
  assert.throws(
    () => updatePlatform('{"config":{}}', { displayName: "x" }),
    ItemMetadataError,
  );
});
