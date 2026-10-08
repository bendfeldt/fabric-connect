/**
 * Raw text diffs of Fabric notebooks. A notebook file opens in the notebook
 * editor, so Source Control's own diff of it is a cell diff that hides
 * metadata changes. "Open Changes as Text" shows the file diff instead: both
 * sides are served under a renamed path that no notebook type claims, so
 * VS Code opens them as text, with the language of the file's extension.
 */

import * as path from "node:path";

/** The URI scheme of the read-only text views. */
export const TEXT_VIEW_SCHEME = "fabric-connect-text";

/** Which version of the file a text view shows. */
export type TextViewRef = "HEAD" | "working";

/**
 * `…/X.Notebook/notebook-content.py` → `…/X.Notebook/notebook-content (HEAD).py`:
 * the basename no longer matches `notebook-content.*`, the extension (and
 * so the syntax highlighting) stays.
 */
export function textViewPath(filePath: string, ref: TextViewRef): string {
  const ext = path.posix.extname(filePath);
  const base = path.posix.basename(filePath, ext);
  const label = ref === "HEAD" ? "HEAD" : "working tree";
  return path.posix.join(
    path.posix.dirname(filePath),
    `${base} (${label})${ext}`,
  );
}

/** The query of a text view URI: which file, and which version of it. */
export interface TextViewQuery {
  readonly path: string;
  readonly ref: TextViewRef;
}

export function encodeTextViewQuery(query: TextViewQuery): string {
  return JSON.stringify({ path: query.path, ref: query.ref });
}

/** Undefined when the query is not one this extension wrote. */
export function decodeTextViewQuery(query: string): TextViewQuery | undefined {
  try {
    const parsed: unknown = JSON.parse(query);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)["path"] === "string" &&
      ((parsed as Record<string, unknown>)["ref"] === "HEAD" ||
        (parsed as Record<string, unknown>)["ref"] === "working")
    ) {
      const { path: file, ref } = parsed as { path: string; ref: TextViewRef };
      return { path: file, ref };
    }
  } catch {
    // Not JSON: not ours.
  }
  return undefined;
}
