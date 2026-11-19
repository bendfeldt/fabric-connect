import assert from "node:assert/strict";
import { test } from "node:test";
import type { LivyTarget } from "../src/core/livySessionManager";
import { restartTrackedSessionAfterModeChange } from "../src/vscode/moduleModeTransition";

const target: LivyTarget = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  lakehouseId: "33333333-3333-4333-8333-333333333333",
};

function sessionTracker(tracked: boolean) {
  const calls: string[] = [];
  return {
    calls,
    sessions: {
      hasSession(candidate: LivyTarget) {
        assert.equal(candidate, target);
        calls.push("check");
        return tracked;
      },
      async stopSession(candidate: LivyTarget) {
        assert.equal(candidate, target);
        calls.push("stop");
      },
    },
  };
}

test("Local to Remote restarts exactly the tracked target", async () => {
  const tracker = sessionTracker(true);
  const restarted: LivyTarget[] = [];

  const didRestart = await restartTrackedSessionAfterModeChange(
    { previous: "local", selected: "remote" },
    target,
    tracker.sessions,
    async (sessionTarget) => {
      restarted.push(sessionTarget);
    },
  );

  assert.equal(didRestart, true);
  assert.deepEqual(tracker.calls, ["check", "stop"]);
  assert.deepEqual(restarted, [target]);
});

test("switching into or out of Wheel restarts, as does selecting another wheel", async () => {
  for (const transition of [
    { previous: "remote", selected: "wheel" },
    { previous: "wheel", selected: "local" },
    { previous: "wheel", selected: "wheel", wheelChanged: true },
  ] as const) {
    const tracker = sessionTracker(true);
    let restarted = 0;
    assert.equal(
      await restartTrackedSessionAfterModeChange(
        transition,
        target,
        tracker.sessions,
        async () => {
          restarted++;
        },
      ),
      true,
    );
    assert.equal(restarted, 1);
    assert.deepEqual(tracker.calls, ["check", "stop"]);
  }
});

test("does not create or restart sessions without the matching transition", async () => {
  const tracker = sessionTracker(false);
  let starts = 0;
  const restart = async (sessionTarget: LivyTarget) => {
    assert.equal(sessionTarget, target);
    starts += 1;
  };
  const transitions = [
    undefined,
    { previous: "local", selected: "local" },
    { previous: "remote", selected: "local" },
  ] as const;

  for (const transition of transitions) {
    assert.equal(
      await restartTrackedSessionAfterModeChange(
        transition,
        target,
        tracker.sessions,
        restart,
      ),
      false,
    );
  }
  assert.equal(
    await restartTrackedSessionAfterModeChange(
      { previous: "local", selected: "remote" },
      target,
      tracker.sessions,
      restart,
    ),
    false,
  );
  assert.equal(
    await restartTrackedSessionAfterModeChange(
      { previous: "local", selected: "remote" },
      undefined,
      tracker.sessions,
      restart,
    ),
    false,
  );
  assert.deepEqual(tracker.calls, ["check"]);
  assert.equal(starts, 0);
});

test("restart errors propagate", async () => {
  const tracker = sessionTracker(true);

  await assert.rejects(
    restartTrackedSessionAfterModeChange(
      { previous: "local", selected: "remote" },
      target,
      tracker.sessions,
      async () => {
        throw new Error("session start failed");
      },
    ),
    /session start failed/,
  );
  assert.deepEqual(tracker.calls, ["check", "stop"]);
});
