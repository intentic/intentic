#!/usr/bin/env node
// release-flush.yml, hourly: when main's head verified green but its release was held for the release interval
// (release-hold.mjs), and the interval is now over with no push since, dispatch CI at main the way the `autofix` job
// does, so that run plans the held release. Without it the last commits of an evening waited for the next push: main
// went 3+ hours without one 62 times over 2026-10-16..11-23.
//
// It acts on evidence alone and does nothing when unsure: no CI run for the head, one still going, a run whose release
// was not planned (a gate failed), one that held nothing, or a hold not yet over. A dispatched run is itself the newest
// run for the head, so the next pass waits on it, and one that fails is not retried: a person or the next push takes it.
//
// GITHUB_TOKEN (actions: write, checks: read), GITHUB_REPOSITORY and GITHUB_API_URL come from the workflow. `--dry-run`
// says what it would do and dispatches nothing.
import { heldUntil } from "./release-hold.mjs";

const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, GITHUB_API_URL: api = `https://api.github.com` } = process.env;
const dryRun = process.argv.includes(`--dry-run`);
const say = (line) => console.log(`release-flush: ${line}`);

if (!token || !repo) {
    say(`needs GITHUB_TOKEN and GITHUB_REPOSITORY`);
    process.exit(2);
}

const gh = async (path, init = {}) => {
    const response = await fetch(`${api}/repos/${repo}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, Accept: `application/vnd.github+json`, ...init.headers },
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        throw new Error(`${init.method ?? `GET`} ${path}: ${String(response.status)} ${await response.text()}`);
    }
    return response.status === 204 ? undefined : response.json();
};

const head = await gh(`/commits/main`);
const runs = (await gh(`/actions/workflows/ci.yml/runs?branch=main&head_sha=${head.sha}&per_page=20`)).workflow_runs;
if (runs.length === 0) {
    say(`no CI run for main's head ${head.sha.slice(0, 9)} yet, so nothing to flush`);
    process.exit(0);
}
if (runs.some((run) => run.status !== `completed`)) {
    say(`a CI run for main's head ${head.sha.slice(0, 9)} is still going, and it decides the release`);
    process.exit(0);
}
const latest = runs.toSorted((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
const jobs = [];
for (let page = 1; page <= 3; page += 1) {
    const batch = (await gh(`/actions/runs/${String(latest.id)}/jobs?filter=latest&per_page=100&page=${String(page)}`)).jobs;
    jobs.push(...batch);
    if (batch.length < 100) {
        break;
    }
}
const plan = jobs.find((job) => job.name === `release / plan`);
if (plan?.conclusion !== `success`) {
    say(`run ${String(latest.id)} planned no release for ${head.sha.slice(0, 9)} (a gate in front of it did not pass), so nothing to flush`);
    process.exit(0);
}
const notes = await gh(`/check-runs/${String(plan.id)}/annotations?per_page=100`);
const held = notes.find((note) => note.title === `Release held`);
const until = heldUntil(held?.message);
if (until === undefined) {
    say(`run ${String(latest.id)} held no release back, so nothing to flush`);
    process.exit(0);
}
if (Date.now() < until) {
    say(`the release held at ${head.sha.slice(0, 9)} waits until ${new Date(until).toISOString()}`);
    process.exit(0);
}
const before = head.parents[0]?.sha ?? ``;
say(`${held.message.split(` waits`)[0]} was held at ${head.sha.slice(0, 9)} and its interval is over: dispatching CI at main from ${before.slice(0, 9)}`);
if (!dryRun) {
    await gh(`/actions/workflows/ci.yml/dispatches`, { method: `POST`, body: JSON.stringify({ ref: `main`, inputs: { before } }) });
}
