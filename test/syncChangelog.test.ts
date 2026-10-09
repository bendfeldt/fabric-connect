import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const ROOT = path.join(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "syncChangelog.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { rollChangelog } = require(SCRIPT) as {
  rollChangelog: (text: string, version: string, date: string) => string;
};

const BEFORE = [
  "# Changelog",
  "",
  "Intro.",
  "",
  "## Unreleased",
  "",
  "- First change.",
  "- Second change,",
  "  continued.",
  "",
  "## 1.4.0",
  "",
  "- Old entry.",
  "",
].join("\n");

test("files Unreleased under the new version and opens a fresh Unreleased", () => {
  assert.equal(
    rollChangelog(BEFORE, "1.5.0", "2026-10-09"),
    [
      "# Changelog",
      "",
      "Intro.",
      "",
      "## Unreleased",
      "",
      "## 1.5.0 — 2026-10-09",
      "",
      "- First change.",
      "- Second change,",
      "  continued.",
      "",
      "## 1.4.0",
      "",
      "- Old entry.",
      "",
    ].join("\n"),
  );
});

test("an empty Unreleased section is filed with an explicit note, not left blank", () => {
  const empty = BEFORE.replace(
    "- First change.\n- Second change,\n  continued.\n",
    "",
  );
  const rolled = rollChangelog(empty, "1.4.1", "2026-10-09");
  assert.match(
    rolled,
    /## 1\.4\.1 — 2026-10-09\n\n- No user-facing changes\.\n\n## 1\.4\.0/,
  );
});

test("works when Unreleased is the last section and keeps CRLF files CRLF", () => {
  const last = "# Changelog\n\n## Unreleased\n\n- Only change.\n";
  assert.equal(
    rollChangelog(last, "2.0.0", "2026-01-02"),
    "# Changelog\n\n## Unreleased\n\n## 2.0.0 — 2026-01-02\n\n- Only change.\n",
  );
  const crlf = rollChangelog(
    BEFORE.replace(/\n/g, "\r\n"),
    "1.5.0",
    "2026-10-09",
  );
  assert.ok(crlf.includes("\r\n") && !/[^\r]\n/.test(crlf), "CRLF preserved");
});

test("rolling is not repeatable: the new Unreleased section is empty", () => {
  const once = rollChangelog(BEFORE, "1.5.0", "2026-10-09");
  assert.throws(
    () => rollChangelog(once, "1.5.0", "2026-10-09"),
    /already has a '## 1\.5\.0' section/,
  );
});

test("refuses unsafe inputs with a message that names the next step", () => {
  assert.throws(
    () => rollChangelog("# Changelog\n\n## 1.4.0\n", "1.5.0", "2026-10-09"),
    /no '## Unreleased' section[\s\S]*Add one/,
  );
  assert.throws(
    () => rollChangelog(BEFORE, "1.5", "2026-10-09"),
    /not a plain x\.y\.z version/,
  );
  assert.throws(
    () => rollChangelog(BEFORE, "1.5.0", "yesterday"),
    /not a YYYY-MM-DD date/,
  );
  assert.throws(
    () => rollChangelog(BEFORE, "1.4.0", "2026-10-09"),
    /already has a '## 1\.4\.0' section/,
  );
});

test("refuses a second Unreleased section and mixed line endings instead of guessing", () => {
  assert.throws(
    () =>
      rollChangelog(
        BEFORE.replace("## 1.4.0", "## Unreleased\n\n- Stray.\n\n## 1.4.0"),
        "1.5.0",
        "2026-10-09",
      ),
    /more than one '## Unreleased' section/,
  );
  assert.throws(
    () =>
      rollChangelog(
        BEFORE.replace("Intro.\n", "Intro.\r\n"),
        "1.5.0",
        "2026-10-09",
      ),
    /mixes CRLF and LF/,
  );
});

test("the real changelog rolls for a patch, minor and major release", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, "package.json"), "utf8"),
  ) as { version: string };
  const [major, minor, patch] = manifest.version.split(".").map(Number);
  const original = readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
  for (const next of [
    `${major}.${minor}.${patch + 1}`,
    `${major}.${minor + 1}.0`,
    `${major + 1}.0.0`,
  ]) {
    const rolled = rollChangelog(original, next, "2026-10-09");
    assert.equal(
      rolled.match(/^## Unreleased\s*$/gm)?.length,
      1,
      `${next}: exactly one Unreleased section`,
    );
    const versions = [...rolled.matchAll(/^## (\d+\.\d+\.\d+)\b/gm)].map(
      (match) => match[1],
    );
    assert.deepEqual(
      versions.slice(0, 2),
      [next, manifest.version],
      `${next}: filed above the previous release`,
    );
    assert.ok(
      rolled.endsWith("\n") && !rolled.endsWith("\n\n"),
      "one trailing newline",
    );
  }
});

test("the command line rewrites CHANGELOG.md in a copy of the repo layout", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fabric-connect-changelog-"));
  try {
    mkdirSync(path.join(dir, "scripts"));
    copyFileSync(SCRIPT, path.join(dir, "scripts", "syncChangelog.cjs"));
    writeFileSync(path.join(dir, "CHANGELOG.md"), BEFORE);
    const output = execFileSync(
      process.execPath,
      [path.join(dir, "scripts", "syncChangelog.cjs"), "1.5.0", "2026-10-09"],
      { encoding: "utf8" },
    );
    assert.match(output, /filed Unreleased under 1\.5\.0/);
    assert.match(
      readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"),
      /## Unreleased\n\n## 1\.5\.0 — 2026-10-09\n\n- First change\./,
    );
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            path.join(dir, "scripts", "syncChangelog.cjs"),
            "1.5.0",
            "2026-10-09",
          ],
          {
            encoding: "utf8",
            stdio: "pipe",
          },
        ),
      (error: unknown) =>
        (error as { status?: number }).status === 1 &&
        /already has a '## 1\.5\.0' section/.test(
          String((error as { stderr?: unknown }).stderr),
        ),
      "a second run fails loudly instead of duplicating the release",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
