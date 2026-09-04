#!/usr/bin/env node
/* THE REPOSITORY'S OWN RULES ABOUT ITS WORKFLOWS, the ones no external linter encodes. actionlint says a
 * workflow is valid and zizmor says it is safe (lint-workflows.sh); what stays here is policy about THIS fleet
 * and THIS release, read by shape rather than listed, so a job added tomorrow is held to it for free.
 *
 * 1. THE FORK BOUNDARY. This repository is public and CI runs on runners that are not ephemeral, share one
 *    /ci-cache with `release`, and mount the host docker socket. A pull request from a fork therefore had a path
 *    to host root and, through a poisoned cache entry, into a published artifact. The boundary is that the fleet
 *    builds only branches pushed to this repository, and it takes BOTH this guard and the repo's
 *    approval-for-all-outside-contributors setting (docs/ci-runner.md). The safe set is grown to a fixpoint from
 *    the jobs that guard themselves: a skipped dependency skips its dependents, and `always()`/`!cancelled()`
 *    are the two ways to opt out of that, so a job using either has to read a safe parent's result or output.
 *
 * 2. A CALLED WORKFLOW STAYS INSIDE ITS CALLER'S CEILING. A reusable workflow can never hold more than the
 *    calling job grants, and Actions decides that BEFORE the run starts: a job in the callee naming a
 *    permission the caller's list omits is an invalid-workflow error, a `startup_failure` with no job, no log,
 *    and a message that names neither file.
 *
 * 3. A JOB THAT PUBLISHES WITH PROVENANCE RUNS ON A GITHUB-HOSTED RUNNER. npm builds the attestation's builder
 *    id out of the runner's own environment and its registry accepts only "github-hosted". From the fleet every
 *    publish packs the tarball, signs the bundle, writes it to the public transparency log, and THEN 422s.
 *    The flag is found by following the job's steps into the repository scripts they run.
 *
 * 4. NO WORKFLOW WAITS ON A TAG PUSH IT CAN NEVER SEE. semantic-release pushes this repository's `v*` tags with
 *    the built-in GITHUB_TOKEN, and GitHub starts NO workflow from an event that token created. `on: push: tags`
 *    here is a trigger that cannot fire, and a workflow behind it is dead code that reads exactly like a
 *    pipeline with nothing to do. WHEN TO DELETE THIS RULE: if the release ever pushes its tag with a GitHub App
 *    installation token or a PAT, the loop guard stops applying and `on: push: tags` becomes the simpler correct
 *    answer. Delete rule 4 together with that change. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { root } from "./lib/repo.mjs";
import { jobsOf, permissionsOf, stepsOf, workflowFiles, workflowText } from "./lib/workflows.mjs";

/* ---- 1. the fork boundary ------------------------------------------------------------------------------ */
const GUARD = "head.repo.full_name == github.repository";
const PUSH_ONLY = "github.event_name == 'push'";

const exposed = [];
for (const file of workflowFiles()) {
    const text = workflowText(file);
    // Only a workflow a fork can trigger at all. A `workflow_call` target runs under its caller's guard, and a
    // schedule or a dispatch carries no fork's code.
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

/* ---- 2. the permission ceiling ------------------------------------------------------------------------- */
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

/* ---- 3. provenance on the fleet ------------------------------------------------------------------------ */
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
        // A step rarely spells the publish itself: it names a script, and the script spells the flag. One hop
        // into the shell scripts is enough for every publish path in this repository. Shell only: every publish
        // here is a `.sh`, and following the `.mjs` a job runs would make this file match itself.
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

/* ---- 4. the tag push that never arrives ---------------------------------------------------------------- */
const tagTriggered = [];
for (const file of workflowFiles()) {
    const lines = workflowText(file).split("\n");
    const on = lines.findIndex((line) => /^on:\s*$/.test(line));
    if (on === -1) {
        continue;
    }
    // From `on:` to the next line that starts a top-level key. A blank line is inside the block; anything
    // unindented ends it, comments at column 0 included: those sit between blocks here, never within one.
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
