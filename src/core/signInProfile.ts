/**
 * Sign-in profile: who this repo signs in as, kept per user and per repo
 * the way Tabular Editor keeps a model's user options in a `.tmuo` file.
 * It names the Microsoft account and the tenant, so reopening the repo
 * signs in again silently, and two repos can use different accounts or
 * tenants side by side.
 *
 * The profile lives under `"signIn"` in the gitignored `.fabric/local.json`
 * next to the compute connection. It holds no secret: tokens stay in VS
 * Code's secret storage, managed by its Microsoft account provider.
 *
 * Also here: reading the tenant ID out of an access token, so a plain
 * "sign in with your account" learns its tenant without asking for one.
 */

import { TargetConfigError } from "./errors";
import { LOCAL_OVERRIDE_FILE } from "./targetResolver";

export interface SignInProfile {
  /** The account's sign-in name as VS Code shows it, e.g. you@contoso.com. */
  readonly account: string;
  /** VS Code's account ID for it, when known (matches before the name). */
  readonly accountId?: string;
  readonly tenantId: string;
  /** Display name of the tenant, when known (e.g. from the tenant list). */
  readonly tenantName?: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns the sign-in profile from `.fabric/local.json` text, `undefined`
 * when the file or its `"signIn"` section is absent, and throws a
 * `TargetConfigError` naming the bad field when it is present but invalid.
 */
export function readSignInProfile(
  localText: string | undefined,
): SignInProfile | undefined {
  if (localText === undefined || localText.trim().length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(localText);
  } catch (cause) {
    throw invalid("the file is not valid JSON", cause);
  }
  if (!isRecord(parsed)) {
    throw invalid("the root must be an object");
  }
  const signIn = parsed["signIn"];
  if (signIn === undefined) {
    return undefined;
  }
  if (!isRecord(signIn)) {
    throw invalid('"signIn" must be an object');
  }
  const account = signIn["account"];
  if (typeof account !== "string" || account.trim().length === 0) {
    throw invalid('"signIn.account" must be the account name');
  }
  const tenantId = signIn["tenantId"];
  if (typeof tenantId !== "string" || !GUID.test(tenantId)) {
    throw invalid('"signIn.tenantId" must be a GUID');
  }
  const accountId = signIn["accountId"];
  const tenantName = signIn["tenantName"];
  return {
    account,
    tenantId: tenantId.toLowerCase(),
    ...(typeof accountId === "string" && accountId.length > 0
      ? { accountId }
      : {}),
    ...(typeof tenantName === "string" && tenantName.length > 0
      ? { tenantName }
      : {}),
  };
}

/**
 * Returns new `.fabric/local.json` text with the `"signIn"` section set
 * (or removed, for `undefined`), keeping every other key as it was.
 */
export function writeSignInProfile(
  localText: string | undefined,
  profile: SignInProfile | undefined,
): string {
  let root: Record<string, unknown> = {};
  if (localText !== undefined && localText.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(localText);
    } catch (cause) {
      throw invalid(
        "the file is not valid JSON, so the sign-in cannot be saved without losing its contents",
        cause,
      );
    }
    if (!isRecord(parsed)) {
      throw invalid("the root must be an object");
    }
    root = parsed;
  }
  if (profile === undefined) {
    delete root["signIn"];
  } else {
    root["signIn"] = { ...profile };
  }
  return JSON.stringify(root, undefined, 2) + "\n";
}

/** How the sign-in is shown: the account, plus the tenant's name if known. */
export function describeSignIn(profile: SignInProfile): string {
  return profile.tenantName === undefined
    ? profile.account
    : `${profile.account} · ${profile.tenantName}`;
}

/**
 * The tenant (`tid` claim) an Entra access token was issued for, or
 * `undefined` when the token is not a readable JWT. The token is only
 * decoded, never verified: it came straight from the sign-in provider and
 * is used here just to learn which tenant the account signed in to.
 */
export function tenantFromToken(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (payload === undefined || payload.length === 0) {
    return undefined;
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const tid = isRecord(claims) ? claims["tid"] : undefined;
  return typeof tid === "string" && GUID.test(tid)
    ? tid.toLowerCase()
    : undefined;
}

function invalid(why: string, cause?: unknown): TargetConfigError {
  return new TargetConfigError(
    `The sign-in saved in '${LOCAL_OVERRIDE_FILE}' is invalid: ${why}.`,
    {
      operation: "read sign-in",
      entity: `file ${LOCAL_OVERRIDE_FILE}`,
      remediation:
        "Run 'Fabric: Sign In' to save a fresh sign-in, or fix the \"signIn\" section by hand.",
      cause,
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
