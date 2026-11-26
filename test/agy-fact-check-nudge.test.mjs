// agy continues the turn on {"decision":"continue"} and ends it on any other output. The payload's
// fields, and the values on a continuation's stop and in a subagent, were captured from agy 1.5.17.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { ROOT, runHook, tempDir } from "./helpers.mjs";

const { buildEveryTurnRequest, buildRequest } = createRequire(import.meta.url)(path.join(ROOT, "hooks", "fact-check-nudge.js"));

function stop(overrides = {}) {
  return JSON.stringify({
    conversationId: "00000000-0000-4000-8000-000000000000",
    hookEventName: "Stop",
    cwd: "/tmp/probe",
    executionNum: 0,
    fullyIdle: true,
    continuationActive: false,
    terminationReason: "NO_TOOL_CALL",
    error: "",
    lastUserInput: "What is 2+2?",
    ...overrides,
  });
}

test("nudges on the first stop of a turn", () => {
  const result = runHook("agy-fact-check-nudge.js", stop());
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output, { decision: "continue", reason: buildEveryTurnRequest("") });
  assert.ok(output.reason.endsWith(buildRequest("")), "the request is Claude Code's, after the skip line");
});

test("stays silent on a later stop in the same turn", () => {
  const result = runHook("agy-fact-check-nudge.js", stop({ executionNum: 1 }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("appends FACT_CHECK_NUDGE_EXTRA_FILE's text", (t) => {
  const extra = path.join(tempDir(t), "extra.md");
  fs.writeFileSync(extra, "Then update the notes this turn made false.\n");
  const result = runHook("agy-fact-check-nudge.js", stop(), { env: { FACT_CHECK_NUDGE_EXTRA_FILE: extra } });
  assert.equal(JSON.parse(result.stdout).reason, buildEveryTurnRequest("Then update the notes this turn made false."));
});

test("stays silent while background work runs, since the turn goes on when it finishes", () => {
  assert.equal(runHook("agy-fact-check-nudge.js", stop({ fullyIdle: false })).stdout, "");
});

test("stays silent in a subagent, whose conversation has no user input", () => {
  assert.equal(runHook("agy-fact-check-nudge.js", stop({ lastUserInput: "" })).stdout, "");
});

test("stays silent on a turn the user canceled or an error ended", () => {
  for (const terminationReason of ["USER_CANCELED", "ERROR", "MAX_INVOCATIONS"]) {
    assert.equal(runHook("agy-fact-check-nudge.js", stop({ terminationReason })).stdout, "", terminationReason);
  }
});

test("stays silent on a payload it can't read", () => {
  const result = runHook("agy-fact-check-nudge.js", "not json");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});
