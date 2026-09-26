import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import {
  LocalFirstViolationError,
  LivyError,
  OneLakeError,
  SparkJobError,
  StagingError,
} from "../src/core/errors";
import {
  bundleModules,
  bundlePath,
  moduleImportCode,
  scratchFolder,
  stagedFileName,
} from "../src/core/moduleStaging";
import { OneLakeClient, abfssUri } from "../src/core/oneLakeClient";
import {
  buildBatchRequest,
  locateJobFiles,
  parseSparkJobSettings,
  runBatch,
  splitArguments,
} from "../src/core/sparkJob";
import {
  NEVER_CANCELLED,
  type FabricRequestOptions,
  type FabricResponse,
  type IFabricApiClient,
} from "../src/core/types";
import { crc32, createZip } from "../src/core/zip";

const ROOT = path.resolve("/repo");
const TENANT = "87654321-4321-4321-4321-cba987654321";
const WS = "11111111-1111-1111-1111-111111111111";
const LH = "22222222-2222-2222-2222-222222222222";
const TARGET = { tenantId: TENANT, workspaceId: WS, lakehouseId: LH };
const bytes = (text: string) => new TextEncoder().encode(text);

// --- zip -----------------------------------------------------------------------

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(bytes("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test("zip archives are well-formed and deterministic", () => {
  const entries = [
    { path: "pkg/b.py", data: bytes("B = 2\n") },
    { path: "pkg/__init__.py", data: bytes("") },
    { path: "a.py", data: bytes("A = 1\n") },
  ];
  const zip = createZip(entries);
  assert.deepEqual(zip, createZip([...entries].reverse()));
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 3, "entry count");
  const centralStart = view.getUint32(end + 16, true);
  assert.equal(view.getUint32(centralStart, true), 0x02014b50);
  // Entries are sorted, so the first local entry is a.py with its CRC.
  const nameLength = view.getUint16(26, true);
  assert.equal(
    new TextDecoder().decode(zip.slice(30, 30 + nameLength)),
    "a.py",
  );
  assert.equal(view.getUint32(14, true), crc32(bytes("A = 1\n")));
});

// --- module staging ------------------------------------------------------------

function stagingFs(files: Record<string, string>) {
  const abs = Object.fromEntries(
    Object.entries(files).map(([rel, text]) => [path.join(ROOT, rel), text]),
  );
  return {
    listFiles: async (dir: string) => {
      const found = Object.keys(abs).filter((p) =>
        p.startsWith(dir + path.sep),
      );
      if (found.length === 0) {
        throw new Error(`ENOENT ${dir}`);
      }
      return found;
    },
    readBytes: async (file: string) => bytes(abs[file]),
  };
}

test("bundles .py files relative to each source root", async () => {
  const fs = stagingFs({
    "src/mypkg/__init__.py": "",
    "src/mypkg/core.py": "X = 1",
    "src/mypkg/__pycache__/core.cpython-311.pyc": "junk",
    "src/mypkg/data.json": "{}",
    "src/.hidden/secret.py": "S = 1",
    "lib/helper.py": "H = 1",
  });
  const bundle = await bundleModules(fs, ROOT, ["src", "lib"]);
  assert.ok(bundle !== undefined);
  assert.deepEqual(bundle.topLevel, ["helper", "mypkg"]);
  assert.equal(bundle.fileCount, 3);
  assert.match(bundle.hash, /^[0-9a-f]{64}$/);
  const again = await bundleModules(fs, ROOT, ["src", "lib"]);
  assert.equal(again?.hash, bundle.hash, "same sources, same hash");
  const text = new TextDecoder().decode(bundle.zip);
  assert.match(text, /mypkg\/core\.py/);
  assert.doesNotMatch(text, /secret|pyc|data\.json/);
});

test("nothing to stage returns undefined", async () => {
  const fs = stagingFs({ "src/readme.md": "# hi" });
  assert.equal(await bundleModules(fs, ROOT, ["src"]), undefined);
  assert.equal(await bundleModules(fs, ROOT, []), undefined);
});

test("staging errors: outside the workspace, unreadable root, overlaps", async () => {
  const fs = stagingFs({ "a/m.py": "", "b/m.py": "" });
  await assert.rejects(bundleModules(fs, ROOT, ["../elsewhere"]), StagingError);
  await assert.rejects(bundleModules(fs, ROOT, ["missing"]), StagingError);
  await assert.rejects(
    bundleModules(fs, ROOT, ["a", "b"]),
    (error: unknown) =>
      error instanceof StagingError && /two source roots/.test(error.message),
  );
});

test("the import prelude is idempotent per bundle and purges stale modules", () => {
  const code = moduleImportCode("abfss://w@onelake/l/Files/x.zip", [
    "helper",
    "mypkg",
  ]);
  assert.match(
    code,
    /if "abfss:\/\/w@onelake\/l\/Files\/x\.zip" not in _fc_staged:/,
  );
  assert.match(code, /addPyFile\("abfss:/);
  assert.match(code, /_fc_names = set\(\["helper","mypkg"\]\)/);
  assert.equal(
    bundlePath("run-1", "a".repeat(64)),
    `${scratchFolder("run-1")}/modules-${"a".repeat(16)}.zip`,
  );
  assert.equal(
    abfssUri(WS, LH, "Files/x.zip"),
    `abfss://${WS}@onelake.dfs.fabric.microsoft.com/${LH}/Files/x.zip`,
  );
});

// --- OneLake client ------------------------------------------------------------

function fakeOneLake(respond: (url: URL, init: RequestInit) => Response) {
  const calls: Array<{ method: string; url: URL; init: RequestInit }> = [];
  const scopes: string[][] = [];
  const client = new OneLakeClient(
    {
      getToken: async (_tenant, s) => {
        scopes.push([...s]);
        return "token";
      },
    },
    {
      fetchFn: (async (url: unknown, init?: RequestInit) => {
        const parsed = new URL(String(url));
        calls.push({
          method: init?.method ?? "GET",
          url: parsed,
          init: init ?? {},
        });
        return respond(parsed, init ?? {});
      }) as typeof fetch,
    },
  );
  return { client, calls, scopes };
}

const AT = { tenantId: TENANT, workspaceId: WS, itemId: LH };

test("upload is create + append + flush with the storage scope and version header", async () => {
  const { client, calls, scopes } = fakeOneLake(
    () => new Response(null, { status: 201 }),
  );
  await client.uploadFile(
    AT,
    "Files/.fabric-connect/run-1/a_b.zip",
    bytes("abc"),
  );
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`),
    [
      `PUT /${WS}/${LH}/Files/.fabric-connect/run-1/a_b.zip?resource=file`,
      `PATCH /${WS}/${LH}/Files/.fabric-connect/run-1/a_b.zip?action=append&position=0`,
      `PATCH /${WS}/${LH}/Files/.fabric-connect/run-1/a_b.zip?action=flush&position=3`,
    ],
  );
  assert.deepEqual(scopes[0], ["https://storage.azure.com/.default"]);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["x-ms-version"], "2023-11-03");
});

test("uploads outside the scratch folder never reach auth or the network", async () => {
  const { client, calls, scopes } = fakeOneLake(
    () => new Response(null, { status: 201 }),
  );
  await assert.rejects(
    client.uploadFile(AT, "Files/data.csv", bytes("x")),
    LocalFirstViolationError,
  );
  await assert.rejects(
    client.deleteDirectory(AT, "Files"),
    LocalFirstViolationError,
  );
  assert.equal(calls.length, 0);
  assert.equal(scopes.length, 0);
});

test("delete of a missing scratch folder is fine; other failures are typed", async () => {
  const missing = fakeOneLake(() => new Response(null, { status: 404 }));
  await missing.client.deleteDirectory(AT, "Files/.fabric-connect/run-1");
  assert.equal(missing.calls[0].url.search, "?recursive=true");
  const denied = fakeOneLake(() => new Response(null, { status: 403 }));
  await assert.rejects(
    denied.client.deleteDirectory(AT, "Files/.fabric-connect/run-1"),
    (error: unknown) =>
      error instanceof OneLakeError && /lacks access/.test(error.message),
  );
});

test("list follows continuation and strips the item prefix", async () => {
  let page = 0;
  const { client, calls } = fakeOneLake(() => {
    page++;
    return new Response(
      JSON.stringify({
        paths:
          page === 1
            ? [{ name: `${LH}/Files/raw`, isDirectory: "true" }]
            : [
                {
                  name: `${LH}/Files/a.csv`,
                  contentLength: "12",
                  lastModified: "x",
                },
              ],
      }),
      { status: 200, headers: page === 1 ? { "x-ms-continuation": "c1" } : {} },
    );
  });
  const paths = await client.list(AT, "Files");
  assert.deepEqual(paths, [
    { path: "Files/raw", isDirectory: true },
    {
      path: "Files/a.csv",
      isDirectory: false,
      contentLength: 12,
      lastModified: "x",
    },
  ]);
  assert.equal(calls[0].url.searchParams.get("directory"), `${LH}/Files`);
  assert.equal(calls[1].url.searchParams.get("continuation"), "c1");
});

// --- Spark job definitions -------------------------------------------------------

const SETTINGS = JSON.stringify({
  executableFile: "abfss://x@onelake.dfs.fabric.microsoft.com/y/Main/job.py",
  defaultLakehouseArtifactId: LH,
  mainClass: "",
  additionalLakehouseIds: [],
  commandLineArguments: '--date 2026-01-01 --name "big job"',
  additionalLibraryUris: [
    "abfss://x@onelake/y/Libs/util.py",
    "abfss://remote/lib.jar",
  ],
  language: "Python",
  environmentArtifactId: null,
});

test("job settings parse, with empty values treated as absent", () => {
  const settings = parseSparkJobSettings(
    SETTINGS,
    "/repo/Etl.SparkJobDefinition",
  );
  assert.equal(settings.mainClass, undefined);
  assert.equal(settings.environmentArtifactId, undefined);
  assert.equal(settings.additionalLibraryUris.length, 2);
  assert.throws(
    () => parseSparkJobSettings(undefined, "/repo/Etl.SparkJobDefinition"),
    SparkJobError,
  );
  assert.throws(
    () => parseSparkJobSettings("{bad", "/repo/Etl.SparkJobDefinition"),
    SparkJobError,
  );
});

test("job files come from the repo: Main/, Libs/, remote libraries passed through", async () => {
  const folder = path.join(ROOT, "Etl.SparkJobDefinition");
  const files: Record<string, string> = {
    [path.join(folder, "Main", "job.py")]: "print(1)",
    [path.join(folder, "Libs", "util.py")]: "U = 1",
  };
  const fs = {
    readFile: async (p: string) => files[p],
    listDir: async (dir: string) =>
      Object.keys(files)
        .filter((p) => path.dirname(p) === dir)
        .map((p) => path.basename(p)),
  };
  const settings = parseSparkJobSettings(SETTINGS, folder);
  const located = await locateJobFiles(fs, folder, settings);
  assert.equal(located.main, path.join(folder, "Main", "job.py"));
  assert.deepEqual(located.libs, [path.join(folder, "Libs", "util.py")]);
  assert.deepEqual(located.remoteLibs, ["abfss://remote/lib.jar"]);

  const empty = { readFile: async () => undefined, listDir: async () => [] };
  await assert.rejects(
    locateJobFiles(empty, folder, settings),
    (error: unknown) =>
      error instanceof SparkJobError &&
      /expected 'job\.py'/.test(error.message),
  );
});

test("arguments split like a shell", () => {
  assert.deepEqual(
    splitArguments("--date 2026-01-01 --name \"big job\" 'x y'"),
    ["--date", "2026-01-01", "--name", "big job", "x y"],
  );
  assert.deepEqual(splitArguments(undefined), []);
});

test("batch requests sort libraries and attach the Environment", () => {
  const settings = parseSparkJobSettings(
    SETTINGS,
    "/repo/Etl.SparkJobDefinition",
  );
  const request = buildBatchRequest(
    "Etl (Fabric Connect)",
    { ...settings, mainClass: "com.x.Main" },
    "abfss://s/job.py",
    ["abfss://s/util.py", "abfss://remote/lib.jar", "abfss://s/cfg.yaml"],
    "33333333-3333-3333-3333-333333333333",
  );
  assert.deepEqual(request, {
    name: "Etl (Fabric Connect)",
    file: "abfss://s/job.py",
    args: ["--date", "2026-01-01", "--name", "big job"],
    pyFiles: ["abfss://s/util.py"],
    jars: ["abfss://remote/lib.jar"],
    files: ["abfss://s/cfg.yaml"],
    conf: {
      "spark.fabric.environmentDetails": JSON.stringify({
        id: "33333333-3333-3333-3333-333333333333",
      }),
    },
  });
  const scala = buildBatchRequest(
    "J",
    { ...settings, mainClass: "com.x.Main" },
    "abfss://s/job.jar",
    [],
    undefined,
  );
  assert.equal(scala.className, "com.x.Main");
});

function batchApi(states: string[], logs?: string[][]) {
  const calls: FabricRequestOptions[] = [];
  let poll = 0;
  let logCall = 0;
  const api: IFabricApiClient = {
    async request<T>(options: FabricRequestOptions) {
      calls.push(options);
      let body: unknown = {};
      if (options.method === "POST") {
        body = { id: 42, state: "starting" };
      } else if (options.method === "GET" && options.path.includes("/log?")) {
        if (logs === undefined) {
          throw new Error("404");
        }
        body = { log: logs[logCall++] ?? [] };
      } else if (options.method === "GET") {
        body = { state: states[Math.min(poll++, states.length - 1)] };
      }
      return { status: 200, body } as FabricResponse<T>;
    },
  };
  return { api, calls };
}

test("a batch is followed to success with streamed logs", async () => {
  const { api, calls } = batchApi(
    ["starting", "running", "success"],
    [["a"], ["b", "c"]],
  );
  const seen: string[] = [];
  const states: string[] = [];
  const state = await runBatch(
    api,
    TARGET,
    { name: "J", file: "abfss://x", args: [] },
    NEVER_CANCELLED,
    {
      sleep: async () => undefined,
      onLog: (l) => seen.push(l),
      onState: (s) => states.push(s),
    },
  );
  assert.equal(state, "success");
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.deepEqual(states, ["starting", "running", "success"]);
  assert.match(calls[0].path, /\/livyapi\/versions\/2023-12-01\/batches$/);
  assert.ok(
    calls.some((c) => c.path.endsWith("/batches/42/log?from=1&size=200")),
  );
});

test("batch failures and missing logs are handled", async () => {
  const dead = batchApi(["running", "dead"]);
  assert.equal(
    await runBatch(
      dead.api,
      TARGET,
      { name: "J", file: "f", args: [] },
      NEVER_CANCELLED,
      {
        sleep: async () => undefined,
        onLog: () => undefined,
      },
    ),
    "dead",
  );
  // Logs failed once, so they are not requested again.
  assert.equal(dead.calls.filter((c) => c.path.includes("/log?")).length, 1);
});

test("cancelling a batch deletes it", async () => {
  const { api, calls } = batchApi(["running"]);
  let cancelled = false;
  const token = {
    get isCancellationRequested() {
      return cancelled;
    },
    onCancellationRequested: () => ({ dispose: () => undefined }),
  };
  const state = await runBatch(
    api,
    TARGET,
    { name: "J", file: "f", args: [] },
    token,
    {
      sleep: async () => {
        cancelled = true;
      },
    },
  );
  assert.equal(state, "cancelled");
  assert.equal(calls[calls.length - 1].method, "DELETE");
  assert.match(calls[calls.length - 1].path, /\/batches\/42$/);
});

test("a batch without a usable ID is a protocol error", async () => {
  const api: IFabricApiClient = {
    async request<T>() {
      return { status: 200, body: { id: "../x" } } as FabricResponse<T>;
    },
  };
  await assert.rejects(
    runBatch(api, TARGET, { name: "J", file: "f", args: [] }, NEVER_CANCELLED),
    (error: unknown) => error instanceof LivyError && error.kind === "protocol",
  );
});

test("staged file names are made safe for the scratch folder", () => {
  assert.equal(stagedFileName("my job.py"), "my_job.py");
  assert.equal(stagedFileName("ünïcode.jar"), "_n_code.jar");
  assert.equal(stagedFileName(".env"), "_.env");
  assert.equal(stagedFileName("util.py"), "util.py");
});
