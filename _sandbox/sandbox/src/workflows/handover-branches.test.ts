import type { RepoBase } from "@intentic/sandbox-contract";
import type { GitRunner } from "@intentic/scaffold";
import { expect, test } from "vitest";
import { resolvedBranches } from "./handover-branches.js";

/* A HANDOVER MUST NOT NAME A BRANCH IT HAS NOT RESOLVED, and every test here is one way the derived name
 * `agent/<conversation>` is false while looking perfectly well-formed.
 *
 * Stubbed rather than run against real repositories: what is being asserted is the DECISION each git answer
 * leads to, and the two answers involved are a ref line and a count. A real fixture would spend seconds
 * building trees to reproduce strings this file can simply state — and could not reproduce the throwing cases
 * at all without breaking a repo on purpose.
 */

const ROOT = "/work";

interface RepoState {
    // The branch tip, or undefined for a repo where the ref does not exist at all.
    readonly tip?: string;
    // How many commits the branch carries over the pinned base.
    readonly ahead?: number;
    // Which read blows up, for the two cases where the answer is an error rather than a value.
    readonly throws?: "ref" | "count";
}

// Answers the two reads the module makes, keyed by the directory it makes them in — which is also how the
// "root" vs nested mapping gets asserted: a lookup miss means the module computed a directory nobody set up.
const gitOf = (repos: Record<string, RepoState>): GitRunner => {
    const runner: GitRunner = (dir, args) => {
        const state = repos[dir];
        if (state === undefined) {
            throw new Error(`unexpected git in ${dir}: ${args.join(" ")}`);
        }
        if (args[0] === "for-each-ref") {
            if (state.throws === "ref") {
                throw new Error("cannot read refs");
            }
            return Promise.resolve({ stdout: state.tip ?? "", stderr: "" });
        }
        if (args[0] === "rev-list") {
            if (state.throws === "count") {
                throw new Error("unrelated histories");
            }
            return Promise.resolve({ stdout: `${state.ahead ?? 0}\n`, stderr: "" });
        }
        throw new Error(`unexpected git command: ${args.join(" ")}`);
    };
    return runner;
};

const repos = (...names: string[]): readonly RepoBase[] => names.map((repo) => ({ repo, base: `base-${repo}` }));

/* THE BUG THIS FILE EXISTS FOR. A run's composition is every repository in the workspace, so a step that
 * changed one of them used to hand the reviewer a diff command for all six. Five of those commands resolve to
 * nothing, and a reviewer running them finds nothing wrong — which it then says out loud. */
test("a repository the step never committed into is dropped from the handover", async () => {
    const git = gitOf({
        "/work": { tip: "aaa", ahead: 2 },
        "/work/site": {},
        "/work/docs": {},
    });
    const resolved = await resolvedBranches(ROOT, repos("root", "site", "docs"), "agent/abc", git);
    expect(resolved).toEqual([{ repo: "root", base: "base-root", branch: "agent/abc" }]);
});

// The ref exists — the turn landed something onto it — but it says exactly what the pinned base says. The diff
// command would run, succeed, and print nothing, which is the same false all-clear by a different route.
test("a branch level with the run's base is dropped, even though the ref resolves", async () => {
    const git = gitOf({ "/work": { tip: "aaa", ahead: 0 } });
    expect(await resolvedBranches(ROOT, repos("root"), "agent/abc", git)).toEqual([]);
});

/* THE EMPTY LIST IS A RESULT, NOT AN ABSENCE. A research step legitimately finishes with nothing committed
 * anywhere, and the brief renders `[]` as a sentence telling the reader not to go looking. Returning
 * `undefined` here would render as silence, which reads as the ordinary shared-tree case. */
test("a step that committed nothing anywhere resolves to an empty list rather than nothing", async () => {
    const git = gitOf({ "/work": {}, "/work/site": {} });
    const resolved = await resolvedBranches(ROOT, repos("root", "site"), "agent/abc", git);
    expect(resolved).toEqual([]);
});

// Nested repos are named by their root-relative directory, root by the workspace itself — the mapping every
// other part of the daemon uses. A stub that only knows the right directories proves it by not throwing.
test("repositories are read in their own checkouts, and survivors keep the given order", async () => {
    const git = gitOf({
        "/work": { tip: "aaa", ahead: 1 },
        "/work/site": {},
        "/work/packages/api": { tip: "ccc", ahead: 4 },
    });
    const resolved = await resolvedBranches(ROOT, repos("root", "site", "packages/api"), "agent/abc", git);
    expect(resolved.map(({ repo }) => repo)).toEqual(["root", "packages/api"]);
});

// A repository whose refs cannot be read is not a repository whose work can be promised.
test("a ref read that fails drops the repository rather than naming it anyway", async () => {
    const git = gitOf({ "/work": { throws: "ref" } });
    expect(await resolvedBranches(ROOT, repos("root"), "agent/abc", git)).toEqual([]);
});

/* THE ONE PLACE AN ERROR KEEPS THE BRANCH, and the asymmetry is the point. By now the ref has resolved, so the
 * branch demonstrably exists and holds commits; the only reads that fail here are histories git cannot walk
 * between, and those are exactly the changes a reviewer most needs pointed at. */
test("a count that fails keeps the branch, because the ref already proved the work is there", async () => {
    const git = gitOf({ "/work": { tip: "aaa", throws: "count" } });
    expect(await resolvedBranches(ROOT, repos("root"), "agent/abc", git)).toEqual([{ repo: "root", base: "base-root", branch: "agent/abc" }]);
});
