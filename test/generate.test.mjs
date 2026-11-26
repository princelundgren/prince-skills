import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT } from "./helpers.mjs";

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const guidelines = fs.readdirSync(path.join(ROOT, "guidelines")).filter((file) => file.endsWith(".md")).sort();

test("the generated files match their sources", () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "generate.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("QWEN.md holds every rule in full, since it is the only way the rules reach Qwen Code", () => {
  const context = read("QWEN.md");
  for (const file of guidelines) assert.ok(context.includes(read("guidelines", file).trimEnd()), file);
});

const kiroOnDemand = ["recommend-multiagent-workflow.md", "surface-shared-gotchas.md"];

test("every rule is a Kiro steering file, always included but for the two tied to an activity", () => {
  const steering = fs.readdirSync(path.join(ROOT, "kiro", "steering")).sort();
  assert.deepEqual(steering, guidelines);
  for (const file of steering) {
    const text = read("kiro", "steering", file);
    if (!kiroOnDemand.includes(file)) assert.ok(text.startsWith("---\ninclusion: always\n---\n"), file);
    assert.ok(text.endsWith(read("guidelines", file)), file);
  }
});

test("Kiro loads the activity rules when a request matches their description, which Kiro requires with a name", () => {
  for (const file of kiroOnDemand) {
    const name = file.slice(0, -3);
    assert.match(read("kiro", "steering", file), new RegExp(`^---\\ninclusion: auto\\nname: ${name}\\ndescription: "Use [^"\\n]+"\\n---\\n`), file);
  }
});

test("a Kiro agent made from one with no tools: line gets every tool tag, since Kiro gives none by default", () => {
  const inheriting = fs.readdirSync(path.join(ROOT, "agents"))
    .filter((file) => file.endsWith(".md") && !/^tools:/m.test(read("agents", file)));
  assert.ok(inheriting.length > 0, "no agent without a tools: line to check");
  for (const file of inheriting) {
    assert.match(read("kiro", "agents", file), /^tools: \["read", "write", "shell", "web"\]$/m, file);
  }
});

test("Claude Code injects every rule at session start and into every subagent", () => {
  const { hooks } = JSON.parse(read("hooks", "hooks.json"));
  const injected = (event) => hooks[event][0].hooks
    .map((hook) => /inject-rule\.js" ([a-z0-9-]+)$/.exec(hook.command)?.[1])
    .filter(Boolean)
    .map((rule) => `${rule}.md`)
    .sort();
  assert.deepEqual(injected("SessionStart"), guidelines);
  assert.deepEqual(injected("SubagentStart"), guidelines);
});

test("Kiro's hooks run the scripts from the folder the README clones into", () => {
  const clone = /git clone \S+ (\S+)/.exec(read("README.md"))[1].replace(/^~/, "$HOME");
  const { hooks } = JSON.parse(read("kiro", "hooks", "prince-skills.json"));
  for (const hook of hooks) {
    const script = /hooks\/([a-z-]+\.js)"$/.exec(hook.action.command)[1];
    assert.equal(hook.action.command, `node "${clone}/hooks/${script}"`);
    assert.ok(fs.existsSync(path.join(ROOT, "hooks", script)), script);
  }
});

// agy drops a rule file without a trigger, and demotes always-on rules to pointers, with their
// description, once they and the AGENTS.md files pass its rule budget, so most rules here load on
// demand.
const AGY_ALWAYS_ON = [
  "check-for-a-prior-decision.md", "close-the-turn-clearly.md", "give-full-paths.md",
  "keep-working-after-a-mid-task-prompt.md", "stop-after-repeated-failures.md", "verify-before-asserting.md",
];
const AGY_ALWAYS_ON_BYTES = 11000;

test("generate writes agy/rules with a trigger for every guideline and agy/agents with model inherit", () => {
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "agy", "rules")).sort(), guidelines);
  for (const file of guidelines) {
    const text = read("agy", "rules", file);
    const trigger = AGY_ALWAYS_ON.includes(file) ? "always_on" : "model_decision";
    assert.match(text, new RegExp(`^---\\ntrigger: ${trigger}\\ndescription: "[^"\\n]+"\\n---\\n\\n`), file);
    assert.ok(text.endsWith(read("guidelines", file)), file);
  }
  const agents = fs.readdirSync(path.join(ROOT, "agents")).filter((file) => file.endsWith(".md")).sort();
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "agy", "agents")).sort(), agents);
  for (const file of agents) {
    const text = read("agy", "agents", file);
    assert.match(text, /^model: inherit$/m, file);
    assert.doesNotMatch(text, /^skills:/m, file);
  }
});

test("agy's always-on rules stay within the share of its rule budget left to them", () => {
  const bytes = AGY_ALWAYS_ON.reduce((total, file) => total + Buffer.byteLength(read("agy", "rules", file)), 0);
  assert.ok(bytes <= AGY_ALWAYS_ON_BYTES, `${bytes} bytes of always-on agy rules, over ${AGY_ALWAYS_ON_BYTES}`);
});

test("an agy agent gets agy's tool ids, and every tool it can use where its source has no tools: line", () => {
  const tools = (file) => JSON.parse(/^tools: (\[.*\])$/m.exec(read("agy", "agents", file))[1]);
  assert.deepEqual(tools("implementation-planner.md"), ["read_file", "run_command", "write_file", "edit_file", "search_web"]);
  assert.deepEqual(tools("solution-architect.md"), ["read_file", "write_file", "edit_file", "run_command", "search_web"]);
});

const listFiles = (dir) => fs.readdirSync(path.join(ROOT, dir), { recursive: true })
  .filter((file) => fs.statSync(path.join(ROOT, dir, file)).isFile())
  .sort();

test("agy/ is an agy plugin named as the Claude Code one, with hooks that run from the plugin root", () => {
  const claude = JSON.parse(read(".claude-plugin", "plugin.json"));
  const agy = JSON.parse(read("agy", "plugin.json"));
  assert.equal(agy.name, claude.name);
  assert.equal(agy.description, claude.description);
  assert.deepEqual(JSON.parse(read("agy", "hooks.json")), {
    "prince-skills": { Stop: [{ type: "command", command: "node ./hooks/agy-fact-check-nudge.js", timeout: 10 }] },
  });
});

test("agy's plugin carries the hook scripts and skills as copies of their sources", () => {
  assert.deepEqual(listFiles("agy/hooks"), ["agy-fact-check-nudge.js", "fact-check-nudge.js"]);
  for (const file of listFiles("agy/hooks")) assert.equal(read("agy", "hooks", file), read("hooks", file), file);
  assert.deepEqual(listFiles("agy/skills"), listFiles("skills"));
  for (const file of listFiles("skills")) assert.equal(read("agy", "skills", file), read("skills", file), file);
});
