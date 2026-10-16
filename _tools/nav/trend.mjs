#!/usr/bin/env node
// The nightly nav record's two CI steps (nightly.yml, `nav-trend`):
// - previous-run: prints `run-id=<id>` for the newest earlier nightly run that kept a `nav-trend` artifact, or nothing.
// - summary <before.json> <after.json>: the before → after table as markdown, to $GITHUB_STEP_SUMMARY or stdout.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { arg } from "./lib/args.mjs";
import { compareRows, glyphOf, n, pct } from "./lib/compare.mjs";

const ARTIFACT = "nav-trend";

// GitHub answers the Actions API with a 502 now and then (ci-audit.mjs, run 36844049361), so a server error is asked
// again before it fails the step.
const RETRIES = 3;
const api = async (path) => {
    const headers = { accept: "application/vnd.github+json", "user-agent": "intentic-nav-trend" };
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (token !== undefined) {
        headers.authorization = `Bearer ${token}`;
    }
    let response;
    for (let attempt = 0; ; attempt += 1) {
        response = await fetch(`https://api.github.com${path}`, { headers });
        if (response.status < 500 || attempt >= RETRIES) {
            break;
        }
        await response.body?.cancel();
        await delay(2000 * 2 ** attempt);
    }
    if (!response.ok) {
        throw new Error(`${path}: ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
    return response.json();
};

// A nightly whose other tiers failed still kept this job's record, so a run counts when its artifact survives, whatever
// the run's own conclusion; an artifact past its retention reads as absent.
const previousRun = async () => {
    const repo = arg("repo", process.env.GITHUB_REPOSITORY ?? "intentic/intentic");
    const workflow = arg("workflow", "nightly.yml");
    const current = process.env.GITHUB_RUN_ID;
    const pages = Number(arg("pages", "4"));
    for (let page = 1; page <= pages; page += 1) {
        const { workflow_runs: runs } = await api(`/repos/${repo}/actions/workflows/${workflow}/runs?status=completed&per_page=30&page=${page}`);
        for (const run of runs) {
            if (String(run.id) === current) {
                continue;
            }
            const { artifacts } = await api(`/repos/${repo}/actions/runs/${run.id}/artifacts?name=${ARTIFACT}`);
            if (artifacts.some((artifact) => artifact.name === ARTIFACT && !artifact.expired)) {
                console.log(`run-id=${run.id}`);
                return;
            }
        }
        if (runs.length < 30) {
            return;
        }
    }
};

const markdown = (before, after) => {
    const lines = [`## nav trend`, ``];
    if (before === undefined) {
        lines.push(`No previous record: this is the first \`${ARTIFACT}\` measurement kept, so tomorrow's run has something to compare against.`);
        lines.push(``, `Measured \`${after.head}\` with tokenizer \`${after.tokenizer}\`.`);
        return lines;
    }
    if (before.tokenizer !== after.tokenizer) {
        lines.push(`Not compared: the previous record used tokenizer \`${before.tokenizer}\` and this one \`${after.tokenizer}\`.`);
        return lines;
    }
    lines.push(`\`${before.head}\` (${before.generatedAt.slice(0, 10)}) → \`${after.head}\` (${after.generatedAt.slice(0, 10)}), tokenizer \`${after.tokenizer}\`.`);
    lines.push(`✓ fell, ✗ rose, · a cost of splitting that is expected to rise.`);
    for (const { title, rows, notes } of compareRows(before, after)) {
        lines.push(``, `### ${title}`, ``, `| | Measure | Before | After | Change |`, `| --- | --- | ---: | ---: | ---: |`);
        for (const row of rows) {
            lines.push(`| ${glyphOf(row).trim()} | ${row.label} | ${n(row.before)} | ${n(row.after)} | ${pct(row.before, row.after)} |`);
        }
        for (const note of notes) {
            lines.push(``, `_${note}_`);
        }
    }
    return lines;
};

const summary = () => {
    const [, , , beforePath, afterPath] = process.argv;
    if (!beforePath || !afterPath) {
        console.error("usage: trend.mjs summary <before.json> <after.json>  (before may be missing: the first night has none)");
        process.exit(2);
    }
    const before = existsSync(beforePath) ? JSON.parse(readFileSync(beforePath, "utf8")) : undefined;
    const after = JSON.parse(readFileSync(afterPath, "utf8"));
    const text = `${markdown(before, after).join("\n")}\n`;
    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
    } else {
        process.stdout.write(text);
    }
};

const verb = process.argv[2];
const verbs = { "previous-run": previousRun, summary };
if (!verbs[verb]) {
    console.error(`unknown verb '${verb}'. one of: ${Object.keys(verbs).join(", ")}`);
    process.exit(2);
}
await verbs[verb]();
