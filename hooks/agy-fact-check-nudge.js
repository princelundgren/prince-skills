#!/usr/bin/env node
// agy Stop: asks the session to fact-check its last message, as kiro-fact-check-nudge.js does for
// Kiro. agy's Stop payload carries no message to measure, and agy fires Stop again after the
// continuation it asks for, so it asks only on a turn's first stop (executionNum 0) once the turn
// is done: background work finished (fullyIdle) and the model ended it (NO_TOOL_CALL), not the user
// or an error. It skips a subagent, as Claude Code's hook asks only the main session.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

// Not continuationActive: agy 1.5.17 sends it false on the stop after a continuation. A subagent's
// conversation is the one with no lastUserInput.
function isFirstFinishedStop(payload) {
  return payload.executionNum === 0 && payload.fullyIdle === true && payload.terminationReason === "NO_TOOL_CALL" &&
    typeof payload.lastUserInput === "string" && payload.lastUserInput !== "";
}

try {
  const payload = JSON.parse(fs.readFileSync(0, "utf8"));
  if (isFirstFinishedStop(payload)) {
    const { buildEveryTurnRequest } = require(path.join(__dirname, "fact-check-nudge.js"));
    process.stdout.write(`${JSON.stringify({ decision: "continue", reason: buildEveryTurnRequest() })}\n`);
  }
} catch {
  // A failed check must not hold a turn open.
}
