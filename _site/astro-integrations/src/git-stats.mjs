// @ts-check
// How much of this repo its own agents wrote, measured from git at build time (never hand-typed, since every land
// changes it), for the landing page and /about. Agent commits are identified by author email, since land.ts is the only
// path from an isolated worktree onto main; a shallow clone or missing git fails to null rather than a wrong number.
import { execSync } from "node:child_process";

const AGENT_EMAIL = "agent@intentic.dev";

/** `git` in the Astro app's directory, trimmed, or null if git has nothing to say. */
function git(args) {
    try {
        const out = execSync(`git ${args}`, {
            cwd: process.cwd(),
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return out || null;
    } catch {
        return null;
    }
}

function count(args) {
    const out = git(args);
    if (out === null) {
        return null;
    }
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
}

/**
 * @typedef {{ total: number, agent: number, share: number, since: string }} GitStats
 */

let cached;

/**
 * Commits in this repo and how many an agent authored; `share` is the rounded agent percentage, `since` is the first
 * commit's date. Null when git is unavailable or the clone is too shallow to be honest about.
 * @returns {GitStats | null}
 */
export function gitStats() {
    if (cached !== undefined) {
        return cached;
    }

    // A shallow clone answers every count truthfully about a history it does not have; refuse it.
    const shallow = git(`rev-parse --is-shallow-repository`);
    const total = shallow === `true` ? null : count(`rev-list --count HEAD`);
    const agent = total === null ? null : count(`rev-list --count --author=${AGENT_EMAIL} HEAD`);
    const since = agent === null ? null : git(`log --reverse --format=%ad --date=short --max-parents=0`);

    cached =
        total !== null && agent !== null && since !== null && total > 0 && agent > 0
            ? { total, agent, share: Math.round((agent / total) * 100), since: since.split(`\n`)[0] }
            : null;
    return cached;
}
