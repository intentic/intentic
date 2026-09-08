#!/usr/bin/env node
// Every skill description costs tokens on every call whether the skill runs or not (the harness lists name and
// description for every loaded skill); the body loads only when invoked. Budgeted at 320 characters; generated
// descriptions (the identities roster, a platform skill's connected accounts) are budgeted separately, at render time.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root, trackedFiles } from "./lib/repo.mjs";

const BUDGET = 320;
const SKILL_FILE = /(^|\/)skills\/[^/]+\/SKILL\.md$/;

// Folds the frontmatter's `description` onto one line, handling YAML's `>`/`|` block form and indented continuations,
// so a wrapped description is measured whole.
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
