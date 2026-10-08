import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import {
  decodeTextViewQuery,
  encodeTextViewQuery,
  textViewPath,
} from "../src/core/notebookTextDiff";

/** The manifest's notebook selectors, as regular expressions. */
const manifest = JSON.parse(
  readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
) as {
  contributes: {
    notebooks: Array<{ selector: Array<{ filenamePattern: string }> }>;
  };
};
const selectors = manifest.contributes.notebooks
  .flatMap((n) => n.selector.map((s) => s.filenamePattern))
  .map(globToRegExp);

/** `**` + `/` any folders, `*` within one segment: enough for these selectors. */
function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("**/")
    .map((part) =>
      part
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]"),
    )
    .join("(?:.*/)?");
  return new RegExp(`^${body}$`);
}

/** True when a notebook type would claim this path. */
const claimed = (file: string) =>
  selectors.some((selector) => selector.test(file.replace(/^\//, "")));

test("text views keep the extension but leave the notebook selector", () => {
  assert.ok(selectors.length >= 5, "the manifest's selectors were read");
  for (const ext of ["py", "sql", "scala", "r", "ipynb"]) {
    const file = `/repo/fabric/Load.Notebook/notebook-content.${ext}`;
    assert.ok(claimed(file), `${file} should open as a notebook`);
    for (const ref of ["HEAD", "working"] as const) {
      const view = textViewPath(file, ref);
      assert.ok(!claimed(view), `${view} must open as text`);
      assert.ok(view.endsWith(`.${ext}`), view);
      assert.ok(view.startsWith("/repo/fabric/Load.Notebook/"), view);
    }
  }
  assert.equal(
    textViewPath("/r/A.Notebook/notebook-content.py", "HEAD"),
    "/r/A.Notebook/notebook-content (HEAD).py",
  );
  assert.equal(
    textViewPath("/r/A.Notebook/notebook-content.py", "working"),
    "/r/A.Notebook/notebook-content (working tree).py",
  );
});

test("text view queries round-trip; others are not ours", () => {
  const query = {
    path: "/r/A.Notebook/notebook-content.py",
    ref: "HEAD",
  } as const;
  assert.deepEqual(decodeTextViewQuery(encodeTextViewQuery(query)), query);
  assert.equal(decodeTextViewQuery("not json"), undefined);
  assert.equal(decodeTextViewQuery('{"path":"/x","ref":"main"}'), undefined);
  assert.equal(decodeTextViewQuery('{"ref":"HEAD"}'), undefined);
});
