import assert from "node:assert/strict";
import { test } from "node:test";
import {
  foldersWithItems,
  hiddenNames,
  isItemFolder,
  itemRunKind,
  notebookContentFile,
  relativeKey,
  visibleEntries,
} from "../src/core/repoTree";

const dir = (name: string) => ({ name, isDirectory: true });
const file = (name: string) => ({ name, isDirectory: false });

test("folders come before files, each by name regardless of case", () => {
  const entries = visibleEntries(
    [file("b.py"), dir("src"), file("A.sql"), dir("Bronze.Notebook")],
    new Set(),
    false,
  );
  assert.deepEqual(
    entries.map((e) => e.name),
    ["Bronze.Notebook", "src", "A.sql", "b.py"],
  );
});

test("an item folder hides its .platform; other folders keep theirs", () => {
  const entries = [file(".platform"), file("notebook-content.py")];
  assert.deepEqual(
    visibleEntries(entries, new Set(), true).map((e) => e.name),
    ["notebook-content.py"],
  );
  assert.deepEqual(
    visibleEntries(entries, new Set(), false).map((e) => e.name),
    [".platform", "notebook-content.py"],
  );
});

test("a folder is an item only when it holds a .platform file", () => {
  assert.equal(isItemFolder([file(".platform"), file("x")]), true);
  assert.equal(isItemFolder([dir(".platform")]), false);
  assert.equal(isItemFolder([file("notebook-content.py")]), false);
});

test("files.exclude hides plain and **/ names; .git and node_modules always", () => {
  const hidden = hiddenNames({
    "**/.DS_Store": true,
    "**/__pycache__": true,
    ".venv": true,
    "**/*.pyc": true,
    "build/out": true,
    "**/dist": false,
    "**/tmp": { when: "$(basename).ts" },
  });
  assert.deepEqual(
    [...hidden].sort(),
    [".DS_Store", ".git", ".venv", "__pycache__", "node_modules"].sort(),
  );
  assert.deepEqual(
    visibleEntries(
      [dir(".git"), dir("node_modules"), dir("__pycache__"), file("a.py")],
      hidden,
      false,
    ).map((e) => e.name),
    ["a.py"],
  );
  assert.deepEqual([...hiddenNames(undefined)].sort(), [
    ".git",
    "node_modules",
  ]);
});

test("a Notebook item opens its .ipynb first, else the source format file", () => {
  assert.equal(
    notebookContentFile([
      file(".platform"),
      file("notebook-content.py"),
      file("notebook-content.ipynb"),
    ]),
    "notebook-content.ipynb",
  );
  assert.equal(
    notebookContentFile([file(".platform"), file("notebook-content.sql")]),
    "notebook-content.sql",
  );
  assert.equal(
    notebookContentFile([file(".platform"), file("readme.md")]),
    undefined,
  );
});

test("notebooks and Spark Job Definitions run as items; other items do not", () => {
  assert.equal(itemRunKind("Notebook"), "notebook");
  assert.equal(itemRunKind("SparkJobDefinition"), "sparkJob");
  assert.equal(itemRunKind("Lakehouse"), undefined);
});

test("Repo keeps item folders and the folders leading to them, nothing else", () => {
  const folders = foldersWithItems(
    [
      "/repo/notebooks/bronze/Load.Notebook/.platform",
      "/repo/notebooks/silver/Clean.Notebook/.platform",
      "/repo/Main.Lakehouse/.platform",
      "/elsewhere/Other.Notebook/.platform",
    ],
    "/repo",
  );
  assert.deepEqual([...folders].sort(), [
    "",
    "Main.Lakehouse",
    "notebooks",
    "notebooks/bronze",
    "notebooks/bronze/Load.Notebook",
    "notebooks/silver",
    "notebooks/silver/Clean.Notebook",
  ]);
  assert.equal(folders.has("docs"), false, "folders without items drop");
  assert.equal(folders.has("../elsewhere"), false, "outside the root drops");
});

test("an item at the repo root keeps only the root; no items keeps nothing", () => {
  assert.deepEqual([...foldersWithItems(["/repo/.platform"], "/repo")], [""]);
  assert.equal(foldersWithItems([], "/repo").size, 0);
});

test("relative keys use / and refuse paths outside the root", () => {
  assert.equal(relativeKey("/repo", "/repo"), "");
  assert.equal(relativeKey("/repo", "/repo/a/b"), "a/b");
  assert.equal(relativeKey("/repo", "/repo/..odd"), "..odd");
  assert.equal(relativeKey("/repo", "/other"), undefined);
  assert.equal(relativeKey("/repo", "/"), undefined);
});
