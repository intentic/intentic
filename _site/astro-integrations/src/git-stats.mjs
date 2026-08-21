// @ts-check
/* How much of this repository its own agents wrote, counted from git at build time.
 *
 * The site makes this claim on the landing page and on /about/, and it is the one number on the site
 * that would rot fastest if it were authored: every land adds to it. So it is measured, never typed:
 * the same rule the blueprint applies to test counts.
 *
 * Agent-landed commits are identifiable by author email: `land.ts` is the only path from an isolated
 * worktree into the main line, and it is what records attribution.
 *
 * Everything here fails to `null` rather than to a number. A shallow CI clone (`--depth 1`) would
 * otherwise report "1 of 1 commits", and a trust section that renders a wrong number, or a zero: is
 * worse than one that renders a sentence without one.
 */
import { execSync } from "node:child_process";

const AGENT_EMAIL = "agent@intentic.dev";

/** `git` in the Astro app's directory, trimmed, or null if git has nothing to say. */
function git(args) {
    try {
        const out = execSync(`git ${args}`, {
            cwd: process.cwd(),
            encoding: "utf-8",
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
 * Commits in this repository, and how many of them an agent authored.
 * `share` is the agent percentage, rounded. `since` is the first commit's date (YYYY-MM-DD).
 * Returns null when git is unavailable or the clone is too shallow to be honest about.
 * @returns {GitStats | null}
 */
export function gitStats() {
    if (cached !== undefined) {
        return cached;
    }

    // A shallow clone answers every count truthfully about a history it does not have. Refuse it.
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
