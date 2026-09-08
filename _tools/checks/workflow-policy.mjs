#!/usr/bin/env node
// Repository-specific workflow policy no external linter encodes (actionlint checks validity, zizmor checks safety);
// read by shape, not a list, so a new job is held to it for free.
// 1. the fork boundary: self-hosted, non-ephemeral runners share a cache and the host docker socket, so a job reachable
//    from a fork's pull request must gate on `head.repo.full_name == github.repository` (or a safe parent) — see
//    docs/ci-runner.md
// 2. a called reusable workflow can never hold a permission its caller doesn't grant; Actions fails this before any job
//    starts
// 3. a job publishing with npm provenance must run on a GitHub-hosted runner, since npm's registry accepts only that
//    builder id
// 4. no workflow triggers on `push: tags`, since semantic-release pushes tags with GITHUB_TOKEN and GitHub starts
//    nothing from that token's events; dispatch it instead (delete this rule if the release ever tags with a different
//    token)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { root } from "./lib/repo.mjs";
import { jobsOf, permissionsOf, stepsOf, workflowFiles, workflowText } from "./lib/workflows.mjs";

// The fork boundary.
const GUARD = "head.repo.full_name == github.repository";
const PUSH_ONLY = "github.event_name == 'push'";

const exposed = [];
for (const file of workflowFiles()) {
    const text = workflowText(file);
    // Only workflows a fork can trigger; `workflow_call`/schedule/dispatch carry no fork's code.
    if (!/^ {2}pull_request:\s*$/m.test(text)) {
        continue;
    }
    const jobs = jobsOf(text);
    const safe = new Set();
    for (let pass = 0; pass <= jobs.size; pass++) {
        for (const job of jobs.values()) {
            if (safe.has(job.name) || job.if.includes(GUARD) || job.if.includes(PUSH_ONLY)) {
                safe.add(job.name);
                continue;
            }
            const parents = job.needs.filter((name) => safe.has(name));
            if (parents.length > 0 && (!/always\(\)|!\s*cancelled\(\)/.test(job.if) || parents.some((name) => job.if.includes(`needs.${name}.`)))) {
                safe.add(job.name);
            }
        }
    }
    for (const job of jobs.values()) {
        if (!safe.has(job.name) && (/self-hosted/.test(job.runsOn) || job.uses !== "")) {
            exposed.push(
                `.github/workflows/${file}: job \`${job.name}\` runs a fork's pull request on the self-hosted fleet, ` +
                    `give it \`if: github.event_name != 'pull_request' || github.event.pull_request.${GUARD}\`, or a ` +
                    `\`needs\` edge to a job that has one`,
            );
        }
    }
}

// The permission ceiling.
const RANK = { none: 0, read: 1, write: 2 };

// The scopes a called workflow asks for beyond what its caller hands it, as [scope, asked, held].
const beyondGrant = (wanted, granted) => {
    const over = [];
    for (const [scope, level] of Object.entries(wanted)) {
        const held = granted[scope] ?? "none";
        if ((RANK[level] ?? 0) > (RANK[held] ?? 0)) {
            over.push([scope, level, held]);
        }
    }
    return over;
};

const overreach = [];
for (const file of workflowFiles()) {
    const text = workflowText(file);
    const callerBlocks = permissionsOf(text);
    for (const job of jobsOf(text).values()) {
        const call = job.uses.match(/^\.\/(\.github\/workflows\/[\w.-]+\.yml)$/);
        const granted = callerBlocks.get(job.name) ?? callerBlocks.get("");
        if (!call || !granted) {
            continue;
        }
        const calledText = readFileSync(join(root, call[1]), "utf8");
        const calledBlocks = permissionsOf(calledText);
        for (const called of jobsOf(calledText).values()) {
            const wanted = calledBlocks.get(called.name) ?? calledBlocks.get("") ?? {};
            for (const [scope, level, held] of beyondGrant(wanted, granted)) {
                overreach.push(
                    `${call[1]}: job \`${called.name}\` asks for \`${scope}: ${level}\`, but .github/workflows/${file} job ` +
                        `\`${job.name}\` grants it \`${scope}: ${held}\`, add \`${scope}: ${level}\` to that call's \`permissions\``,
                );
            }
        }
    }
}

// Provenance on the fleet.
const PROVENANCE = /npm publish[^\n]*--provenance/;

const unattestable = [];
for (const file of workflowFiles()) {
    const text = workflowText(file);
    const steps = stepsOf(text);
    for (const job of jobsOf(text).values()) {
        if (!/self-hosted/.test(job.runsOn)) {
            continue;
        }
        const block = steps.get(job.name) ?? "";
        // A step rarely spells the publish itself; it names a script, and the script spells the flag. Shell only, since
        // every publish here is a `.sh`.
        const scripts = [...block.matchAll(/_tools\/scripts\/[\w.-]+\.sh/g)].map(([path]) => path);
        const spelled = [block, ...scripts.filter((path) => existsSync(join(root, path))).map((path) => readFileSync(join(root, path), "utf8"))];
        if (spelled.some((where) => PROVENANCE.test(where))) {
            unattestable.push(
                `.github/workflows/${file}: job \`${job.name}\` publishes with provenance on the self-hosted fleet, npm's ` +
                    `registry rejects an attestation whose builder id is not "github-hosted", with a 422 the release only ` +
                    `reaches after the tarball is packed and signed; run this job on \`ubuntu-24.04\``,
            );
        }
    }
}

// The tag push that never arrives.
const tagTriggered = [];
for (const file of workflowFiles()) {
    const lines = workflowText(file).split("\n");
    const on = lines.findIndex((line) => /^on:\s*$/.test(line));
    if (on === -1) {
        continue;
    }
    // From `on:` to the next unindented line; a column-0 comment sits between blocks, never inside one.
    let inPush = false;
    for (let i = on + 1; i < lines.length && !/^\S/.test(lines[i]); i++) {
        if (/^ {2}\S/.test(lines[i])) {
            inPush = /^ {2}push:\s*$/.test(lines[i]);
        } else if (inPush && /^ {4}tags:/.test(lines[i])) {
            tagTriggered.push(
                `.github/workflows/${file}: \`on: push: tags\` is a trigger this repository can never fire, semantic-release ` +
                    `pushes its tags with GITHUB_TOKEN, and GitHub starts no workflow from that token's events. Use ` +
                    `\`on: workflow_dispatch\` and add this file to WORKFLOWS in _tools/scripts/release/dispatch-publish.sh, which ` +
                    `dispatches it AT THE TAG so the checkout and \`GITHUB_REF_NAME\` are what a tag push would have given it`,
            );
        }
    }
}

finish(
    [
        ["Self-hosted CI is reachable from a fork's pull request (docs/ci-runner.md, 'The fork boundary')", exposed],
        ["A called workflow asks for more than its caller grants: Actions fails this before any job starts", overreach],
        ["A publish with provenance is on a runner npm's registry will not attest", unattestable],
        ["A workflow is triggered by a tag push GitHub will never deliver (dispatch it instead)", tagTriggered],
    ],
    [
        "fork boundary: no self-hosted job is reachable from a fork's pull request",
        "workflow permissions: every reusable-workflow call grants what the workflow it calls asks for",
        "npm provenance: no job publishes an attested tarball from the self-hosted fleet",
        "publish triggers: no workflow waits on a tag push GITHUB_TOKEN can never deliver",
    ],
);
