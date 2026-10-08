import assert from "node:assert/strict";
import { test } from "node:test";
import { LivyError } from "../src/core/errors";
import { ExecutionDiagnostics } from "../src/core/executionDiagnostics";

test("diagnostics report measured outcomes and preserve returned values and errors", async () => {
  const logs: string[] = [];
  let clock = 0;
  const diagnostics = new ExecutionDiagnostics(
    { debug: (message) => logs.push(message) },
    () => clock,
  );
  const value = { status: "cancelled" as const };
  assert.equal(
    await diagnostics.measure(
      "statement.wait.user",
      async () => {
        clock += 23;
        return value;
      },
      (result) => result.status,
    ),
    value,
  );
  const failure = new Error("private error detail");
  await assert.rejects(
    diagnostics.measure("modules.prepare", async () => {
      clock += 7;
      throw failure;
    }),
    (error) => error === failure,
  );
  const cancelled = new LivyError("private cancellation detail", {
    operation: "execute",
    kind: "cancelled",
  });
  await assert.rejects(
    diagnostics.measure("host.resolve", async () => {
      throw cancelled;
    }),
    (error) => error === cancelled,
  );
  diagnostics.finish("cancelled");
  assert.deepEqual(
    logs.map((line) => line.replace(/^\[execution \d+\] /, "")),
    [
      "phase=statement.wait.user durationMs=23 outcome=cancelled",
      "phase=modules.prepare durationMs=7 outcome=error",
      "phase=host.resolve durationMs=0 outcome=cancelled",
      "phase=total durationMs=30 outcome=cancelled",
    ],
  );
  assert.ok(!logs.join("\n").includes("private"));
});

test("diagnostics without a logger do not read the clock or alter execution", async () => {
  const diagnostics = new ExecutionDiagnostics(undefined, () => {
    throw new Error("disabled diagnostics must not read the clock");
  });
  assert.equal(await diagnostics.measure("code.prepare", async () => 42), 42);
  diagnostics.finish("ok");
});

test("a diagnostic sink failure is reported without replacing the execution result", async () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => {
    warnings.push(message);
  };
  try {
    const diagnostics = new ExecutionDiagnostics({
      debug: () => {
        throw new Error("private sink error");
      },
    });
    assert.equal(await diagnostics.measure("code.prepare", async () => 42), 42);
    const original = new Error("private execution error");
    await assert.rejects(
      diagnostics.measure("code.prepare", async () => {
        throw original;
      }),
      (error) => error === original,
    );
    diagnostics.finish("error");
    assert.equal(warnings.length, 3);
    assert.ok(
      warnings.every(
        (message) =>
          message === "[fabric-connect] Failed to write execution diagnostics.",
      ),
    );
  } finally {
    console.warn = warn;
  }
});
