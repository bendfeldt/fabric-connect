import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeModules,
  failedImportPackage,
  localModuleHint,
  resolveModuleMode,
  sourceRootsFromPyproject,
  wheelInstallCode,
} from "../src/core/moduleStaging";

test("module mode: an explicit setting wins, auto follows sourceRoots", () => {
  assert.equal(resolveModuleMode("local", []), "local");
  assert.equal(resolveModuleMode("remote", ["src"]), "remote");
  assert.equal(resolveModuleMode("wheel", ["src"]), "wheel");
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
  assert.equal(
    describeModules("wheel", [], "analytics.whl").label,
    "Wheel · analytics.whl",
  );
  assert.equal(describeModules("wheel", [], "analytics.whl").icon, "package");
});

test("wheel install verifies a pure wheelhouse and distributes a ZIP", () => {
  const wheel = "sample-1.0-py3-none-any.whl";
  const code = wheelInstallCode(wheel, "sha256-content", [
    { fileName: wheel, size: 23, sha256: "wheel-sha256" },
  ]);
  assert.doesNotMatch(code, /%pip|abfss|notebookutils|sitecustomize/);
  assert.match(code, /Root-Is-Purelib/);
  assert.match(code, /platform tag 'any'/);
  assert.match(
    code,
    /size != item\["size"\].*digest\.hexdigest\(\) != item\["sha256"\]/s,
  );
  assert.match(
    code,
    /"--no-index", "--find-links", str\(wheelhouse\), "--target", str\(target\), "--ignore-installed"/,
  );
  assert.match(code, /\.so.*\.pyd.*\.dll.*\.dylib.*\.pth/s);
  assert.match(code, /spark\.sparkContext\.addPyFile/);
  assert.match(
    code,
    /parallelize\(\[0\], 1\)\.map\(_fabric_connect_preflight\)\.collect\(\)/,
  );
  assert.match(code, /sample-1\.0-py3-none-any\.whl/);
  assert.match(code, /sha256-content/);
});
