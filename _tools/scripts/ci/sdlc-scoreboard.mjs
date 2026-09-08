#!/usr/bin/env node
// One page for the whole chain, per day: turns and how many ended unproven, follow-ups and what they bought, held work,
// refused pushes, land verdicts, commits and the fix-shaped ones among them, and CI's green rate and wall clock. Reads
// the daemon's own records (`<history>/activity.jsonl`, `<history>/usage.jsonl`), this repository's git log, and the
// GitHub API (anonymously, or with GITHUB_TOKEN/GH_TOKEN). The numbers the three audits under docs/audits computed by
// hand, computed the same way every time, so a drift between two of them is seen the week it happens.
//   node _tools/scripts/ci/sdlc-scoreboard.mjs [--days 7] [--history /history] [--repo intentic/intentic] [--no-github] [--json]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";
import { repoRoot } from "../../constants/src/node.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const at = args.indexOf(name);
    return at === -1 ? fallback : args[at + 1];
};
const days = Number(option("--days", "7"));
const history = option("--history", HISTORY_ROOT);
const repo = option("--repo", "intentic/intentic");
const github = !args.includes("--no-github");
const asJson = args.includes("--json");
const root = repoRoot(import.meta.url);

const DAY_MS = 86_400_000;
const now = Date.now();
const since = now - days * DAY_MS;
const dayOf = (at) => new Date(at).toISOString().slice(0, 10);
// A commit subject this short is a repair typed in a hurry (`fix: lock`, `fix: ci`), the cost gates charge the owner.
const FIX_SUBJECT_CHARS = 15;
const LOCKFILE = "pnpm-lock.yaml";

const jsonl = (path) => {
    let text;
    try {
        text = readFileSync(path, "utf8");
    } catch {
        return [];
    }
    return text
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
            try {
                return [JSON.parse(line)];
            } catch {
                return [];
            }
        });
};

const activity = jsonl(join(history, "activity.jsonl")).filter((row) => typeof row.at === "number" && row.at >= since);
const usage = jsonl(join(history, "usage.jsonl")).filter((row) => typeof row.at === "number" && row.at >= since);

// Every day in the window, oldest first, so a quiet day is a row of zeros rather than a gap.
const dayKeys = Array.from({ length: days }, (_, index) => dayOf(now - (days - 1 - index) * DAY_MS));
const blank = () => ({
    turns: 0,
    editingTurns: 0,
    unproven: 0,
    continued: 0,
    followUps: 0,
    followUpsActed: 0,
    held: 0,
    pushesRefused: 0,
    landGreen: 0,
    landRed: 0,
    installsFailed: 0,
    commits: 0,
    fixCommits: 0,
    lockfileOnly: 0,
    ciRuns: 0,
    ciGreen: 0,
    ciRed: 0,
    ciCancelled: 0,
    ciMinutes: [],
});
const rows = new Map(dayKeys.map((day) => [day, blank()]));
const at = (day) => rows.get(day);

for (const turn of usage) {
    const row = at(turn.day ?? dayOf(turn.at));
    if (row === undefined) {
        continue;
    }
    row.turns += 1;
    if ((turn.filesEdited ?? 0) > 0) {
        row.editingTurns += 1;
        if (turn.verification === "unproven" || turn.verification === "failing") {
            row.unproven += 1;
        }
    }
}

const ACTIVITY_COUNTERS = {
    "rule.continued_turn": "continued",
    "rule.held_work": "held",
    "rule.blocked_push": "pushesRefused",
    "git.push_refused": "pushesRefused",
    "deps.install_failed": "installsFailed",
};
for (const event of activity) {
    const row = at(dayOf(event.at));
    if (row === undefined) {
        continue;
    }
    const counter = ACTIVITY_COUNTERS[event.type];
    if (counter !== undefined) {
        row[counter] += 1;
    } else if (event.type === "deps.verify_green" || event.type === "deps.verify_red") {
        // Only the repository's own verdicts: an extension's `pnpm test` is not the land's whole-tree check.
        if (/for intentic\b/.test(event.content ?? "")) {
            row[event.type === "deps.verify_green" ? "landGreen" : "landRed"] += 1;
        }
    } else if (event.type === "rule.followup_outcome") {
        row.followUps += 1;
        const outcome = event.extra ?? {};
        if ((outcome.edits ?? 0) > 0 || (outcome.looks ?? 0) > 0 || (outcome.commands ?? 0) > 0) {
            row.followUpsActed += 1;
        }
    }
}

// One log call: each commit as `<day>\t<subject>` followed by the paths it touched, blank line between commits.
const log = execFileSync("git", ["log", `--since=${days} days ago`, "--format=%x01%ad%x09%s", "--date=format:%Y-%m-%d", "--name-only"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
});
for (const block of log.split("\x01").filter((entry) => entry.trim() !== "")) {
    const [head, ...pathLines] = block.split("\n");
    const [day, subject = ""] = head.split("\t");
    const row = at(day);
    if (row === undefined) {
        continue;
    }
    row.commits += 1;
    if (subject.length <= FIX_SUBJECT_CHARS) {
        row.fixCommits += 1;
    }
    const paths = pathLines.filter((line) => line.trim() !== "");
    if (paths.length === 1 && paths[0] === LOCKFILE) {
        row.lockfileOnly += 1;
    }
}

let ciNote = "";
if (github) {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    try {
        const response = await fetch(`https://api.github.com/repos/${repo}/actions/runs?branch=main&event=push&per_page=100`, {
            headers: {
                accept: "application/vnd.github+json",
                "user-agent": "intentic-sdlc-scoreboard",
                ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
            },
        });
        if (!response.ok) {
            throw new Error(`${response.status} ${(await response.text()).slice(0, 120)}`);
        }
        const { workflow_runs: runs } = await response.json();
        for (const run of runs.filter((candidate) => candidate.name === "CI")) {
            const row = at(run.created_at.slice(0, 10));
            if (row === undefined) {
                continue;
            }
            row.ciRuns += 1;
            if (run.conclusion === "success") {
                row.ciGreen += 1;
            } else if (run.conclusion === "failure") {
                row.ciRed += 1;
            } else if (run.conclusion === "cancelled") {
                row.ciCancelled += 1;
            }
            if (run.status === "completed" && run.conclusion !== "cancelled") {
                row.ciMinutes.push((new Date(run.updated_at) - new Date(run.run_started_at ?? run.created_at)) / 60_000);
            }
        }
        // The list endpoint pages at 100 runs; a busy week past that is under-counted at its oldest edge.
        if (runs.length === 100) {
            ciNote = "CI columns read the newest 100 runs on main, so the oldest day may be short.";
        }
    } catch (error) {
        ciNote = `CI columns unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
}

const median = (values) => {
    if (values.length === 0) {
        return undefined;
    }
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
};
const total = blank();
for (const row of rows.values()) {
    for (const key of Object.keys(total)) {
        if (key === "ciMinutes") {
            total.ciMinutes.push(...row.ciMinutes);
        } else {
            total[key] += row[key];
        }
    }
}

const shape = (day, row) => ({
    day,
    turns: row.turns,
    unproven: `${row.unproven}/${row.editingTurns}`,
    continued: row.continued,
    followUpsActed: row.followUps === 0 ? "-" : `${row.followUpsActed}/${row.followUps}`,
    held: row.held,
    pushesRefused: row.pushesRefused,
    land: `${row.landGreen}/${row.landRed}`,
    installsFailed: row.installsFailed,
    commits: row.commits,
    fixCommits: row.fixCommits,
    lockfileOnly: row.lockfileOnly,
    ci: github ? `${row.ciGreen}/${row.ciRed}/${row.ciCancelled}` : "-",
    ciWall: github && row.ciMinutes.length > 0 ? `${Math.round(median(row.ciMinutes))}m` : "-",
});
const table = [...[...rows.entries()].map(([day, row]) => shape(day, row)), shape("total", total)];

if (asJson) {
    console.log(JSON.stringify({ since: new Date(since).toISOString(), days, rows: table, note: ciNote }, null, 2));
    process.exit(0);
}

console.log(`## The chain, per day: last ${days} days to ${new Date(now).toISOString().slice(0, 16)}Z`);
console.log("");
console.log("| day | turns | unproven/editing | continued | follow-ups acted on | held | pushes refused | land green/red | installs failed | commits | fix-shaped | lockfile-only | CI green/red/cancelled | CI wall p50 |");
console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const row of table) {
    console.log(
        `| ${row.day} | ${row.turns} | ${row.unproven} | ${row.continued} | ${row.followUpsActed} | ${row.held} | ${row.pushesRefused} | ${row.land} | ` +
            `${row.installsFailed} | ${row.commits} | ${row.fixCommits} | ${row.lockfileOnly} | ${row.ci} | ${row.ciWall} |`,
    );
}
console.log("");
console.log(
    [
        "unproven: turns that edited code and ended with nothing having checked it, over turns that edited at all.",
        "continued: turn.ending rules that sent a turn back; follow-ups acted on: those answered with an edit, a look or a command, where the outcome was recorded.",
        `pushes refused: the app's push check and the git hook together. land: whole-repository \`pnpm verify\` verdicts after a land. fix-shaped: subjects of ${FIX_SUBJECT_CHARS} characters or fewer.`,
        ...(ciNote === "" ? [] : [ciNote]),
    ].join("\n"),
);
