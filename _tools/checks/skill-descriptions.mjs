#!/usr/bin/env node
/* EVERY SKILL DESCRIPTION FITS THE CATALOG BUDGET, because the description is the one part of a skill that is
 * paid for whether or not the skill is used.
 *
 * The harness lists every loaded skill's name and description in the system prompt of every call of every
 * session; the body is read only when the skill is invoked. Measured 2026-09-06 over this workspace: 45 skill
 * files, 14,253 description characters (~3.6k tokens) on every call, re-read some 200 times a session, and the
 * longest single line spent 836 characters spelling out sixteen e-mail addresses that the skill's own roster
 * carried anyway (docs/token-efficiency-plan.md §2.4). A description is a TRIGGER: what the skill is for and
 * the words a request arrives in. Everything else belongs in the body, which costs nothing until it is opened.
 *
 * 320 characters (~80 tokens) is the ceiling this repository's own longest well-formed triggers fit under once
 * their restatements were cut; a description that needs more is carrying body text. Generated descriptions
 * (the identities roster, a platform skill's connected accounts) are budgeted at render time instead
 * (browser/browser-skill.ts rosterSummary), since their length is data this check cannot see. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root, trackedFiles } from "./lib/repo.mjs";

const BUDGET = 320;
const SKILL_FILE = /(^|\/)skills\/[^/]+\/SKILL\.md$/;

// The frontmatter's `description`, folded onto one line: the plain `key: value` form every skill here uses, plus
// YAML's `>`/`|` block forms and indented continuation lines, so a wrapped description is measured whole.
const descriptionOf = (text) => {
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text);
    if (frontmatter === null) {
        return undefined;
    }
    const lines = frontmatter[1].split("\n");
    const at = lines.findIndex((line) => line.startsWith("description:"));
    if (at === -1) {
        return undefined;
    }
    let value = lines[at].slice("description:".length).trim();
    for (let index = at + 1; index < lines.length && /^\s/.test(lines[index]); index += 1) {
        value = `${value} ${lines[index].trim()}`;
    }
    return value.replace(/^[>|][-+]?\s*/, "").trim();
};

const skills = trackedFiles().filter((path) => SKILL_FILE.test(path));
const findings = [];
for (const path of skills) {
    const description = descriptionOf(readFileSync(join(root, path), "utf8"));
    if (description !== undefined && description.length > BUDGET) {
        findings.push({ path, length: description.length });
    }
}

if (findings.length > 0) {
    for (const { path, length } of findings.sort((a, b) => b.length - a.length)) {
        console.error(
            `${path}  description is ${length} characters, budget ${BUDGET}: keep the trigger (what for, which words), move the rest into the body`,
        );
    }
    console.error(`\n${findings.length} skill description(s) over budget. Every call of every session pays for each of them.`);
    process.exit(1);
}

console.log(`${skills.length} skill files, every description within ${BUDGET} characters`);
