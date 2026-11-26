#!/usr/bin/env node
// Writes the files each harness reads that are made from the sources in guidelines/, agents/ and
// hooks/: the plugin's hooks/hooks.json, QWEN.md, the Kiro forms under kiro/, and agy/, an agy
// plugin.
//
//   node scripts/generate.mjs           write them
//   node scripts/generate.mjs --check   exit 1, naming each file, when one is out of date
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_HOOKS = '${CLAUDE_PLUGIN_ROOT}/hooks';
// Where the README's Kiro steps clone this repo; Kiro's hook files run the scripts from there.
const KIRO_CLONE_HOOKS = "$HOME/.local/share/prince-skills/hooks";

// Kiro's `tools:` takes category tags, not tool names, and an absent field means no tools at all.
const KIRO_TOOL_TAGS = {
  Read: "read", Grep: "read", Glob: "read",
  Write: "write", Edit: "write",
  Bash: "shell",
  WebSearch: "web", WebFetch: "web",
  Skill: null, // Kiro loads skills into every agent and has no skill tool
};
const KIRO_ALL_TAGS = [...new Set(Object.values(KIRO_TOOL_TAGS).filter(Boolean))];

// Kiro shows `description` in its agent picker, so each agent gets a short label there.
const KIRO_LABELS = {
  "requirements-analyst": "Elicits and writes requirements in EARS and user-story form.",
  "solution-architect": "Turns requirements into a technical design — architecture, data model, APIs.",
  "implementation-planner": "Turns an approved design into an ordered, testable task plan.",
};

// Kiro includes these rules only when a request matches the description; every other rule always.
// A description names the activity, since that is what a request mentions.
const KIRO_ON_DEMAND = {
  "recommend-multiagent-workflow": "Use when a task could be split across parallel agents: broad audits, migrations, sweeps.",
  "surface-shared-gotchas": "Use after fixing a bug or gotcha in a shared tool, library, or service, or before re-deriving what may already be written up.",
};

// agy's tool ids. agy has no file-search, fetch or skill tool: its agents search with run_command
// and read a skill with read_file, so Grep, Glob, WebFetch and Skill add none.
const AGY_TOOLS = {
  Read: "read_file", Write: "write_file", Edit: "edit_file", Bash: "run_command", WebSearch: "search_web",
  Grep: null, Glob: null, WebFetch: null, Skill: null,
};
// An agent with no tools: line inherits every tool in Claude Code; in agy it would get a read-only set.
const AGY_ALL_TOOLS = ["read_file", "write_file", "edit_file", "run_command", "search_web"];

// agy loads these rules only when a request matches the description; every other rule always. Its
// 20,000-token rule budget, which it counts at about 3 bytes a token (about 60,000 bytes), covers
// every always-on rule and AGENTS.md file, and past it agy demotes the largest files to a pointer
// with their description. So the always-on rules here stay within 11,000 bytes, leaving the rest
// to the user's own rules and AGENTS.md files, and those whose moment a request names load on
// demand.
const AGY_ON_DEMAND = {
  ...KIRO_ON_DEMAND,
  "adopt-before-building": "Use when proposing a new capability: a setup, a check, a deploy, a service, a tool, a script, or a part a library could supply.",
  "clean-code": "Use when writing, changing or reviewing code, comments or tests.",
  "interactive-questions": "Use when asking the user a question or for a decision.",
  "own-your-mistakes": "Use when something you did or said turns out wrong: a false claim, a bad change, a broken deploy.",
  "pressure-test-before-answering": "Use when answering a question that isn't coding: advice, planning, creative work, research.",
  "pressure-test-before-building": "Use before accepting requirements, finalizing a design, or writing non-trivial code.",
  "python-script-dependencies": "Use when a one-off Python script or python3 run needs a package outside the standard library.",
};

function listNames(dir, extension) {
  return fs.readdirSync(path.join(ROOT, dir))
    .filter((file) => file.endsWith(extension))
    .map((file) => file.slice(0, -extension.length))
    .sort();
}

function readSource(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), "utf8");
}

function nodeHook(script, ...args) {
  const command = [`node "${PLUGIN_HOOKS}/${script}"`, ...args].join(" ");
  return { type: "command", command, timeout: 10 };
}

function pluginHooks(rules) {
  const ruleHooks = rules.map((rule) => nodeHook("inject-rule.js", rule));
  const repairCoreBare = nodeHook("repair-core-bare.js");
  return {
    hooks: {
      SessionStart: [{ hooks: [repairCoreBare, ...ruleHooks] }],
      SubagentStart: [{ hooks: ruleHooks }],
      PostToolUse: [{ matcher: "EnterWorktree|ExitWorktree|Agent", hooks: [repairCoreBare] }],
      UserPromptSubmit: [{ hooks: [nodeHook("fact-check-first.js")] }],
      Stop: [{ hooks: [nodeHook("fact-check-nudge.js")] }],
    },
  };
}

function qwenContext(rules) {
  return rules.map((rule) => readSource("guidelines", `${rule}.md`).trimEnd()).join("\n\n") + "\n";
}

function kiroSteering(rule) {
  const description = KIRO_ON_DEMAND[rule];
  const frontmatter = description
    ? `inclusion: auto\nname: ${rule}\ndescription: ${quoted(description)}`
    : "inclusion: always";
  return `---\n${frontmatter}\n---\n\n${readSource("guidelines", `${rule}.md`)}`;
}

// The description agy shows in place of an always-on rule it demotes past its budget.
const AGY_ALWAYS_ON = {
  "check-for-a-prior-decision": "Before calling code, config or docs broken, look for a decision behind it.",
  "close-the-turn-clearly": "End every non-trivial turn with what changed, what needs the user, and what's next.",
  "give-full-paths": "Write absolute paths for anything the user opens or runs.",
  "keep-working-after-a-mid-task-prompt": "A message sent mid-task adds to the work unless it says it replaces it.",
  "stop-after-repeated-failures": "After 2-3 failed variations of one action, stop guessing and switch strategy.",
  "verify-before-asserting": "Check every factual claim against a live source before stating it.",
};

function agyRule(rule) {
  const onDemand = AGY_ON_DEMAND[rule];
  const description = onDemand ?? AGY_ALWAYS_ON[rule];
  if (!description) throw new Error(`guidelines/${rule}.md: in neither AGY_ON_DEMAND nor AGY_ALWAYS_ON`);
  const trigger = onDemand ? "model_decision" : "always_on";
  return `---\ntrigger: ${trigger}\ndescription: ${quoted(description)}\n---\n\n${readSource("guidelines", `${rule}.md`)}`;
}

function splitFrontmatter(text, file) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file}: no YAML frontmatter between --- lines`);
  return { frontmatter: match[1], body: match[2] };
}

function readScalar(frontmatter, key) {
  return new RegExp(`^${key}:[ \\t]*(.+)$`, "m").exec(frontmatter)?.[1].trim();
}

function quoted(text) {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function kiroTags(toolList, file) {
  const tags = [];
  for (const tool of toolList.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    if (!(tool in KIRO_TOOL_TAGS)) throw new Error(`${file}: no Kiro tag for tool ${tool}; add it to KIRO_TOOL_TAGS`);
    const tag = KIRO_TOOL_TAGS[tool];
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

function kiroAgent(agent) {
  const file = `agents/${agent}.md`;
  const { frontmatter, body } = splitFrontmatter(readSource(file), file);
  const toolList = readScalar(frontmatter, "tools");
  if (!KIRO_LABELS[agent]) throw new Error(`${file}: no Kiro label; add one to KIRO_LABELS`);
  // An agent with no tools: line inherits every tool, so its Kiro form gets every tag.
  const tags = (toolList ? kiroTags(toolList, file) : KIRO_ALL_TAGS).map(quoted).join(", ");
  return `---\nname: ${agent}\ndescription: ${quoted(KIRO_LABELS[agent])}\ntools: [${tags}]\n---\n${body}`;
}

function agyTools(toolList, file) {
  const tools = [];
  for (const tool of toolList.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    if (!(tool in AGY_TOOLS)) throw new Error(`${file}: no agy tool for ${tool}; add it to AGY_TOOLS`);
    const id = AGY_TOOLS[tool];
    if (id && !tools.includes(id)) tools.push(id);
  }
  if (tools.length === 0) throw new Error(`${file}: tools: maps to no agy tool`);
  return tools;
}

// agy's skills: takes skill paths, and which folder they start from is untested, so Claude Code's
// preload is dropped; inherit is the only model tier the two share.
function agyAgent(agent) {
  const file = `agents/${agent}.md`;
  const { frontmatter, body } = splitFrontmatter(readSource(file), file);
  const description = readScalar(frontmatter, "description");
  const toolList = readScalar(frontmatter, "tools");
  if (!description) throw new Error(`${file}: no one-line description`);
  const tools = (toolList ? agyTools(toolList, file) : AGY_ALL_TOOLS).map(quoted).join(", ");
  return `---\nname: ${agent}\ndescription: ${quoted(description)}\ntools: [${tools}]\nmodel: inherit\n---\n${body}`;
}

function kiroHooks() {
  const command = (script) => `node "${KIRO_CLONE_HOOKS}/${script}"`;
  const hook = (name, trigger, script) => ({
    name,
    trigger,
    action: { type: "command", command: command(script) },
    timeout: 10,
    enabled: true,
  });
  return {
    version: "v1",
    hooks: [
      hook("prince-skills-fact-check", "Stop", "kiro-fact-check-nudge.js"),
      hook("prince-skills-fact-check-first", "UserPromptSubmit", "fact-check-first.js"),
    ],
  };
}

// agy runs a plugin's hook commands from the plugin root, so the plugin carries its own copies of
// the scripts.
const AGY_HOOK_SCRIPTS = ["agy-fact-check-nudge.js", "fact-check-nudge.js"];

function agyHooks() {
  const command = "node ./hooks/agy-fact-check-nudge.js";
  return { "prince-skills": { Stop: [{ type: "command", command, timeout: 10 }] } };
}

function agyManifest() {
  const { name, description, author, homepage, repository } = JSON.parse(readSource(".claude-plugin", "plugin.json"));
  return { $schema: "https://antigravity.google/schemas/v1/plugin.json", name, description, author, homepage, repository };
}

function listFiles(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { recursive: true })
    .filter((file) => fs.statSync(path.join(ROOT, dir, file)).isFile())
    .sort();
}

function expectedFiles() {
  const rules = listNames("guidelines", ".md");
  const agents = listNames("agents", ".md");
  const tables = [["KIRO_ON_DEMAND", KIRO_ON_DEMAND], ["AGY_ON_DEMAND", AGY_ON_DEMAND], ["AGY_ALWAYS_ON", AGY_ALWAYS_ON]];
  for (const [table, names] of tables) {
    for (const rule of Object.keys(names)) {
      if (!rules.includes(rule)) throw new Error(`${table} names ${rule}, which is not in guidelines/`);
    }
  }
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const files = new Map([
    ["hooks/hooks.json", json(pluginHooks(rules))],
    ["QWEN.md", qwenContext(rules)],
    ["kiro/hooks/prince-skills.json", json(kiroHooks())],
    ["agy/plugin.json", json(agyManifest())],
    ["agy/hooks.json", json(agyHooks())],
  ]);
  for (const rule of rules) files.set(`kiro/steering/${rule}.md`, kiroSteering(rule));
  for (const agent of agents) files.set(`kiro/agents/${agent}.md`, kiroAgent(agent));
  for (const rule of rules) files.set(`agy/rules/${rule}.md`, agyRule(rule));
  for (const agent of agents) files.set(`agy/agents/${agent}.md`, agyAgent(agent));
  for (const script of AGY_HOOK_SCRIPTS) files.set(`agy/hooks/${script}`, readSource("hooks", script));
  for (const file of listFiles("skills")) files.set(`agy/skills/${file}`, readSource("skills", file));
  return files;
}

function generatedOnDisk() {
  const found = ["hooks/hooks.json", "QWEN.md"].filter((file) => fs.existsSync(path.join(ROOT, file)));
  for (const dir of ["kiro/steering", "kiro/agents", "kiro/hooks", "agy"]) {
    if (!fs.existsSync(path.join(ROOT, dir))) continue;
    for (const file of listFiles(dir)) found.push(`${dir}/${file}`);
  }
  return found;
}

function staleFiles(expected) {
  const stale = [...expected].filter(([file, text]) => {
    const target = path.join(ROOT, file);
    return !fs.existsSync(target) || fs.readFileSync(target, "utf8") !== text;
  }).map(([file]) => file);
  const orphans = generatedOnDisk().filter((file) => !expected.has(file));
  return [...stale, ...orphans];
}

function write(expected) {
  for (const file of generatedOnDisk()) {
    if (!expected.has(file)) fs.rmSync(path.join(ROOT, file));
  }
  for (const [file, text] of expected) {
    fs.mkdirSync(path.dirname(path.join(ROOT, file)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, file), text);
  }
}

const expected = expectedFiles();
if (process.argv.includes("--check")) {
  const stale = staleFiles(expected);
  if (stale.length > 0) {
    console.error(`Out of date, run node scripts/generate.mjs:\n  ${stale.join("\n  ")}`);
    process.exit(1);
  }
} else {
  write(expected);
}
