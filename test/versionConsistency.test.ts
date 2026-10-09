/**
 * The release workflow bumps `package.json` and the lockfile; everything
 * else that names the extension's version must follow from them or must not
 * name one at all. These checks fail CI when a version is bumped without the
 * rest of the repo, or when a guide hard-codes a version that will go stale.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const ROOT = path.join(__dirname, "..", "..");
const read = (relative: string) =>
  readFileSync(path.join(ROOT, relative), "utf8");

const SEMVER = /^\d+\.\d+\.\d+$/;
const manifest = JSON.parse(read("package.json")) as {
  version: string;
  scripts?: Record<string, string>;
};
const lock = JSON.parse(read("package-lock.json")) as {
  version: string;
  packages: Record<string, { version?: string }>;
};

function compare(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }
  return 0;
}

/** Version headings (`## 1.4.0 …`) in CHANGELOG.md, newest first as written. */
function changelogVersions(): string[] {
  return [...read("CHANGELOG.md").matchAll(/^## (\d+\.\d+\.\d+)\b/gm)].map(
    (match) => match[1],
  );
}

test("the manifest version is a plain x.y.z and matches the lockfile", () => {
  assert.match(manifest.version, SEMVER);
  assert.equal(lock.version, manifest.version, "package-lock.json version");
  assert.equal(
    lock.packages[""].version,
    manifest.version,
    'package-lock.json packages[""] version',
  );
});

test("CHANGELOG.md has an Unreleased section and its newest release is the manifest version", () => {
  const changelog = read("CHANGELOG.md");
  assert.equal(
    changelog.match(/^## Unreleased\s*$/gm)?.length,
    1,
    'CHANGELOG.md needs exactly one "## Unreleased" section for changes since the last release',
  );
  const versions = changelogVersions();
  assert.ok(versions.length > 0, "CHANGELOG.md lists releases");
  const newest = [...versions].sort(compare).at(-1);
  assert.equal(
    newest,
    manifest.version,
    `CHANGELOG.md's newest release (${newest}) must be the manifest version (${manifest.version}); ` +
      "release by running the Release workflow, which files Unreleased under the new version",
  );
  assert.equal(
    versions[0],
    newest,
    "CHANGELOG.md lists the newest release first",
  );
});

/** The packaging tool's version, as pinned by the `package` script. */
const PINNED_VSCE = /@vscode\/vsce@(\d+\.\d+\.\d+)/.exec(
  manifest.scripts?.["package"] ?? "",
)?.[1];

/**
 * True for the pinned vsce version (the whole matched text, suffix
 * included) written as tool wording (`vsce 4.0.0`,
 * `@vscode/vsce@4.0.0`, a vscode-vsce repository URL). Both conditions are
 * needed: "the vsce 1.4.0 extension" is not the tool, and a tool version
 * other than the pin is not exempt either.
 */
function isPinnedToolVersion(
  before: string,
  version: string,
  pinned: string | undefined,
): boolean {
  return (
    pinned !== undefined &&
    version === pinned &&
    /(?:vsce[@ ]|vscode-vsce\/blob\/v)$/.test(before)
  );
}

test("only the pinned vsce version, written as tool wording, is exempt from the guide check", () => {
  assert.match(PINNED_VSCE ?? "", SEMVER, "package script pins vsce");
  const pin = "4.0.0";
  assert.ok(isPinnedToolVersion("pins vsce ", "4.0.0", pin));
  assert.ok(isPinnedToolVersion("npx @vscode/vsce@", "4.0.0", pin));
  assert.ok(
    isPinnedToolVersion("github.com/x/vscode-vsce/blob/v", "4.0.0", pin),
  );
  assert.ok(!isPinnedToolVersion("the vsce ", "1.4.0", pin), "other version");
  assert.ok(
    !isPinnedToolVersion("pins vsce ", "4.0.0-rc.1", pin),
    "a prerelease of the pin is not the pin",
  );
  assert.ok(!isPinnedToolVersion("Install ", "4.0.0", pin), "no tool wording");
  assert.ok(!isPinnedToolVersion("pins vsce ", "4.0.0", undefined), "no pin");
});

/**
 * Every Markdown file in the repository (guides, plan, walkthrough pages,
 * contributor and agent instructions) except the changelog, which is history
 * and the one place release versions belong.
 */
function guidanceFiles(): string[] {
  const skipped = new Set([".git", "node_modules", "out"]);
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(path.join(ROOT, directory)).sort()) {
      const relative = path.posix.join(directory, name);
      if (statSync(path.join(ROOT, relative)).isDirectory()) {
        if (!skipped.has(name)) {
          walk(relative);
        }
      } else if (name.endsWith(".md") && relative !== "CHANGELOG.md") {
        files.push(relative);
      }
    }
  };
  walk(".");
  return files.map((file) => file.replace(/^\.\//, ""));
}

/**
 * Deliberate facts about a past release (for example the last release before
 * a feature existed). Each entry allows one version on the one line that
 * contains `line`; anything else naming a released version goes stale at the
 * next release.
 */
const HISTORICAL: ReadonlyArray<{
  file: string;
  version: string;
  line: string;
}> = [
  {
    file: "docs/testing.md",
    version: "1.1.7",
    line: "needs a version newer than 1.1.7",
  },
];

test("guides never hard-code a released version or a prerelease/development build version", () => {
  const released = new Set([manifest.version, ...changelogVersions()]);
  const problems: string[] = [];
  for (const file of guidanceFiles()) {
    read(file)
      .split("\n")
      .forEach((line, index) => {
        for (const match of line.matchAll(
          /(?<![\d.])(\d+\.\d+\.\d+)(-[0-9A-Za-z.]+)?(?![\d.]*\d)/g,
        )) {
          const [, version, suffix] = match;
          const isPrerelease = suffix !== undefined;
          const isRelease = suffix === undefined && released.has(version);
          // The pinned packaging tool (vsce) has its own version line.
          const isToolVersion = isPinnedToolVersion(
            line.slice(0, match.index),
            match[0],
            PINNED_VSCE,
          );
          // Allowed only where this very occurrence sits inside the quoted text.
          const allowed = HISTORICAL.some((h) => {
            const at = line.indexOf(h.line);
            return (
              h.file === file &&
              h.version === version &&
              at >= 0 &&
              match.index >= at &&
              match.index < at + h.line.length
            );
          });
          if ((isPrerelease || isRelease) && !isToolVersion && !allowed) {
            problems.push(`${file}:${index + 1}: ${match[0]}`);
          }
        }
      });
  }
  assert.deepEqual(
    problems,
    [],
    "Name the version with a placeholder (<version>) or a command that reads package.json, " +
      "or add a deliberate historical fact to HISTORICAL in this test. " +
      "Limit: a not-yet-released x.y.z cannot be told from a tool version (schemas, other tools), so only released and prerelease/dev versions are checked; the vsce version pinned in the package script is recognised by its 'vsce 4.0.0' / 'vsce@4.0.0' wording",
  );
});
