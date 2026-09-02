#!/usr/bin/env node
/* WHICH GATE TO BUILD NEXT: the failing steps of the last N completed runs on a branch, grouped and counted.
 *
 *   node _tools/scripts/ci-audit.mjs [--repo intentic/intentic] [--branch main] [--runs 100] [--logs] [--json]
 *
 * docs/ci-failure-audit.md was written from exactly this extraction, done by hand: runs → jobs → the failed step
 * of each failed job → a signature, tallied. It produced the rule every gate in this repo now follows ("a defect
 * class visible to the 60-minute job gets a detector in the seconds-long one") and, run again a fortnight later,
 * showed the push gate of the day was measuring the wrong thing. Both were two-week retrospectives; this makes
 * the same table a nightly job summary (.github/workflows/nightly.yml), so the next gate is argued from numbers
 * that are a day old rather than reconstructed.
 *
 * WHAT IT SAYS. One row per `workflow :: job :: failed step`, with how many runs died there and which. Steps that
 * belong to the runner rather than the code (`Set up job`, `Initialize containers`, `Set up runner`) are marked
 * infra, because a week of those is a fleet problem and not a gate to build. With `--logs`, each failed job's log
 * is read for its first error line (`error TS…`, a failing test's `FAIL`, an `Error:`), which is what tells a
 * type-error week from a formatting week inside the same step name.
 *
 * Reads the GitHub API with `GITHUB_TOKEN` (or `GH_TOKEN`) when one is set and anonymously otherwise, which is
 * enough for a public repository at this volume. Markdown to stdout, so `>> "$GITHUB_STEP_SUMMARY"` is the whole
 * integration; `--json` for anything that wants to compute over it. */

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const at = args.indexOf(name);
    return at === -1 ? fallback : args[at + 1];
};
const repo = option("--repo", "intentic/intentic");
const branch = option("--branch", "main");
const wanted = Number(option("--runs", "100"));
const logs = args.includes("--logs");
const asJson = args.includes("--json");
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

const INFRA_STEP = /^(Set up job|Set up runner|Initialize containers|Stop containers|Complete job|Post .*)$/;
const ERROR_LINE = /error TS\d+|\bFAIL\b|✗|✘|Error:|error\[E\d+\]|rustfmt|Diff in|ERR_PNPM|exit code \d+/;
const LOG_LINES = 3_000;

const api = async (path, init = {}) => {
    const response = await fetch(`https://api.github.com${path}`, {
        ...init,
        headers: {
            accept: "application/vnd.github+json",
            "user-agent": "intentic-ci-audit",
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
            ...init.headers,
        },
    });
    if (!response.ok) {
        throw new Error(`${path}: ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
    return response;
};
const json = async (path) => (await api(path)).json();

// Completed runs on the branch, newest first, across every workflow, up to the count asked for.
const completedRuns = async () => {
    const runs = [];
    for (let page = 1; runs.length < wanted; page += 1) {
        const batch = await json(`/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=100&page=${page}`);
        runs.push(...batch.workflow_runs);
        if (batch.workflow_runs.length < 100) {
            break;
        }
    }
    return runs.slice(0, wanted);
};

// The failed steps of one failed run, as `{ job, step, infra }`, plus the first error line of each job's log.
const failedSteps = async (run) => {
    const { jobs } = await json(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
    const found = [];
    for (const job of jobs.filter((one) => one.conclusion === "failure")) {
        const step = job.steps.find((one) => one.conclusion === "failure")?.name ?? "(no failed step: the job itself)";
        let signature;
        if (logs) {
            try {
                const text = await (await api(`/repos/${repo}/actions/jobs/${job.id}/logs`)).text();
                signature = text
                    .split("\n")
                    .slice(0, LOG_LINES)
                    .map((line) => line.replace(/^\S+\s/, "").replace(/\u001b\[[0-9;]*m/g, ""))
                    .find((line) => ERROR_LINE.test(line))
                    ?.trim()
                    .slice(0, 160);
            } catch {
                // Expired logs (older than the retention window) read as no signature, not as a failure of this.
            }
        }
        found.push({ job: job.name, step, infra: INFRA_STEP.test(step), signature });
    }
    return found;
};

const runs = await completedRuns();
const failed = runs.filter((run) => run.conclusion === "failure");
const rows = new Map();
for (const run of failed) {
    for (const found of await failedSteps(run)) {
        const key = `${run.name} :: ${found.job} :: ${found.step}`;
        const row = rows.get(key) ?? { key, infra: found.infra, runs: [], signatures: new Map() };
        row.runs.push(run.head_sha.slice(0, 9));
        if (found.signature !== undefined) {
            row.signatures.set(found.signature, (row.signatures.get(found.signature) ?? 0) + 1);
        }
        rows.set(key, row);
    }
}
const table = [...rows.values()].sort((a, b) => b.runs.length - a.runs.length);
const tally = (conclusion) => runs.filter((run) => run.conclusion === conclusion).length;

if (asJson) {
    console.log(
        JSON.stringify(
            {
                repo,
                branch,
                runs: runs.length,
                failed: failed.length,
                success: tally("success"),
                cancelled: tally("cancelled"),
                steps: table.map((row) => ({ ...row, signatures: [...row.signatures] })),
            },
            null,
            2,
        ),
    );
    process.exit(0);
}

console.log(`## CI failures on \`${branch}\`: last ${runs.length} completed runs`);
console.log("");
console.log(
    `${failed.length} failed, ${tally("success")} succeeded, ${tally("cancelled")} cancelled.${failed.length === 0 ? " Nothing to build." : ""}`,
);
if (table.length > 0) {
    console.log("");
    console.log("| runs | workflow :: job :: step | kind | seen in |");
    console.log("|---:|---|---|---|");
    for (const row of table) {
        console.log(
            `| ${row.runs.length} | ${row.key} | ${row.infra ? "infra" : "code"} | ${row.runs.slice(0, 6).join(", ")}${row.runs.length > 6 ? ", …" : ""} |`,
        );
    }
    if (logs) {
        console.log("");
        console.log("First error line per step, where the log still exists:");
        console.log("");
        for (const row of table.filter((one) => one.signatures.size > 0)) {
            console.log(`- **${row.key}**`);
            for (const [signature, count] of [...row.signatures].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
                console.log(`  - ${count}× \`${signature.replace(/`/g, "'")}\``);
            }
        }
    }
}
console.log("");
console.log(
    `The rule (docs/ci-failure-audit.md): a class visible to the 60-minute job gets a detector in the seconds-long one. ` +
        `The top code row is the next gate; an infra row is the fleet's.`,
);
