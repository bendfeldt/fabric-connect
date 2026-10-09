#!/usr/bin/env node
"use strict";

/**
 * Files the changelog's "Unreleased" entries under a new release.
 *
 * The Release workflow runs this right after `npm version`, so the version
 * bump PR carries package.json, the lockfile and the changelog together and
 * the repo never has a version without its changelog section:
 *
 *   node scripts/syncChangelog.cjs <version> [YYYY-MM-DD]
 *
 *   ## Unreleased                  ## Unreleased
 *   - a change            -->
 *                                  ## 1.5.0 — 2026-10-09
 *                                  - a change
 *
 * Zero dependencies; the logic is a pure function so it is tested without
 * touching the file (test/syncChangelog.test.ts).
 */

const fs = require("node:fs");
const path = require("node:path");

const NOTHING_NOTED = "- No user-facing changes.";

/**
 * Returns the changelog text with the "## Unreleased" section filed under
 * `## <version> — <date>` and a fresh, empty "## Unreleased" above it.
 * Throws a descriptive Error when it cannot do that safely.
 */
function rollChangelog(text, version, date) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `Cannot roll the changelog: '${version}' is not a plain x.y.z version. ` +
        "Pass the version from package.json.",
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(
      `Cannot roll the changelog: '${date}' is not a YYYY-MM-DD date.`,
    );
  }

  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  if (crlf > 0 && crlf !== lf) {
    throw new Error(
      `Cannot roll the changelog for ${version}: CHANGELOG.md mixes CRLF and LF line endings. ` +
        "Normalize them to one style first, so the release commit changes only the roll.",
    );
  }
  const eol = crlf > 0 ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);

  const start = lines.findIndex((line) => /^## Unreleased\s*$/.test(line));
  if (start < 0) {
    throw new Error(
      `Cannot roll the changelog for ${version}: CHANGELOG.md has no '## Unreleased' section. ` +
        "Add one above the newest release (see docs/development.md) and run the Release workflow again.",
    );
  }
  if (lines.filter((line) => /^## Unreleased\s*$/.test(line)).length > 1) {
    throw new Error(
      `Cannot roll the changelog for ${version}: CHANGELOG.md has more than one '## Unreleased' section. ` +
        "Merge them into one and run the Release workflow again.",
    );
  }
  const alreadyFiled = lines.some((line) =>
    new RegExp(`^## ${version.replace(/\./g, "\\.")}(\\s|$)`).test(line),
  );
  if (alreadyFiled) {
    throw new Error(
      `Cannot roll the changelog for ${version}: CHANGELOG.md already has a '## ${version}' section. ` +
        "Check the version in package.json; a release version is filed only once.",
    );
  }

  let end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  if (end < 0) {
    end = lines.length;
  }
  const entries = lines.slice(start + 1, end);
  while (entries.length > 0 && entries[0].trim() === "") {
    entries.shift();
  }
  while (entries.length > 0 && entries[entries.length - 1].trim() === "") {
    entries.pop();
  }

  const rolled = [
    ...lines.slice(0, start),
    "## Unreleased",
    "",
    `## ${version} — ${date}`,
    "",
    ...(entries.length > 0 ? entries : [NOTHING_NOTED]),
    "",
    ...lines.slice(end),
  ];
  return rolled.join(eol).replace(/\s+$/, "") + eol;
}

function main(argv) {
  const [version, date = new Date().toISOString().slice(0, 10)] = argv;
  if (version === undefined) {
    console.error(
      "usage: node scripts/syncChangelog.cjs <version> [YYYY-MM-DD]",
    );
    return 2;
  }
  const file = path.join(__dirname, "..", "CHANGELOG.md");
  try {
    fs.writeFileSync(
      file,
      rollChangelog(fs.readFileSync(file, "utf8"), version, date),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  console.log(`CHANGELOG.md: filed Unreleased under ${version} (${date}).`);
  return 0;
}

module.exports = { rollChangelog };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
