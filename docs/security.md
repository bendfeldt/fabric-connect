# Security and data

What Fabric Connect talks to, what it is allowed to change, and what it
keeps on your machine. Written for developers and for whoever reviews an
extension before it is allowed near client tenants.

## The short version

- **It never deploys.** Code stays in your repo. The extension runs it on
  Fabric; it never creates, updates or deletes workspace items (Lakehouses
  included), never updates item definitions, never runs pipelines or
  scheduled jobs, and never touches git integration or deployment
  pipelines.
- **Writes are allowlisted in code**, checked before a token is requested
  or a request is sent. Anything not on the list fails with a
  `LocalFirstViolationError`. The list is fixed by a unit test, so
  changing it is a visible, reviewed change.
- **Tokens stay in VS Code.** Sign-in uses VS Code's built-in Microsoft
  account provider; the extension never writes tokens to disk or logs.
- **No telemetry.** The extension sends nothing anywhere except the
  Microsoft endpoints below, and only when you run a command.

## Sign-in and permissions

Sign-in goes through VS Code's Microsoft authentication provider, one
session per tenant (the tenant is part of the request, so a token for one
tenant is never used against another). Each repo signs in with one
Microsoft account, remembered in its `.fabric/local.json`, and every token
is requested for that account, so a repo never uses another account's
session. Scopes requested, per service, and
only when a feature needs them:

| Service                      | Scope                                               | Used for                                    |
| ---------------------------- | --------------------------------------------------- | ------------------------------------------- |
| Fabric REST API (incl. Livy) | `https://api.fabric.microsoft.com/.default`         | everything below except the next three rows |
| OneLake (ADLS Gen2 API)      | `https://storage.azure.com/.default`                | browsing files, previews, scratch staging   |
| Power BI REST API            | `https://analysis.windows.net/powerbi/api/.default` | `.dax` queries                              |
| Kusto (Eventhouse / KQL DB)  | `https://kusto.kusto.windows.net/.default`          | `.kql` queries                              |
| Azure Resource Manager       | `https://management.azure.com/.default`             | listing your tenants (see below)            |

The first DAX or KQL query may show a consent prompt, because those
services use permissions separate from the Fabric API.

The Azure Resource Manager scope is requested only when you choose **Find
tenants on my account…** when switching tenant, for your home tenant, and
the policy below lets it make exactly one kind of request: `GET /tenants`
(the list of tenants your account belongs to). Every other Resource
Manager request — any subscription, resource or write — is refused before
a token is requested.

## Network endpoints

| Host                                      | When                                                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `api.fabric.microsoft.com`                | listing capacities/workspaces/items, Livy sessions and batches, GraphQL queries, item definition reads, API notebooks |
| `onelake.dfs.fabric.microsoft.com`        | explorer file listings and previews; uploading/deleting the scratch folder                                            |
| `api.powerbi.com`                         | `.dax` queries                                                                                                        |
| `*.kusto.fabric.microsoft.com`            | `.kql` queries — the origin is validated before a token is attached; any other host is refused, even for reads        |
| `management.azure.com`                    | `GET /tenants` only, when you ask to find your tenants while switching tenant                                         |
| `login.microsoftonline.com` (via VS Code) | sign-in                                                                                                               |
| `login.microsoftonline.com` (direct)      | looking up a typed domain's tenant ID from its public OpenID configuration; no token is sent                          |

All traffic is HTTPS; certificate validation is never disabled. API
notebooks accept only `https://api.fabric.microsoft.com/v1/…` URLs or
relative paths, so a cell cannot send your token to another host.

## What the extension may change

Every request except a read (`GET`) must match one of these rules. The
rules are anchored patterns over plain path segments, so path traversal,
encoded separators and extra query strings cannot satisfy them.

| Service  | Request                                                     | Why                                                                              |
| -------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Fabric   | `POST …/lakehouses/{id}/livyapi/…/sessions`                 | start a Livy session                                                             |
| Fabric   | `DELETE …/sessions/{id}`                                    | stop a Livy session                                                              |
| Fabric   | `POST …/sessions/{id}/statements`                           | run a cell, file or selection                                                    |
| Fabric   | `POST …/sessions/{id}/statements/{id}/cancel`               | cancel a running statement                                                       |
| Fabric   | `POST …/livyapi/…/batches`                                  | run a Spark job from local files                                                 |
| Fabric   | `DELETE …/batches/{id}`                                     | cancel that job                                                                  |
| Fabric   | `POST /workspaces/{id}/items/{id}/getDefinition[?format=…]` | read an item definition (Pull into Repo)                                         |
| Fabric   | `POST /workspaces/{id}/graphqlapis/{id}/graphql`            | run a GraphQL query file                                                         |
| Power BI | `POST /v1.0/myorg/groups/{id}/datasets/{id}/executeQueries` | run a DAX query file                                                             |
| Kusto    | `POST /v1/rest/query`                                       | run a KQL query file (control commands, which use `/v1/rest/mgmt`, stay blocked) |

**OneLake writes** (upload, delete) are allowed only below
`Files/.fabric-connect/` in a Lakehouse, with plain path segments. This
scratch folder holds your zipped Python modules and Spark job files while
a session runs; it is deleted when you stop or restart the session.

Note what the allowlist cannot constrain: code you run in a Spark session,
and GraphQL mutations you write, act on **data** with your permissions,
exactly as they would in the Fabric portal. The guarantee is about
workspace **items** — the extension itself never changes them.

## What is stored on your machine

| Where                                | What                                                                                                                                                                                                                                                                                                                      | Shared?                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `.fabric/local.json` (in the repo)   | `"signIn"`: the account name, VS Code's account ID, tenant ID and name (no token); `"compute"`: capacity, workspace, Lakehouse, Environment IDs and names; `"targets"`: workspace ID per target; `"queryBindings"`: item per query file; `"lakehouseBindings"`: Lakehouse and workspace IDs and names per notebook folder | **Never commit** — add it to `.gitignore` (the extension warns if you don't) |
| `.fabric/targets.json` (in the repo) | folder → target mapping and tenant IDs                                                                                                                                                                                                                                                                                    | Committed by design                                                          |
| VS Code workspace state              | Livy session IDs per host (to reattach after a reload)                                                                                                                                                                                                                                                                    | Local to VS Code                                                             |
| VS Code global state                 | up to 10 recently used tenants (ID, name, domain), offered when switching tenant                                                                                                                                                                                                                                          | Local to VS Code                                                             |
| VS Code secret storage               | sign-in sessions (managed by VS Code, not by the extension)                                                                                                                                                                                                                                                               | Local to VS Code                                                             |

Pulled items are written only into the folder you choose, only inside
their `<name>.<Type>/` folder (definition part paths that would escape it
are refused), and never over an existing folder.

## Logs

With `fabric-connect.debugLogging` on, the **Fabric Connect** output
channel shows each API call's method, path and status. Workspace, item and
tenant GUIDs are redacted from paths, and tokens, request bodies and cell
contents are never logged. Error messages are shown only to you, in VS
Code; some include the tenant ID (for example a failed sign-in) so you can
tell which tenant is involved.

Execution phase diagnostics use local sequence numbers, fixed phase names,
durations and `ok` / `error` / `cancelled` outcomes only. They do not log
Fabric session or statement IDs, local paths, code, library values or
returned data. They use the same opt-in debug setting and stay local to
VS Code; no telemetry endpoint is added. If writing a diagnostic fails,
a static warning is sent to the extension host console without error
details, and execution results are preserved.

Original runtime errors and tracebacks are still shown unchanged and can
contain resource IDs, paths or sensitive values. The static Variable
Library hint does not sanitize that original output. Review and redact
errors manually before sharing a support packet or public issue; never
include library contents or secret values.

## Webviews

The Lakehouse panel and the Results panel use a strict Content Security
Policy (no remote content; the Results panel runs no scripts at all), and
every value that comes from Fabric is HTML-escaped before rendering.

## Supply chain

The extension has **no runtime dependencies**: it uses VS Code's API and
Node's built-ins (including `fetch`; the ZIP writer for module staging is
part of the extension). Development dependencies are TypeScript and type
definitions only. The packaged `.vsix` contains only the compiled
extension, its manifest, README, changelog, license, icon and walkthrough
pages; CI checks this on every pull request.

## Reporting a problem

Open an issue at <https://github.com/bendfeldt/fabric-connect/issues>. For
anything that looks like a security issue, please don't include tenant,
workspace or item IDs in a public issue.
