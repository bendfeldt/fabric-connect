import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeModules,
  failedImportPackage,
  localModuleHint,
  resolveModuleMode,
  sourceRootsFromPyproject,
} from "../src/core/moduleStaging";

test("module mode: an explicit setting wins, auto follows sourceRoots", () => {
  assert.equal(resolveModuleMode("local", []), "local");
  assert.equal(resolveModuleMode("remote", ["src"]), "remote");
  assert.equal(resolveModuleMode("auto", ["src"]), "local");
  assert.equal(resolveModuleMode("auto", []), "remote");
  assert.equal(resolveModuleMode(undefined, []), "remote");
});

test("pyproject: setuptools packages.find where", () => {
  const text = [
    "[project]",
    'name = "fabric-aqv"',
    "",
    "[tool.setuptools.packages.find]",
    'where = ["src"]  # the package folder',
  ].join("\n");
  assert.deepEqual(sourceRootsFromPyproject(text), ["src"]);
});

test("pyproject: multi-line arrays and CRLF", () => {
  const text =
    '[tool.setuptools.packages.find]\r\nwhere = [\r\n  "src",\r\n  "libs",\r\n]\r\n';
  assert.deepEqual(sourceRootsFromPyproject(text), ["src", "libs"]);
});

test("pyproject: setuptools package-dir, inline and as a table", () => {
  assert.deepEqual(
    sourceRootsFromPyproject('[tool.setuptools]\npackage-dir = {"" = "src"}\n'),
    ["src"],
  );
  assert.deepEqual(
    sourceRootsFromPyproject('[tool.setuptools.package-dir]\n"" = "lib"\n'),
    ["lib"],
  );
});

test("pyproject: Hatch wheel packages and Poetry packages.from", () => {
  assert.deepEqual(
    sourceRootsFromPyproject(
      '[tool.hatch.build.targets.wheel]\npackages = ["src/analytics"]\n',
    ),
    ["src"],
  );
  assert.deepEqual(
    sourceRootsFromPyproject(
      '[tool.poetry]\npackages = [{ include = "analytics", from = "src" }]\n',
    ),
    ["src"],
  );
});

test("pyproject: keys in other sections or comments are ignored", () => {
  const text = [
    "[project]",
    'where = ["nope"]',
    "[tool.setuptools.packages.find]",
    '# where = ["commented"]',
  ].join("\n");
  assert.equal(sourceRootsFromPyproject(text), undefined);
  assert.equal(sourceRootsFromPyproject(""), undefined);
});

test("pyproject: escaped quotes in basic strings", () => {
  assert.deepEqual(
    sourceRootsFromPyproject(
      '[tool.setuptools.packages.find]\nwhere = ["src \\" x", \'lit\']  # c\n',
    ),
    ['src " x', "lit"],
  );
});

test("import errors name their top-level package", () => {
  assert.equal(
    failedImportPackage(
      "ImportError",
      'cannot import name "entity" from "analytics"',
    ),
    "analytics",
  );
  assert.equal(
    failedImportPackage(
      "ImportError",
      "cannot import name 'entity' from 'analytics' (/home/trusted-service-user/cluster-env/trident_env/lib/python3.11/site-packages/analytics/__init__.py)",
    ),
    "analytics",
  );
  assert.equal(
    failedImportPackage(
      "ModuleNotFoundError",
      "No module named 'analytics.entity'",
    ),
    "analytics",
  );
  assert.equal(
    failedImportPackage(
      "ImportError",
      "cannot import name 'x' from partially initialized module 'pkg.sub' (most likely due to a circular import)",
    ),
    "pkg",
  );
  assert.equal(
    failedImportPackage("ValueError", "from 'analytics'"),
    undefined,
  );
  assert.equal(failedImportPackage("ImportError", undefined), undefined);
});

test("the hint names the package, where it is, and the next step", () => {
  const hint = localModuleHint("analytics", "src/analytics");
  assert.match(hint, /'analytics' is also in your repo \(src\/analytics\)/);
  assert.match(hint, /Fabric: Python Modules/);
  assert.match(hint, /Local/);
});

test("the modules description is one text for the status bar and the side bar", () => {
  assert.deepEqual(
    [
      describeModules("local", ["analytics", "tools"]).label,
      describeModules("local", []).label,
      describeModules("remote", ["analytics"]).label,
      describeModules("remote", []).label,
    ],
    [
      "Local · analytics, tools",
      "Local",
      "Remote",
      "Remote · no local packages",
    ],
  );
  assert.equal(describeModules("local", []).icon, "file-code");
  assert.equal(describeModules("remote", []).icon, "cloud");
});
