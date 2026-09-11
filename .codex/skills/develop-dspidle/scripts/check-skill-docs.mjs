#!/usr/bin/env node
// Lightweight Skill/instruction checker. No extra dependencies, no network,
// no production access. Exit 0 only when structure, relative links and
// A-class authorization boundaries hold for the files this task owns.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const skillRoot = path.join(repoRoot, ".codex", "skills", "develop-dspidle");
const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function read(rel) {
  const abs = path.join(repoRoot, rel);
  if (!existsSync(abs)) {
    fail(`missing file: ${rel}`);
    return "";
  }
  return readFileSync(abs, "utf8");
}

function existsRel(rel) {
  return existsSync(path.join(repoRoot, rel));
}

const required = [
  "AGENTS.md",
  ".agents/skills/develop-dspidle/SKILL.md",
  ".codex/skills/develop-dspidle/SKILL.md",
  ".codex/skills/develop-dspidle/agents/openai.yaml",
  ".codex/skills/develop-dspidle/references/agent-roles.md",
  ".codex/skills/develop-dspidle/references/project-map.md",
  ".codex/skills/develop-dspidle/references/testing.md",
  ".codex/skills/develop-dspidle/references/deployment.md",
  ".codex/skills/develop-dspidle/references/protected-release-access.md",
  "docs/feedback/skill-v2-permission-proposals.md",
];

for (const rel of required) {
  if (!existsRel(rel)) fail(`required path missing: ${rel}`);
}

const skill = read(".codex/skills/develop-dspidle/SKILL.md");
if (!/^---\r?\nname:\s*develop-dspidle\r?\n/m.test(skill)) {
  fail("canonical SKILL.md must keep frontmatter name develop-dspidle");
}

const pointer = read(".agents/skills/develop-dspidle/SKILL.md");
if (!pointer.includes(".codex/skills/develop-dspidle/SKILL.md")) {
  fail("discovery pointer must send readers to the canonical Skill body");
}
if (/Role:\s*develop[\s\S]{0,80}handoff/.test(pointer) && pointer.length > 1200) {
  fail("discovery pointer looks like a second rule set");
}

const agents = read("AGENTS.md");
if (!agents.includes(".codex/skills/develop-dspidle/SKILL.md")) {
  fail("AGENTS.md must route to the canonical Skill");
}
if (!agents.includes("未验证自动加载")) {
  fail("AGENTS.md must state that Grok auto-load of .codex/skills is unverified");
}

const yaml = read(".codex/skills/develop-dspidle/agents/openai.yaml");
if (/Role:\s*(feedback|develop|release)/.test(yaml)) {
  fail("agents/openai.yaml must not repeat the role contract");
}
if (!yaml.includes(".codex/skills/develop-dspidle/SKILL.md")) {
  fail("agents/openai.yaml must point at the canonical Skill");
}

const effective = [
  ["AGENTS.md", agents],
  ["SKILL.md", skill],
  ["agent-roles.md", read(".codex/skills/develop-dspidle/references/agent-roles.md")],
  ["testing.md", read(".codex/skills/develop-dspidle/references/testing.md")],
  ["deployment.md", read(".codex/skills/develop-dspidle/references/deployment.md")],
  ["protected-release-access.md", read(".codex/skills/develop-dspidle/references/protected-release-access.md")],
  ["project-map.md", read(".codex/skills/develop-dspidle/references/project-map.md")],
];

const bannedEffective = [
  [/same conversation may switch from feedback to develop/i, "AUTH-01 must not be effective"],
  [/silently switch roles mid-task is allowed/i, "role switching must not be self-authorized"],
  [/default commit authorization/i, "AUTH-02 must not be effective"],
  [/reviewer may write diagnostic artifacts without approval/i, "AUTH-03 must not be effective"],
];

for (const [label, text] of effective) {
  if (!text) continue;
  for (const [pattern, reason] of bannedEffective) {
    if (pattern.test(text)) fail(`${label}: ${reason}`);
  }
}

const roles = effective.find(([label]) => label === "agent-roles.md")?.[1] ?? "";
if (/use `apply_patch` for manual edits/i.test(roles)) {
  fail("agent-roles.md still hard-binds apply_patch");
}
if (/add migrations, fixtures, and deterministic tests for any state or simulation change/i.test(roles)) {
  fail("agent-roles.md still requires migrations for every simulation change");
}

const testing = effective.find(([label]) => label === "testing.md")?.[1] ?? "";
if (!/test:changed/.test(testing) || !/不等于功能验证通过/.test(testing)) {
  fail("testing.md must describe test:changed empty-run limitation");
}
if (!/test:quick/.test(testing) || !/不含/.test(testing)) {
  fail("testing.md must say test:quick does not run game Vitest or Cargo");
}

const protectedRef = effective.find(([label]) => label === "protected-release-access.md")?.[1] ?? "";
if (!/-Capability Android/.test(protectedRef) || !/-Capability HongKong/.test(protectedRef)) {
  fail("protected-release-access.md must show target-specific -Capability examples");
}

const deployment = effective.find(([label]) => label === "deployment.md")?.[1] ?? "";
if (/Current disk usage is approximately/.test(deployment) || /Hong Kong and Shanghai Web\/API run `1\.0\.38/.test(deployment)) {
  fail("deployment.md still copies a stale current production baseline");
}

const markdownFiles = [
  "AGENTS.md",
  ".agents/skills/develop-dspidle/SKILL.md",
  ".codex/skills/develop-dspidle/SKILL.md",
  ".codex/skills/develop-dspidle/references/agent-roles.md",
  ".codex/skills/develop-dspidle/references/project-map.md",
  ".codex/skills/develop-dspidle/references/testing.md",
  ".codex/skills/develop-dspidle/references/deployment.md",
  ".codex/skills/develop-dspidle/references/protected-release-access.md",
  "docs/feedback/skill-v2-permission-proposals.md",
  "docs/feedback/skill-v2-refactor-report.md",
];

const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
for (const rel of markdownFiles) {
  const text = read(rel);
  if (!text) continue;
  const dir = path.dirname(path.join(repoRoot, rel));
  let match;
  while ((match = linkPattern.exec(text))) {
    let target = match[1].trim();
    if (!target || target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:")) continue;
    if (target.startsWith("#")) continue;
    target = target.replace(/\\ /g, " ");
    const hash = target.indexOf("#");
    if (hash >= 0) target = target.slice(0, hash);
    if (!target) continue;
    const candidates = [
      path.resolve(dir, target),
      path.resolve(repoRoot, target),
      path.resolve(skillRoot, target),
    ];
    if (!candidates.some((candidate) => existsSync(candidate))) {
      fail(`broken link in ${rel}: ${match[1]}`);
    }
  }
}

if (existsRel("native/Cargo.toml")) {
  notes.push("native/Cargo.toml is present in this worktree; project-map Rust section should be used as live routing.");
} else {
  notes.push("native/Cargo.toml is absent in this worktree; project-map correctly treats JS engine as simulation authority.");
}

if (!existsRel("package.json")) fail("package.json missing");
const pkg = JSON.parse(read("package.json") || "{}");
if (pkg.scripts?.["test:changed"] !== "node scripts/run-changed-tests.mjs") {
  fail("package.json test:changed does not match documented runner");
}
if (!String(pkg.scripts?.["test:quick"] ?? "").includes("test:server")) {
  fail("package.json test:quick no longer matches testing.md");
}

console.log(`Skill docs check: ${path.relative(process.cwd(), repoRoot) || "."}`);
for (const note of notes) console.log(`note: ${note}`);
if (failures.length) {
  for (const item of failures) console.error(`FAIL: ${item}`);
  process.exit(1);
}
console.log("OK");
